/**
 * 前置网页检索层（提高罗马音 / 英文标题的解析准确率）
 *
 * 背景：《需求与设计文档》只有 L1 本地别名表 → L2 Bangumi → L3 模糊匹配。
 * 问题：文件名多为**罗马音 / 英文**（如 `Hataraku Saibou!!`、`Sousou no Frieren`），
 *       而 Bangumi 的条目原名是**日文**、中文名是 `name_cn`，
 *       罗马音与日文之间无法用字符串相似度衡量 → 只能给「排序第 1」打先验分，长期停在「待确认」。
 *
 * 策略：先做一次网页检索，把罗马音 / 英文标题**还原成日文原名或中文译名**，
 *       再拿还原后的标题去 Bangumi 回查 → 此时两侧同语言，可以做「保留 ! 与数字」的严格比对。
 *
 * 检索源（**并行**发起，谁先给出含中日文的结果就用谁；全部失败则静默跳过、退回原逻辑）：
 *   1. Google Programmable Search（需在「⚙ 设置」里填 API Key + 搜索引擎 ID，可选）
 *   2. Wikipedia（en / ja 交叉取标题，免费、无需 Key、可用性最好，且能直接给出日文 + 中文名）
 *   3. Kitsu（免费、无需 Key）
 *   4. AniList（免费、无需 Key；2026-09 官方一度临时停用，故仅作补充）
 *   5. Jikan / MyAnimeList（免费、无需 Key；上游偶有不稳定）
 */
import { RateLimiter, httpJson, httpRequest } from '../net/http';
import { aliasKey, similarity } from '../util/text';

export type WebSearchSource = 'Google' | 'Wikipedia' | 'Kitsu' | 'AniList' | 'Jikan';

export interface WebTitleHit {
  /** 还原出来的官方原名（日文优先） */
  title: string;
  /** 同一部作品的其他写法（中文 / 英文 / 罗马音 / 同义词） */
  aliases: string[];
  year: number | null;
  month: number | null;
  source: WebSearchSource;
  /** 与该检索源的返回顺序相关的先验分（0.60 起递减） */
  prior: number;
  /** 与查询词的字面相似度（仅用于排序；罗马音↔日文通常为 0） */
  sim?: number;
}

export interface WebSearchOptions {
  online?: boolean;
  googleApiKey?: string;
  googleCx?: string;
  onLog?: (msg: string) => void;
}

/** 各检索源的限流（都远低于各自官方限制） */
const wikiLimiter = new RateLimiter(120);      // Wikimedia 对匿名调用很宽松
const kitsuLimiter = new RateLimiter(400);
const anilistLimiter = new RateLimiter(700);   // AniList 约 90 req/min
const jikanLimiter = new RateLimiter(1100);    // Jikan 约 60 req/min
const googleLimiter = new RateLimiter(600);    // Google CSE 免费额度 100 次/天

/**
 * 检索源可信度排序（越小越可信）。
 *
 * 为什么需要：Kitsu / Jikan 的搜索是**子串匹配**，`5Hanayome` 会被匹配到
 * `瀬戸の花嫁`（Seto no Hanayome）这类只共用了 `Hanayome` 的作品；
 * 而 Wikipedia 的 `generator=search` 基于标题与重定向，命中质量明显更好。
 * 因此不能"谁先返回用谁"，要按可信度取。
 */
const SOURCE_PRIORITY: Record<WebSearchSource, number> = {
  Google: 0,
  Wikipedia: 1,
  Kitsu: 2,
  AniList: 3,
  Jikan: 4
};

/** 「必须先等」的源：它们返回前不要过早收工 */
const WAIT_SOURCES: WebSearchSource[] = ['Google', 'Wikipedia'];

/** 单次网页检索的总时间预算 */
const WEB_BUDGET_MS = 6000;
/** 各源的单独超时 */
const PER_SOURCE_MS = 4500;

const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 天

interface CacheBox {
  at: number;
  hits: WebTitleHit[];
}

const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/;

/** 是否为「看起来像罗马音 / 英文」的查询词（决定是否值得走网页检索） */
export function looksLikeRomaji(q: string): boolean {
  const s = (q || '').trim();
  if (!s) return false;
  if (CJK.test(s)) return false; // 已是日文/中文：标题已足够精确，不需要还原
  return /[a-z]{2,}/i.test(s);
}

/* =========================================================
   主入口
   ========================================================= */

