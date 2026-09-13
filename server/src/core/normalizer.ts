/**
 * 名称归一化（《需求与设计文档》4.1 / 4.3 / 4.4 / 4.5）
 *
 * 三级策略：
 *   预处理 → ① L1 本地别名表 → ② L2 Bangumi 在线 → ③ L3 模糊匹配 → 置信度判定 → 兜底
 */
import { Candidate, DataSource, MatchLevel, Resolution } from '../types';
import { Store } from './store';
import { aliasKey, preprocess, similarity, similarityKeyed, strictKey, toSimplified } from '../util/text';
import { BangumiSubject, getSubject, searchSubjects } from '../bangumi/client';
import { WebTitleHit, looksLikeRomaji, webResolveTitlesCached } from '../websearch/client';
import { TimeHint, describeTimeHint, timeAdjust } from '../util/timesignal';
import { seasonNumber } from './parser';

export interface NormalizeOptions {
  reviewThreshold: number;
  autoThreshold: number;
  bangumiEnabled: boolean;
  /** 联网探测结果（由调用方统一探测一次，避免每个名称都试一次） */
  online?: boolean;
  /** 是否允许写入别名表（缓存 Bangumi 结果） */
  persistCache?: boolean;
  onLog?: (msg: string) => void;
  /** 前置网页检索：把罗马音 / 英文标题还原成日文原名后再查 Bangumi */
  webSearchEnabled?: boolean;
  /** 是否使用文件修改时间作为置信度参考 */
  useFileTime?: boolean;
  /** Google Programmable Search（可选） */
  googleApiKey?: string;
  googleCx?: string;
  /** 归档区里已经存在的番剧文件夹（名字 + 首播年月），用于「更具体者胜」复核 */
  archiveFolders?: ArchiveFolderRef[];
}

/** 一个已归档的番剧文件夹（名字就是用户已经确认过的结果，可信度很高） */
export interface ArchiveFolderRef {
  zh: string;
  year: number | null;
  month: number | null;
}

/** 明显的「泛化名」——极容易同名不同作品，强制人工确认 */
const GENERIC_NAMES = new Set([
  'fate', 'hunter', 'hunterxhunter', 'monster', 'air', 'kanon', 'clannad', 'one', 'hero',
  'anime', 'movie', 'ova', 'sp', 'special', 'unknown', 'new', 'kimi', 'love', 'sakura'
]);

const cache = new Map<string, Resolution>();

export function clearNormalizeCache(): void {
  cache.clear();
}

/**
 * 归一化入口。
 * @param seasonHint 季数提示（如 `S02` / `第二季` / `Part 2`）—— 用于区分续作，避免全落到第一季
 * @param timeHint   同组文件的修改时间区间 —— 作为「首播不会晚于下载时间」的旁证
 */
export async function normalizeName(
  rawName: string,
  store: Store,
  opts: NormalizeOptions,
  seasonHint?: string | null,
  timeHint?: TimeHint | null
): Promise<Resolution> {
  const key = aliasKey(rawName);
  // 时间线索按月分桶进入缓存键：同一部番剧在不同月份归档时仍能各自判定
  const tb = timeHint ? Math.floor(timeHint.earliestMs / (30 * 86400 * 1000)) : 0;
  const cacheKey = `${key}|${aliasKey(seasonHint ?? '')}|${opts.bangumiEnabled ? 1 : 0}|t${tb}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const result = await normalizeInner(rawName, key, store, opts, seasonHint ?? null, timeHint ?? null);
  cache.set(cacheKey, result);
  return result;
}

/** 假名（平假名 / 片假名）：用来判断「这是日文原名」而不是「繁体中文名」 */
const KANA = /[\u3040-\u309f\u30a0-\u30ff]/;

/** 单部作品的检索词上限（每个词都是一次 Bangumi 请求，有 3 QPS 限流） */
const MAX_SEARCH_QUERIES = 3;

/**
 * 构造 Bangumi 检索词候选（按优先级）。
 *
 * 【为什么必须转简体】
 * 直接把繁体标题丢给 Bangumi，不只是「搜不到」，而是会**命中错误条目**：
 *  - 「孤獨搖滾」→ 首条是「透明的孤独」（不相干作品），「孤独摇滚」→ 命中 `ぼっち・ざ・ろっく！`
 *  - 「咒術迴戰」→ 首条是 4D 电影版，「咒术回战」→ 命中 TV 版
 *  - 「輝夜姬想讓人告白」→ 命中衍生作，「辉夜大小姐想让我告白」→ 命中 TV 版
 *  - 「佐賀偶像是傳奇 捲土重來」→ 命中第一季，「佐贺偶像是传奇 卷土重来」→ 命中第二季
 *
 * 【为什么不能无脑转】
 * 日文原名的汉字与繁体同形（`進撃` `呪術` `魔王`），转简体会变成 `进撃`，
 * 反而让 Bangumi 的检索变差（实测候选从 4 条降到仍可命中，但不如原文精准）。
 * 所以：**含假名 ⇒ 日文原名，原文优先**；不含假名 ⇒ 中文标题，简体优先。
 *
 * 手动搜索（`/api/bangumi/search`）也复用这个函数。
 *
 * @param rawName     从文件名解析出的原始标题
 * @param seasonQuery 「标题 + 季数」的合并串（如 `Yuru Camp S02`），非续作传 null
 */
export function buildBangumiQueries(rawName: string, seasonQuery: string | null): string[] {
  const variants = (s: string): string[] => {
    const simp = toSimplified(s);
    if (simp === s) return [s];
    // 含假名 → 日文原名，别把 `進撃の巨人` 改成 `进击的巨人`
    return KANA.test(s) ? [s, simp] : [simp, s];
  };
  const list = seasonQuery ? [...variants(seasonQuery), ...variants(rawName)] : variants(rawName);
  return Array.from(new Set(list.filter(Boolean))).slice(0, MAX_SEARCH_QUERIES);
}

/**
 * 「更具体者胜」复核：L1 命中不一定是最贴切的那个名字。
 *
 * 【为什么需要】
 * L1 是「键精确命中」，但它可能命中的是一条**旧版本写入的脏记录** ——
 * 实测踩过：别名表把「…領主的養女」（第四季）挂到了第一季条目上，
 * 且置信度 1.0，后面的 L2/L3 完全没机会纠正，结果整季都被自动归到了第一季文件夹。
 *
 * 【判据】四条同时成立才替换（宁可漏改，不可错改）：
 *  1. 候选键**严格更长** —— 更长 = 更具体（例如多了「领主的养女」）
 *  2. 候选键**包含**当前键 —— 即「当前名字 + 后缀」这种真正的名字扩展
 *  3. 候选与文件名的相似度 ≥ `SPECIFIC_FLOOR`
 *  4. 候选比当前命中至少高出 `SPECIFIC_MARGIN`
 *
 * 【为什么光比「相对高低」不够（踩过坑）】
 * 相似度是 `0.5×TokenSet + 0.3×JaroWinkler + 0.2×编辑距离`，对**不相关**的名字也会给分：
 * `Full Dive` 与 `CLANNAD` 能得 0.179，而它当前的命中键相似度是 0.000，
 * 只看「谁更高」就会把 CLANNAD 抢进来（实测把 A5 用例带崩）。
 * 加上「包含关系 + 绝对值」后，这种无关名字两条都过不了。
 *
 * 对「L1 本来就是对的」情况天然无害：精确命中时相似度≈1.0，
 * 没有候选能高出 0.03，所以不会被抢掉。实测数据：
 *   `…領主的養女` 文件 → 对第一季名 0.822 / 对第四季名 0.915（含?true）⇒ 选第四季
 *   第一季文件         → 对第一季名 0.909 / 对第四季名 0.823 ⇒ 保持第一季
 */
const SPECIFIC_MARGIN = 0.03;
const SPECIFIC_FLOOR = 0.8;

/** 候选（官方名或已归档文件夹）的预计算键——避免在热循环里现场跑 `aliasKey` */
interface SpecificCandidate {
  zh: string;
  year: number | null;
  month: number | null;
  /** `aliasKey(aliasKey(zh))` */
  key2: string;
}

/**
 * 已归档文件夹的键缓存。
 *
 * 同一次扫描里，`archiveFolders` 是**同一个数组对象**（700 多个元素），
 * 但复核会对每个标题都跑一遍 —— 若每次现场算键，光是 700×750 次 `aliasKey`
 * 就要烧掉二十多秒。用 `WeakMap` 按数组对象缓存，一次扫描只算一次。
 * （实测踩过：不缓存时复核要 229ms/名字，整轮扫描多花 172 s。）
 */
const folderCandCache = new WeakMap<object, SpecificCandidate[]>();

function folderCandidates(folders?: ArchiveFolderRef[]): SpecificCandidate[] {
  if (!folders || !folders.length) return [];
  const cached = folderCandCache.get(folders);
  if (cached) return cached;
  const list: SpecificCandidate[] = [];
  for (const f of folders) {
    if (!f.zh) continue;
    const key2 = aliasKey(aliasKey(f.zh));
    if (key2) list.push({ zh: f.zh, year: f.year, month: f.month, key2 });
  }
  folderCandCache.set(folders, list);
  return list;
}

function pickMoreSpecificName(
  rawName: string,
  currentZh: string,
  store: Store,
  folders?: ArchiveFolderRef[]
): { zh: string; year: number | null; month: number | null; sim: number; from: string } | null {
  const curKey2 = aliasKey(aliasKey(currentZh));
  if (!curKey2) return null;
  // 两层 aliasKey：与别名表 / 候选里预计算的 key2 保持同一口径
  const fileKey2 = aliasKey(aliasKey(rawName));
  if (!fileKey2) return null;
  const curSim = similarityKeyed(fileKey2, curKey2);

  let best: { zh: string; year: number | null; month: number | null; sim: number; from: string } | null = null;
  const consider = (zh: string, year: number | null, month: number | null, key2: string, from: string): void => {
    if (!zh || zh === currentZh || !key2) return;
    // ① 便宜的长度预筛：不比当前命中更长就不可能是「更具体」的那个
    if (key2.length <= curKey2.length) return;
    // ② 便宜且精确：必须真的是「当前名字 + 后缀」这种扩展（无关名字在这里就被挡掉）
    if (!key2.includes(curKey2)) return;
    const sim = similarityKeyed(fileKey2, key2);
    // ③ 与文件名的绝对相似度要够高，④ 还要明显高于当前命中
    if (sim < SPECIFIC_FLOOR || sim < curSim + SPECIFIC_MARGIN) return;
    if (!best || sim > best.sim) best = { zh, year, month, sim, from };
  };

  // 别名表：按官方名去重后遍历（700~800 个，而不是 3600+ 条键），键已预先算好
  for (const [zh, v] of store.getZhIndex()) consider(zh, v.year, v.month, v.key2, 'alias');
  for (const c of folderCandidates(folders)) consider(c.zh, c.year, c.month, c.key2, 'folder');
  return best;
}
function hasSeasonMarker(name: string, season: number): boolean {
  const cn = '一二三四五六七八九十'[season - 1] ?? '';
  const n = String(season);
  // 罗马数字：Ⅱ / Ⅲ / Ⅳ …（日文作品常用「五等分の花嫁Ⅱ」这类写法）
  const roman = ['', 'Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ'][season] ?? '';
  const romanAlt = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'][season] ?? '';
  const re = new RegExp(
    `(?:第\\s*(?:${n}|${cn})\\s*[季期部]|season\\s*0*${n}(?!\\d)|\\bS0*${n}\\b|\\b0*${n}(?:st|nd|rd|th)\\s*season\\b|\\bpart\\s*0*${n}\\b` +
    (roman ? `|${roman}|\\b${romanAlt}\\b` : '') +
    `)`,
    'i'
  );
  return re.test(name);
}

/** 季数加权：候选名带了对应季数标记则加分 */
function seasonBoost(name: string, season: number | null): number {
  if (!season || season < 2) return 0;
  return hasSeasonMarker(name, season) ? 0.15 : 0;
}

async function normalizeInner(
  rawName: string,
  key: string,
  store: Store,
  opts: NormalizeOptions,
  seasonHint: string | null,
  timeHint: TimeHint | null
): Promise<Resolution> {
  const empty: Resolution = {
    officialZhName: '',
    alternateNames: [],
    year: null,
    month: null,
    matchLevel: 'L3',
    dataSource: 'fallback',
    confidence: 0,
    candidates: [],
    needReview: true,
    bangumiId: null
  };

  if (!key || key.length < 2) return empty;

  /* ---------- 季数 ---------- */
  const seasonNum = seasonNumber(seasonHint);
  const seasonRaw = seasonHint ? `${rawName} ${seasonHint}` : null;
  // 续作（S02 及以上）时，禁止用「去掉季数的裸标题」命中 L1，否则会被归到第一季
  const allowBareTitle = !seasonNum || seasonNum <= 1;

  /* ---------- L1 本地别名表 ---------- */
  const l1Season = seasonRaw ? store.lookup(seasonRaw) : null;
  const l1 = l1Season ?? (allowBareTitle ? store.lookup(rawName) : null);
  if (l1) {
    // 精确键命中也可能命中旧版脏记录（见 pickMoreSpecificName 注释）→ 先做一次「更具体者胜」复核
    const better = pickMoreSpecificName(rawName, l1.zh, store, opts.archiveFolders);
    if (better) {
      return {
        officialZhName: better.zh,
        alternateNames: [rawName],
        year: better.year,
        month: better.month,
        matchLevel: 'L1',
        dataSource: 'manual',
        confidence: 0.98,
        candidates: [],
        needReview: false,
        bangumiId: null,
        note: `别名表里「${rawName}」原本指向更宽泛的「${l1.zh}」，` +
          `但已存在更具体且更相似的名字「${better.zh}」（${better.from === 'folder' ? '归档文件夹' : '别名表'}，` +
          `相似度 ${better.sim.toFixed(2)}），已择优采用`
      };
    }
    return {
      officialZhName: l1.zh,
      alternateNames: l1.aliases ?? [],
      year: l1.year,
      month: l1.month,
      matchLevel: 'L1',
      dataSource: l1.src === 'manual' ? 'manual' : l1.src === 'bangumi' ? 'bangumi' : 'builtin',
      confidence: l1.src === 'manual' ? 1 : 0.97,
      candidates: [],
      needReview: false,
      bangumiId: l1.bangumiId ?? null
    };
  }

  /* ---------- 时间线索开关 ---------- */
  const useTime = opts.useFileTime !== false && !!timeHint;

  /* ---------- L3 本地模糊匹配（先做，成本最低） ----------
   * 这里只记录「名称相似度」与「加分项」，最终分数留到 L2 之后统一结算 ——
   * 因为「纯模糊候选是否允许靠时间加分越过自动归档线」取决于在线阶段有没有拿到权威名称证据。
   */
  // 续作（S02+）用「标题 + 季数」作为比对键，并排除本地库中不带该季标记的条目，
  // 否则 `Yuru Camp S2` 会命中第一季的 `Yuru Camp` 条目。
  const matchKey = seasonNum && seasonNum > 1 && seasonRaw ? aliasKey(seasonRaw) : key;
  // ⚠ `aliasKey` 很贵（≈40µs）。这里先把它对 matchKey 算一次；别名的键由
  //   `store.listAliases()` 预先算好（`key2` = aliasKey(aliasKey(alias))），
  //   否则「743 部番剧 × 2862 条别名」会把相似度计算拖成一分钟的纯字符串预处理。
  const matchKey2 = aliasKey(matchKey);
  const localScored: Array<{ c: Candidate; base: number; bonus: number }> = [];
  for (const { alias, key2: alias2, entry } of store.listAliases()) {
    if (!alias || alias.length < 3) continue;
    if (seasonNum && seasonNum > 1 && !hasSeasonMarker(entry.zh, seasonNum)) continue;
    const base = similarityKeyed(matchKey2, alias2);
    const tb = useTime ? timeAdjust(entry.year, entry.month, timeHint) : undefined;
    const bonus = seasonBoost(entry.zh, seasonNum) + (tb?.delta ?? 0);
    if (base + bonus >= 0.72) {
      localScored.push({
        base,
        bonus,
        c: {
          name: entry.zh,
          score: base,
          source: '本地别名表',
          year: entry.year,
          month: entry.month,
          bangumiId: entry.bangumiId ?? null,
          timeRelation: tb?.relation
        }
      });
    }
  }

  /* ---------- L2 Bangumi 在线查询 ---------- */
  const bangumiSubjects: BangumiSubject[] = [];
  const pushSubjects = (list: BangumiSubject[]): void => {
    list.forEach(s => {
      if (s && Number.isFinite(s.id) && !bangumiSubjects.some(x => x.id === s.id)) bangumiSubjects.push(s);
    });
  };
  /** 带缓存的 Bangumi 检索（同一查询词不重复联网） */
  const searchCached = async (q: string): Promise<BangumiSubject[]> => {
    if (!q) return [];
    const ck = `bgm:${aliasKey(q)}`;
    const cached = await store.getCached<BangumiSubject[]>(ck);
    if (cached && Array.isArray(cached) && cached.length) return cached;
    if (!opts.online) return [];
    try {
      const found = await searchSubjects(q);
      if (found.length && opts.persistCache !== false) await store.setCached(ck, found);
      return found;
    } catch {
      return [];
    }
  };

  if (opts.bangumiEnabled) {
    // 续作优先用「标题 + 季数」查询（如 `Yuru Camp S02`），查不到再退回裸标题；
    // 繁体标题先转简体（见 buildSearchQueries 的注释：直接用繁体不仅搜不到，还会命中错误条目）
    const queryList = buildBangumiQueries(rawName, seasonRaw && !allowBareTitle ? seasonRaw : null);
    for (const q of queryList) {
      const found = await searchCached(q);
      if (found.length) {
        if (!opts.online) opts.onLog?.(`♻ L2 命中本地缓存（不联网）：${q}`);
        pushSubjects(found);
        break;
      }
    }
  }

  /* ---------- L2b 前置网页检索 ----------
   * 罗马音 / 英文标题与 Bangumi 的日文条目无法用字符串相似度比较，
   * 于是先做一次网页检索，把标题**还原成日文原名 / 中文译名**，再用还原后的标题回查 Bangumi。
   * 还原后两侧同语言 → 可做「保留 ! 与数字」的严格比对，置信度才真正拉得起来。
   */
  let webHits: WebTitleHit[] = [];
  const prelimScore = (): number => {
    if (!bangumiSubjects.length) return 0;
    let best = 0;
    bangumiSubjects.forEach((s, i) => {
      const f = scoreSubject(s, key);
      const withPrior = i === 0 && f < 0.82 ? 0.82 : f;
      if (withPrior > best) best = withPrior;
    });
    return best;
  };

  const needWeb =
    opts.webSearchEnabled !== false &&
    opts.bangumiEnabled &&
    !!opts.online &&
    looksLikeRomaji(rawName) &&
    prelimScore() < opts.autoThreshold;

  if (needWeb) {
    try {
      webHits = await webResolveTitlesCached(rawName, store, {
        online: opts.online,
        googleApiKey: opts.googleApiKey,
        googleCx: opts.googleCx,
        persistCache: opts.persistCache,
        onLog: opts.onLog
      });
    } catch (err) {
      opts.onLog?.(`⚠ 网页检索失败（${rawName}）：${(err as Error).message}`);
      webHits = [];
    }

    // 用还原名回查 Bangumi（只取**排序第 1** 的还原结果 —— 后续结果往往是同系列的其他季，
    // 全量带入反而会把「系列名」误当成「本季名」，导致无法区分季数）
    const primary = webHits[0];
    if (primary) {
      const titles = [primary.title, ...primary.aliases]
        .filter(t => t && /[\u3040-\u30ff\u4e00-\u9fff]/.test(t))
        .slice(0, 2);
      for (const qt of titles) pushSubjects(await searchCached(qt));
    }
  }

  /* ---------- L2 统一打分（严格键 + 季数 + 文件时间） ----------
   * 名称证据分三档：
   *   ① 严格键完全一致（保留 `! ? 数字`）→ 1.0
   *   ② 去标点后一致（`loose`）        → 0.88
   *   ③ 只有模糊相似度                → 原模糊分，且**不再靠时间加分越线**
   *
   * 关键难点：网页检索给出的往往是**整个系列**的标题（`Hataraku Saibou!!` → 还原出 `はたらく細胞`），
   * 它同时命中第 1 季与第 2 季 —— 此时名称证据**无法区分季数**，
   * 于是在「同一还原名命中多条」（`franchise`）时把名称证据统一压到 0.86，
   * 让「文件修改时间 / 季数标记」来决出唯一一条越过自动归档阈值的候选。
   */
  const rawQueries = [rawName, ...(seasonRaw ? [seasonRaw] : [])];
  /** 名称证据不足（仅模糊）时的封顶：不让时间加分把「碰巧像」的候选推过自动归档线 */
  const fuzzyCap = Math.max(0, opts.autoThreshold - 0.001);

  /** 给定「网页还原标题」，对 Bangumi 结果统一打分 */
  const scoreWithWebTitles = (webTitles: string[]): { list: Candidate[]; franchise: boolean } => {
    const queries = [...rawQueries, ...webTitles];
    const evidence = bangumiSubjects.map(s => strictCompare(s, queries, rawQueries.length));
    const authoritativeCount = evidence.filter(e => e.exact || e.loose || e.seasonSuffix).length;
    const anyAuthoritative = authoritativeCount > 0;
    const franchise = authoritativeCount > 1;
    const list: Candidate[] = [];

    bangumiSubjects.forEach((s, rank) => {
      const e = evidence[rank];
      const authoritative = e.exact || e.loose || e.seasonSuffix;
      const fuzzy = scoreSubject(s, key);
      // 名称证据：唯一命中 → 完全一致 1.0 / 同系列不同季 0.9 / 仅去标点一致 0.88；
      // 但若**一个还原名命中多条**（同一系列的多季），名称本身已经无法区分季数，
      // 于是给它们**同一个底分 0.84**，让「文件修改时间 / 季数标记」决出唯一一条越过自动归档阈值。
      const base = authoritative
        ? (franchise ? 0.84 : e.exact ? 1 : e.seasonSuffix ? 0.9 : 0.88)
        : fuzzy;

      const tb = useTime ? timeAdjust(s.year, s.month, timeHint) : undefined;
      const seasonBonus = seasonBoost(pickDisplayName(s), seasonNum) + seasonBoost(s.name, seasonNum);
      const bonus = seasonBonus + (tb?.delta ?? 0);
      let boosted = bonus >= 0 ? Math.min(1, base + bonus) : Math.max(0, base + bonus);
      // 已有权威名称证据时，纯模糊候选不得越过自动归档阈值（避免「碰巧像」的答案抢先归档）
      if (!authoritative && anyAuthoritative) boosted = Math.min(boosted, fuzzyCap);

      // 罗马音/日文与中文译名之间无法用字符串相似度衡量：
      // 为 Bangumi 相关度最高的结果引入「排序先验分」（0.82，落在待确认区间，绝不自动执行）
      const fromPrior = rank === 0 && boosted < 0.82;
      // 但若「首播时间晚于文件修改时间」，说明这条根本不可能 → 连先验分也不给
      const future = tb?.relation === 'future';
      const score = future ? Math.min(0.65, boosted) : fromPrior ? 0.82 : boosted;

      const webSrc = authoritative && e.fromWeb;
      list.push({
        name: pickDisplayName(s),
        score: Number(score.toFixed(4)),
        source: webSrc
          ? 'Bangumi · 网页检索命中'
          : s.nameCn ? 'Bangumi · 中国大陆译名' : 'Bangumi · 日文原名',
        year: s.year,
        month: s.month,
        bangumiId: s.id,
        rank,
        fromPrior: fromPrior && !future,
        webMatched: webSrc === true && !franchise,
        strictExact: e.exact,
        looseMatch: e.loose || e.seasonSuffix,
        seasonSuffix: e.seasonSuffix,
        timeRelation: tb?.relation
      });
    });
    list.sort((a, b) => b.score - a.score);
    return { list, franchise };
  };

  let onlineCandidates: Candidate[] = [];
  let franchiseAmbiguous = false;
  if (opts.bangumiEnabled && bangumiSubjects.length) {
    const webTitles = webHits[0] ? [webHits[0].title, ...webHits[0].aliases] : [];
    let scored = scoreWithWebTitles(webTitles);
    // 网页检索可能给出**完全不相关**的结果（站内模糊搜索会命中奇怪条目）。
    // 保护：若「网页还原名」指向的条目**首播晚于文件修改时间**，
    // 说明这个还原名基本可以确定是错的 → 丢弃网页证据重算，退回文件名自身的证据。
    const webBacked = scored.list.filter(c => c.webMatched === true || c.looseMatch === true);
    if (webTitles.length && webBacked.length && webBacked.every(c => c.timeRelation === 'future')) {
      opts.onLog?.(`⚠ 网页检索结果（${webHits[0]?.title ?? ''}）与文件时间矛盾，已弃用该还原名`);
      webHits = [];
      scored = scoreWithWebTitles([]);
    }
    onlineCandidates = scored.list;
    franchiseAmbiguous = scored.franchise;
  }

  /* ---------- 结算本地模糊候选（与在线候选同一套封顶规则） ----------
   * 本地别名表的条目标签同样是「无严格键证据」，因此当在线阶段已经拿到
   * 权威名称证据时，不允许它靠时间加分越过自动归档阈值。
   */
  const onlineAuthoritative = onlineCandidates.some(c => c.strictExact === true || c.looseMatch === true);
  const localCandidates = localScored
    .map(({ c, base, bonus }) => {
      const raw = bonus >= 0 ? Math.min(1, base + bonus) : Math.max(0, base + bonus);
      const score = onlineAuthoritative ? Math.min(raw, fuzzyCap) : raw;
      return { ...c, score: Number(score.toFixed(4)) };
    })
    .sort((a, b) => b.score - a.score);
  const localTop = dedupeCandidates(localCandidates).slice(0, 5);

  /* ---------- 合并候选 ---------- */
  const merged = dedupeCandidates([...localTop, ...onlineCandidates]).sort((a, b) => b.score - a.score);
  const top = merged.slice(0, 5);

  if (!top.length) {
    // 完全查不到 → 兜底：使用「日文原名」（若原始名已是中文/日文则直接用原名）
    const fallbackName = chooseFallbackName(rawName);
    return {
      ...empty,
      officialZhName: fallbackName,
      alternateNames: [rawName],
      matchLevel: 'L3',
      dataSource: 'fallback',
      confidence: fallbackName ? 0.35 : 0,
      candidates: [],
      needReview: true
    };
  }

  const best = top[0];
  let confidence = best.score;

  // 歧义检测：Top-2 都达标且差距小 → 强制人工确认（同名不同作品）
  const second = top[1];
  let ambiguous = false;
  if (second && second.score >= opts.reviewThreshold) {
    // 若最佳候选有权威名称证据（严格键 / 网页还原名）、而第二名只是「碰巧像」，
    // 则用更严的差距阈值，避免把已经确证的答案又打回人工确认
    const bestAuthoritative = best.strictExact === true || best.looseMatch === true || best.webMatched === true;
    const secondAuthoritative = second.strictExact === true || second.looseMatch === true || second.webMatched === true;
    // 「同一标题命中多条」（同系列多季 / 同名重制）时名称本就分不出季数，
    // 系统已明确改用文件时间判定 → 这里只要保证两者确实被区分开即可
    const margin = franchiseAmbiguous
      ? 0.04
      : bestAuthoritative && !secondAuthoritative
        ? 0.05
        : 0.12;
    if (best.score - second.score < margin) ambiguous = true;
  }
  if (GENERIC_NAMES.has(key)) ambiguous = true;
  if (best.score < 0.78 && key.length <= 6) ambiguous = true;
  // 续作（S02+）：若候选名里找不到对应季数标记，说明可能取到了第一季 → 一律人工确认
  // （但「条目名 = 还原名 + 季数后缀」这种已由 strictCompare 识别过的情形除外：
  //   如 `五等分の花嫁∬` 的 `∬`、`はたらく細胞!!` 的 `!!` 都是季数标记的非常用写法）
  if (seasonNum && seasonNum > 1 && !hasSeasonMarker(best.name, seasonNum) && best.seasonSuffix !== true) {
    ambiguous = true;
  }

  // 补全元数据（年份/月份/别名）——若最佳候选缺年份且有 bangumiId，则查询详情
  let year = best.year ?? null;
  let month = best.month ?? null;
  let alternateNames: string[] = [];
  let bangumiId = best.bangumiId ?? null;

  if (bangumiId && (year === null || month === null)) {
    const detail = (await store.getCached<BangumiSubject>(`bgm-detail:${bangumiId}`))
      ?? (opts.online ? await getSubject(bangumiId) : null);
    if (detail) {
      await store.setCached(`bgm-detail:${bangumiId}`, detail);
      year = year ?? detail.year;
      month = month ?? detail.month;
      alternateNames = [detail.name, ...detail.aliases].filter(Boolean);
      if (!best.name && detail.nameCn) best.name = detail.nameCn;
    }
  }

  const subject = bangumiSubjects.find(s => s.id === bangumiId);
  if (subject) {
    alternateNames = Array.from(new Set([subject.name, subject.nameCn, ...subject.aliases].filter(Boolean)));
  }

  // 命中唯一且相似度高 → 写回别名表（下次直接 L1）
  // 续作只写「标题 + 季数」的键，避免污染第一季的裸标题键
  if (opts.persistCache !== false && !ambiguous && best.score >= 0.85 && best.name) {
    const keys = seasonNum && seasonNum > 1 && seasonRaw ? [seasonRaw] : [rawName];
    const aliases = Array.from(new Set([...keys, ...alternateNames]));
    await store.upsertAlias(aliases, best.name, year, month, 'bangumi', bangumiId);
  }

  const matchLevel: MatchLevel = best.source.includes('Bangumi') ? 'L2' : 'L3';
  const dataSource: DataSource = best.source.includes('网页检索')
    ? 'web'
    : best.source.includes('Bangumi')
      ? 'bangumi'
      : best.source.includes('本地')
        ? 'local'
        : 'anilist';

  if (ambiguous) confidence = Math.min(confidence, opts.reviewThreshold - 0.001 + 0.001);

  // 命中方式说明（界面展示，让「为什么是这条」可追溯）
  let note = '';
  if (franchiseAmbiguous && best.timeRelation && best.timeRelation !== 'unknown') {
    note = `网页检索还原出系列名，但同系列多季无法靠名称区分 → 依文件时间判定为「${best.name}」`;
  } else if (best.webMatched) {
    const hit = webHits[0];
    note = `网页检索（${hit?.source ?? '在线'}）还原标题「${hit?.title ?? ''}」→ Bangumi 精确命中`;
  } else if (best.strictExact) {
    note = '文件名与条目名称严格一致（含 ! / 数字 等后缀）';
  } else if (franchiseAmbiguous) {
    note = '同系列多季均可能命中，且缺少可用的文件时间线索 → 请人工确认';
  } else if (webHits.length) {
    note = `已用网页检索还原标题（${webHits.slice(0, 2).map(h => h.title).join(' / ')}）`;
  } else if (best.fromPrior) {
    note = '罗马音与中文译名无法直接比对，采用 Bangumi 相关度先验分';
  }

  const timeNote = useTime && best.year
    ? describeTimeHint(timeHint, best.year, best.month)
    : '';

  return {
    officialZhName: best.name,
    alternateNames,
    year,
    month,
    matchLevel,
    dataSource,
    confidence: Number(confidence.toFixed(4)),
    candidates: top,
    needReview: ambiguous || best.score < opts.autoThreshold,
    bangumiId,
    note: note || undefined,
    timeNote: timeNote || undefined
  };
}

/** 展示名：优先官方中文名，其次日文原名（❌ 不使用罗马音） */
function pickDisplayName(s: BangumiSubject): string {
  if (s.nameCn && s.nameCn.trim()) return s.nameCn.trim();
  return (s.name || '').trim() || s.nameCn;
}

/**
 * 「季数 / 衍生后缀」判定：`extra` 是否是纯粹的季数或装饰标记。
 *
 * 用于识别「条目名 = 还原名 + 季数后缀」这种同系列不同季的关系，
 * 例如 `五等分の花嫁` → `五等分の花嫁∬`、`はたらく細胞` → `はたらく細胞!!`。
 *
 * ⚠ 必须**排除**词形后缀：`はたらく細胞BLACK` 的 `black` 是另一部作品，不能算同季。
 */
function isSeasonSuffix(extra: string): boolean {
  const e = extra.replace(/^[\-–—_・:：.]+/, '').trim();
  if (!e) return false;
  if (/^[!！?？~～★☆♪♥♡]+$/.test(e)) return true;                    // !! / ! / ～
  if (/^[ⅡⅢⅣⅤⅥⅦⅧⅨⅩⅰⅱⅲⅳ∬∽＊*＃#]+$/i.test(e)) return true;       // 罗马数字样式后缀
  if (/^\d{1,2}$/.test(e)) return true;                                // 2 / 3
  if (/^(?:v|part|cour|season|s)\s*\d{1,2}$/i.test(e)) return true;    // part2 / season 3
  if (/^第[一二三四五六七八九十\d]{1,3}[季期部]$/.test(e)) return true; // 第2季
  return false;
}

/**
 * 用「严格键」把查询词与条目做比对。
 *
 *   exact       → 名称严格完全相同（保留 `!` `数字` `∬` 等后缀）
 *   seasonSuffix→ 条目名 = 查询名 + 季数后缀（同系列的不同季）
 *   loose       → 只有「去掉标点后相同」
 *
 * `fromWeb` 表示这次命中是靠网页检索还原出来的标题取得的（用于界面标注）。
 */
function strictCompare(
  s: BangumiSubject,
  queries: string[],
  rawQueryCount: number
): { exact: boolean; loose: boolean; seasonSuffix: boolean; fromWeb: boolean } {
  const empty = { exact: false, loose: false, seasonSuffix: false, fromWeb: false };
  const pool = [s.name, s.nameCn, ...s.aliases].filter(Boolean);
  if (!pool.length) return empty;
  const strictPool = pool.map(strictKey).filter(Boolean);
  const loosePool = new Set(pool.map(aliasKey).filter(Boolean));

  let exact = false;
  let loose = false;
  let seasonSuffix = false;
  let fromWeb = false;
  queries.forEach((q, idx) => {
    const sk = strictKey(q);
    if (!sk) return;
    const isWeb = idx >= rawQueryCount;
    if (strictPool.includes(sk)) {
      exact = true;
      if (isWeb) fromWeb = true;
      return;
    }
    // 条目名比查询名多出一个「季数后缀」→ 同一个系列的不同季
    if (strictPool.some(p => p.length > sk.length && p.startsWith(sk) && isSeasonSuffix(p.slice(sk.length)))) {
      seasonSuffix = true;
      if (isWeb) fromWeb = true;
      return;
    }
    if (loosePool.has(aliasKey(q))) {
      loose = true;
      if (isWeb) fromWeb = true;
    }
  });
  return { exact, loose, seasonSuffix, fromWeb };
}

/** 条目与查询词的相似度：取 name / name_cn / 别名的最大值 */
function scoreSubject(s: BangumiSubject, key: string): number {
  const pool = [s.nameCn, s.name, ...s.aliases].filter(Boolean);
  let best = 0;
  for (const p of pool) {
    const k = aliasKey(p);
    if (!k) continue;
    if (k === key) return 1; // 完全命中
    const sc = similarity(key, k);
    if (sc > best) best = sc;
  }
  if (!best) return 0;
  // 名称比查询词多出一大截（如外传 / 第 2 期 / 特别篇）→ 轻微降权，避免取到衍生作
  const primaryLen = aliasKey(s.name || s.nameCn).length || key.length;
  const extra = Math.max(0, primaryLen - key.length) / Math.max(key.length, 1);
  const penalty = Math.min(0.12, extra * 0.06);
  return Number(Math.max(0, best - penalty).toFixed(4));
}

function dedupeCandidates(list: Candidate[]): Candidate[] {
  const map = new Map<string, Candidate>();
  list.forEach(c => {
    const k = aliasKey(c.name) || c.name;
    const prev = map.get(k);
    if (!prev || c.score > prev.score) map.set(k, c);
  });
  return Array.from(map.values());
}

/**
 * 兜底命名（文档 4.5）：
 *   1) Bangumi 官方中文名  2) 通用译名  3) 日文原名   ❌ 不使用罗马音
 * 这里只处理「完全查不到」的情况：若原始名已是中文或日文，直接使用；
 * 若原始名是纯罗马音 → 返回空（交由人工确认，绝不使用罗马音当目录名）。
 */
export function chooseFallbackName(rawName: string): string {
  const s = preprocess(rawName).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const hasCjk = /[\u3040-\u30ff\u4e00-\u9fff]/.test(rawName);
  if (hasCjk) return rawName.trim();
  return '';
}