export async function webResolveTitles(query: string, opts: WebSearchOptions): Promise<WebTitleHit[]> {
  if (!opts.online) return [];
  const q = (query || '').trim();
  if (!q) return [];

  type Task = { label: WebSearchSource; run: () => Promise<WebTitleHit[]> };
  const tasks: Task[] = [];

  if (opts.googleApiKey && opts.googleCx) {
    tasks.push({ label: 'Google', run: () => googleSearch(q, opts.googleApiKey as string, opts.googleCx as string) });
  }
  tasks.push({ label: 'Wikipedia', run: () => wikipediaSearch(q) });
  tasks.push({ label: 'Kitsu', run: () => kitsuSearch(q) });
  tasks.push({ label: 'AniList', run: () => anilistSearch(q) });
  tasks.push({ label: 'Jikan', run: () => jikanSearch(q) });

  const { hits, from } = await raceProviders(tasks);
  if (hits.length) {
    opts.onLog?.(`🔎 网页检索「${q}」命中：${from.join(' + ')}`);
  } else {
    opts.onLog?.(`ℹ 网页检索无结果：${q}`);
  }
  return rankHits(hits, q);
}

/**
 * 并行发起所有检索源。
 *
 * 收工条件（三者之一）：
 *   ① `WAIT_SOURCES`（Google / Wikipedia）**全部返回**且已有含中日文的标题 → 立即收工
 *   ② 所有源都返回（含失败）
 *   ③ 总预算 `WEB_BUDGET_MS` 耗尽
 *
 * 注意：**不能**"谁先返回算谁的" —— Kitsu 的子串匹配快但会把 `5Hanayome`
 * 匹配到 `瀬戸の花嫁`；必须等 Wikipedia 这类基于标题检索的源表完态再定夺。
 */
async function raceProviders(
  tasks: Array<{ label: WebSearchSource; run: () => Promise<WebTitleHit[]> }>
): Promise<{ hits: WebTitleHit[]; from: WebSearchSource[] }> {
  const out: WebTitleHit[] = [];
  const from: WebSearchSource[] = [];
  let allPending = tasks.length;
  let waitPending = tasks.filter(t => WAIT_SOURCES.includes(t.label)).length;

  await new Promise<void>(resolve => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    const timer = setTimeout(finish, WEB_BUDGET_MS);
    if (typeof (timer as unknown as { unref?: () => void }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }

    const settle = (task: { label: WebSearchSource }, hits: WebTitleHit[]): void => {
      if (done) return;
      if (hits.length) {
        hits.forEach(h => out.push(h));
        from.push(task.label);
      }
      allPending--;
      if (WAIT_SOURCES.includes(task.label)) waitPending--;
      const hasCjk = out.some(h => CJK.test(h.title));
      if (waitPending === 0 && hasCjk) { clearTimeout(timer); finish(); return; }
      if (allPending === 0) { clearTimeout(timer); finish(); }
    };

    tasks.forEach(task => {
      withTimeout(task.run(), PER_SOURCE_MS)
        .then(hits => settle(task, hits))
        .catch(() => settle(task, []));
    });
  });

  return { hits: out, from };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('网页检索超时')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** 合并去重 + 排序（同一部作品只留最高分），最多返回 4 条 */
function rankHits(hits: WebTitleHit[], query: string): WebTitleHit[] {
  const byKey = new Map<string, WebTitleHit>();
  hits.forEach(h => {
    const key = aliasKey(h.title);
    if (!key) return;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, h); return; }
    if (h.prior > prev.prior) {
      h.aliases = Array.from(new Set([...h.aliases, prev.title, ...prev.aliases]));
      byKey.set(key, h);
    } else {
      prev.aliases = Array.from(new Set([...prev.aliases, h.title, ...h.aliases]));
    }
  });

  const qk = aliasKey(query);
  const list = Array.from(byKey.values());
  list.forEach(h => {
    let sim = similarity(qk, aliasKey(h.title));
    h.aliases.forEach(a => { sim = Math.max(sim, similarity(qk, aliasKey(a))); });
    h.sim = Number(sim.toFixed(4));
  });
  // 排序：① 源可信度 ② 是否含中日文（只有它们能和 Bangumi 条目严格比对） ③ 字面相似度 + 先验分
  list.sort((a, b) => {
    const pa = SOURCE_PRIORITY[a.source] ?? 9;
    const pb = SOURCE_PRIORITY[b.source] ?? 9;
    if (pa !== pb) return pa - pb;
    const ca = CJK.test(a.title) ? 1 : 0;
    const cb = CJK.test(b.title) ? 1 : 0;
    if (ca !== cb) return cb - ca;
    return ((b.sim ?? 0) + b.prior) - ((a.sim ?? 0) + a.prior);
  });
  return list.slice(0, 4);
}

/* =========================================================
   ① Wikipedia（免费 / 无 Key / 可用性最好，且能跨语言直接给出日文 + 中文名）
   ========================================================= */

interface WikiPage {
  title?: string;
  index?: number;
  langlinks?: Array<{ lang?: string; '*'?: string }>;
}

async function wikiSearch(lang: 'en' | 'ja' | 'zh', q: string): Promise<WebTitleHit[]> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&generator=search` +
    `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&prop=langlinks&lllimit=500&redirects=1`;
  const json = await httpJson<{ query?: { pages?: Record<string, WikiPage> } }>(url, wikiLimiter, { retries: 0 });
  const pages = Object.values(json?.query?.pages ?? {});
  if (!pages.length) return [];
  pages.sort((a, b) => (a.index ?? 9) - (b.index ?? 9));

  return pages.map((p, i) => {
    const pick = (l: string): string => ((p.langlinks ?? []).find(x => x.lang === l)?.['*'] ?? '').trim();
    const self = (p.title ?? '').trim();
    const ja = pick('ja');
    const zh = pick('zh');
    const en = pick('en');
    // 收录顺序：日文原名 > 中文译名 > 本页标题 > 英文
    const title = ja || zh || self || en;
    return {
      title,
      aliases: Array.from(new Set([ja, zh, self, en].filter(t => t && t !== title))),
      year: null,
      month: null,
      source: 'Wikipedia' as const,
      prior: Number(Math.max(0.62, 0.90 - i * 0.05).toFixed(3))
    };
  }).filter(h => h.title);
}

async function wikipediaSearch(q: string): Promise<WebTitleHit[]> {
  const isJa = /[\u3040-\u30ff]/.test(q);
  const [en, ja] = await Promise.all([
    wikiSearch('en', q).catch(() => [] as WebTitleHit[]),
    isJa ? wikiSearch('ja', q).catch(() => [] as WebTitleHit[]) : Promise.resolve([] as WebTitleHit[])
  ]);
  return [...en, ...ja];
}

/* =========================================================
   ② Kitsu（免费 / 无 Key）
   ========================================================= */

interface KitsuAnime {
  attributes?: {
    canonicalTitle?: string;
    titles?: Record<string, string>;
    startDate?: string | null;
  };
}

async function kitsuSearch(q: string): Promise<WebTitleHit[]> {
  const url = `https://kitsu.io/api/edge/anime?filter%5Btext%5D=${encodeURIComponent(q)}&page%5Blimit%5D=5`;
  await kitsuLimiter.take();
  // Kitsu 要求 JSON:API 形式的 Accept
  const res = await httpRequest(url, {
    headers: { Accept: 'application/vnd.api+json' },
    timeoutMs: PER_SOURCE_MS
  }).catch(() => null);
  if (!res || res.status !== 200) return [];
  let json: { data?: KitsuAnime[] };
  try {
    json = JSON.parse(res.body) as { data?: KitsuAnime[] };
  } catch {
    return [];
  }
  return (json.data ?? []).map((a, i) => {
    const t = a.attributes?.titles ?? {};
    const ja = (t.ja_jp ?? '').trim();
    const zh = (t.zh_cn ?? t.zh_tw ?? '').trim();
    const en = (t.en ?? t.en_us ?? '').trim();
    const canon = (a.attributes?.canonicalTitle ?? '').trim();
    const title = ja || zh || canon || en;
    const d = (a.attributes?.startDate ?? '') as string;
    const ym = /^(\d{4})-(\d{2})/.exec(d);
    return {
      title,
      aliases: Array.from(new Set([zh, canon, en].filter(x => x && x !== title))),
      year: ym ? Number(ym[1]) : null,
      month: ym ? Number(ym[2]) : null,
      source: 'Kitsu' as const,
      prior: Number(Math.max(0.6, 0.85 - i * 0.05).toFixed(3))
    };
  }).filter(h => h.title);
}

/* =========================================================
   ③ AniList（免费 / 无 Key）
   ========================================================= */

interface AniListMedia {
  title?: { romaji?: string; native?: string; english?: string };
  synonyms?: string[];
  startDate?: { year?: number; month?: number };
}

async function anilistSearch(q: string): Promise<WebTitleHit[]> {
  const body = JSON.stringify({
    query:
      'query ($q: String) { Page(page: 1, perPage: 6) { media(search: $q, type: ANIME, sort: [SEARCH_MATCH]) ' +
      '{ title { romaji native english } synonyms startDate { year month } } } }',
    variables: { q }
  });
  const json = await httpJson<{ data?: { Page?: { media?: AniListMedia[] } } }>(
    'https://graphql.anilist.co',
    anilistLimiter,
    { method: 'POST', body, retries: 0, missStatus: [400, 403, 404, 429] }
  );
  const media = json?.data?.Page?.media ?? [];
  return media.map((m, i) => {
    const native = (m.title?.native ?? '').trim();
    const romaji = (m.title?.romaji ?? '').trim();
    const english = (m.title?.english ?? '').trim();
    const title = native || romaji || english;
    return {
      title,
      aliases: Array.from(new Set([romaji, english, ...(m.synonyms ?? [])].filter(Boolean))),
      year: m.startDate?.year ?? null,
      month: m.startDate?.month ?? null,
      source: 'AniList' as const,
      prior: Number(Math.max(0.6, 0.86 - i * 0.05).toFixed(3))
    };
  }).filter(h => h.title);
}

/* =========================================================
   ④ Jikan / MyAnimeList（免费 / 无 Key）
   ========================================================= */

interface JikanAnime {
  title?: string;
  title_english?: string;
  title_japanese?: string;
  titles?: Array<{ type?: string; title?: string }>;
  synonyms?: string[];
  aired?: { prop?: { from?: { year?: number; month?: number } } };
}

async function jikanSearch(q: string): Promise<WebTitleHit[]> {
  const url = `https://api.jikan.moe/v4/anime?q=${encodeURIComponent(q)}&limit=6&sfw=true`;
  const json = await httpJson<{ data?: JikanAnime[] }>(url, jikanLimiter, {
    retries: 0,
    missStatus: [400, 404, 429, 504]
  });
  const list = json?.data ?? [];
  return list.map((a, i) => {
    const titles = (a.titles ?? []).map(t => (t.title ?? '').trim()).filter(Boolean);
    const native = (a.title_japanese ?? '').trim() || titles.find(t => CJK.test(t)) || '';
    const english = (a.title_english ?? '').trim();
    const title = native || (a.title ?? '').trim() || english;
    return {
      title,
      aliases: Array.from(new Set([a.title, english, ...titles, ...(a.synonyms ?? [])].filter(Boolean) as string[])),
      year: a.aired?.prop?.from?.year ?? null,
      month: a.aired?.prop?.from?.month ?? null,
      source: 'Jikan' as const,
      prior: Number(Math.max(0.6, 0.84 - i * 0.05).toFixed(3))
    };
  }).filter(h => h.title);
}

/* =========================================================
   ⑤ Google Programmable Search（可选：在设置里填 API Key + cx）
   ========================================================= */

const GOOGLE_NOISE = [
  /[-|｜–—_]\s*(?:维基百科|wikipedia|百度百科|萌娘百科|bangumi|番组计划|豆瓣|dmhy|bilibili|哔哩哔哩|acfun|anilist|myanimelist|mal|fandom|wiki|anidb|动漫之家|巴哈姆特|维基|百科)[^]*$/i,
  /\s*[-|｜–—_]\s*(?:动画|動畫|动漫|番剧|在线观看|免费观看)[^]*$/i
];

function cleanGoogleTitle(raw: string): string {
  let s = (raw || '').replace(/_/g, ' ').trim();
  for (const re of GOOGLE_NOISE) s = s.replace(re, '');
  return s
    .replace(/[（(]\s*(?:动画|動畫|动漫|番剧)\s*[）)]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[-|｜–—_]\s*$/, '')
    .trim();
}

async function googleSearch(q: string, key: string, cx: string): Promise<WebTitleHit[]> {
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&num=8&safe=off&q=${encodeURIComponent(`${q} 动画 番剧`)}`;
  const json = await httpJson<{ items?: Array<{ title?: string }> }>(url, googleLimiter, {
    retries: 0,
    missStatus: [400, 401, 403, 404, 429]
  });
  const items = json?.items ?? [];
  const hits: WebTitleHit[] = [];
  items.forEach((it, i) => {
    const title = cleanGoogleTitle(it.title ?? '');
    if (!title || title.length < 2 || title.length > 80) return;
    if (!CJK.test(title)) return;
    hits.push({
      title,
      aliases: [],
      year: null,
      month: null,
      source: 'Google',
      prior: Number(Math.max(0.6, 0.9 - i * 0.04).toFixed(3))
    });
  });
  return hits;
}

/* =========================================================
   缓存包装（委托给 Store，避免重复联网）
   ========================================================= */

export interface WebCachePort {
  getCached<T>(key: string): Promise<T | null>;
  setCached(key: string, value: unknown): Promise<void>;
}

export async function webResolveTitlesCached(
  query: string,
  store: WebCachePort | null,
  opts: WebSearchOptions & { persistCache?: boolean }
): Promise<WebTitleHit[]> {
  const key = `web:${aliasKey(query)}`;
  if (store) {
    const cached = await store.getCached<CacheBox>(key);
    if (cached && Array.isArray(cached.hits) && Date.now() - (cached.at ?? 0) < CACHE_TTL_MS) {
      if (cached.hits.length) opts.onLog?.(`♻ 网页检索命中本地缓存：${query}`);
      return cached.hits;
    }
  }
  const hits = await webResolveTitles(query, opts);
  if (store && opts.persistCache !== false) {
    await store.setCached(key, { at: Date.now(), hits } satisfies CacheBox);
  }
  return hits;
}
