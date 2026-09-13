/**
 * 同组聚类（《需求与设计文档》2.1 / 3.3）
 *
 * 判定依据：
 *   1. 归一化后的番剧名相同 → 同一组
 *   2. 季度/续作不同 → 不同组
 *   3. 同名不同作品 → 强制人工确认（由 normalizer 的歧义检测标记 needReview）
 *   4. 集数不参与分组
 */
import { AnimeGroup, GroupItem, ScanItem, GroupStatus, Resolution } from '../types';
import { parseName, seasonNumber } from './parser';
import { normalizeName, NormalizeOptions } from './normalizer';
import { Store } from './store';
import { aliasKey } from '../util/text';
import { TimeHint } from '../util/timesignal';
import { mapLimit } from '../util/pool';

export interface GroupOptions extends NormalizeOptions {
  onProgress?: (info: { done: number; total: number; current: string }) => void;
  onLog?: (msg: string) => void;
  /**
   * 归一化并发度（默认 6）。
   * 名称解析是「网络等待为主」：并发跑起来后，命中本地缓存/别名表的条目
   * 不必排在慢的在线查询后面，整体明显更快（在线请求本身仍受各站限流约束）。
   */
  normalizeConcurrency?: number;
}

export async function groupItems(
  items: ScanItem[],
  store: Store,
  opts: GroupOptions
): Promise<AnimeGroup[]> {
  const groupMap = new Map<string, AnimeGroup>();
  const total = items.length;

  // 先解析一遍名称，并统计「同一番剧名（含季数）」的最早/最晚文件修改时间。
  // 这个时间区间是判断首播季的重要旁证（首播不可能晚于下载时间），
  // 且以**最早**的那个文件为准：周更的剧集里第 1 集的时间最接近首播。
  const parsedItems = items.map(item => ({ item, parsed: parseName(item.name, item.isDir) }));
  const timeHints = new Map<string, TimeHint>();
  const hintKey = (raw: string, season: string | null): string => `${aliasKey(raw)}|${aliasKey(season ?? '')}`;

  for (const { item, parsed } of parsedItems) {
    if (!parsed.animeRawName) continue;
    const t = Date.parse(item.mtime);
    if (!Number.isFinite(t)) continue;
    const k = hintKey(parsed.animeRawName, parsed.seasonHint);
    const cur = timeHints.get(k);
    if (!cur) timeHints.set(k, { earliestMs: t, latestMs: t });
    else {
      cur.earliestMs = Math.min(cur.earliestMs, t);
      cur.latestMs = Math.max(cur.latestMs, t);
    }
  }

  /* ---------- 归一化（并发执行） ----------
   * 关键优化：同一部作品的所有文件只归一化**一次**（先按 key 去重），再并发跑。
   * 这样既不会重复联网，也不会让「命中本地缓存/别名表」的快条目
   * 卡在慢条目的网络等待后面。
   */
  const keyToEntry = new Map<string, { rawName: string; seasonHint: string | null; name: string }>();
  for (const { item, parsed } of parsedItems) {
    if (!parsed.recognized || !parsed.animeRawName) continue;
    const k = hintKey(parsed.animeRawName, parsed.seasonHint);
    if (!keyToEntry.has(k)) {
      keyToEntry.set(k, { rawName: parsed.animeRawName, seasonHint: parsed.seasonHint, name: item.name });
    }
  }

  const resolutions = new Map<string, Resolution | null>();
  const tasks = Array.from(keyToEntry.entries());
  await mapLimit(
    tasks,
    Math.max(1, opts.normalizeConcurrency ?? 6),
    async ([key, entry]) => {
      try {
        resolutions.set(
          key,
          await normalizeName(entry.rawName, store, opts, entry.seasonHint, timeHints.get(key) ?? null)
        );
      } catch (err) {
        opts.onLog?.(`⚠ 归一化失败（${entry.rawName}）：${(err as Error).message}`);
        resolutions.set(key, null);
      }
    },
    (completed, count) => {
      const cur = tasks[completed - 1]?.[1]?.name ?? '';
      opts.onProgress?.({ done: completed, total: count, current: cur });
    }
  );

  /* ---------- 分组（纯内存，同步完成） ---------- */
  for (const { item, parsed } of parsedItems) {
    const groupItem: GroupItem = { scanItem: item, parsed };
    const resolution =
      parsed.recognized && parsed.animeRawName
        ? resolutions.get(hintKey(parsed.animeRawName, parsed.seasonHint)) ?? null
        : null;

    const zhName = resolution?.officialZhName ?? '';
    const recognizedOk = parsed.recognized && !!zhName;

    // 分组键：归一化名 + 季数提示 + 类型族（剧场版独立成组）
    const mediaFamily = parsed.mediaType === 'MOVIE' ? 'movie' : 'series';
    const seasonKey = parsed.seasonHint ? aliasKey(parsed.seasonHint) : '';
    // 未识别时尽量按「番剧名主干」聚合，避免同一部作品的多个文件被拆成一堆单文件组
    const unknownKey = parsed.animeRawName ? aliasKey(parsed.animeRawName) : aliasKey(item.name);
    const baseKey = recognizedOk
      ? `${aliasKey(zhName)}|${seasonKey}|${mediaFamily}`
      : `__unrecognized__|${unknownKey}`;
    const rawKey = parsed.animeRawName
      ? `${aliasKey(parsed.animeRawName)}|${seasonKey}`
      : aliasKey(item.name);

    let group = groupMap.get(baseKey);
    if (!group) {
      group = {
        groupId: `g${groupMap.size + 1}`,
        rawNames: [],
        zhName,
        rawKey,
        aliasQuery: buildAliasQuery(parsed, item.name),
        year: resolution?.year ?? null,
        month: resolution?.month ?? null,
        items: [],
        episodes: [],
        totalSize: 0,
        releaseGroup: parsed.releaseGroup,
        resolution,
        status: 'ready',
        note: null
      };
      groupMap.set(baseKey, group);
    }

    if (parsed.animeRawName && !group.rawNames.includes(parsed.animeRawName)) {
      group.rawNames.push(parsed.animeRawName);
    }
    // 补充别名写回键（同一组内可能出现不同写法）
    if (parsed.animeRawName) {
      buildAliasQuery(parsed, item.name).forEach(q => {
        if (!group.aliasQuery.includes(q)) group.aliasQuery.push(q);
      });
    }
    group.items.push(groupItem);
    group.totalSize += item.size;
    if (!group.releaseGroup && parsed.releaseGroup) group.releaseGroup = parsed.releaseGroup;
    if (parsed.episode && !group.episodes.includes(parsed.episode)) group.episodes.push(parsed.episode);
    // 置信度取较低者，保证「任一项不确定 → 整组待确认」
    if (group.resolution && resolution && resolution.confidence < group.resolution.confidence) {
      group.resolution = resolution;
      group.year = resolution.year;
      group.month = resolution.month;
    }
  }

  /* ---------- 状态判定 ---------- */
  const groups = Array.from(groupMap.values());
  for (const g of groups) {
    g.status = decideStatus(g, opts);
    g.note = noteOf(g, opts);
    g.episodes.sort(compareEpisode);
  }
  return groups;
}

function decideStatus(g: AnimeGroup, opts: GroupOptions): GroupStatus {
  const res = g.resolution;
  if (!res || !res.officialZhName) return 'unrecognized';
  if (res.needReview || res.confidence < opts.autoThreshold) return 'review';
  if (res.year === null || res.month === null) return 'review';
  return 'ready';
}

function noteOf(g: AnimeGroup, opts: GroupOptions): string | null {
  const res = g.resolution;
  if (!res || !res.officialZhName) {
    return '未能从文件名中提取有效番剧名，将移入 _未识别/，不会误归档';
  }
  if (res.matchLevel === 'L3' && res.candidates.length > 1) {
    const top2 = res.candidates.slice(0, 2).map(c => `${c.name}（${(c.score * 100).toFixed(0)}%）`);
    return `在线库存在多个候选译名：${top2.join(' / ')}，建议人工确认`;
  }
  if (res.confidence < opts.autoThreshold && res.confidence >= opts.reviewThreshold) {
    return `置信度 ${(res.confidence * 100).toFixed(0)}% 低于自动阈值 ${(opts.autoThreshold * 100).toFixed(0)}%，需人工确认`;
  }
  if (!res.needReview && (g.year === null || g.month === null)) {
    return '缺少首播年份或月份（Bangumi 无首播日期），需人工确认';
  }
  return null;
}

/**
 * 人工确认后需要写回别名表的「原始名称」列表。
 *
 * ⚠ 续作（S02 及以上）**只写带季数的键**：
 * 若连裸标题一起写，`Yuru Camp` 会被绑定到第二季，导致第一季文件被错误归档。
 */
export function buildAliasQuery(
  parsed: { animeRawName: string; seasonHint: string | null },
  fallbackName: string
): string[] {
  const name = parsed.animeRawName?.trim();
  if (!name) return [fallbackName];
  const num = seasonNumber(parsed.seasonHint);
  if (parsed.seasonHint && num !== null && num > 1) {
    return [`${name} ${parsed.seasonHint}`];
  }
  return parsed.seasonHint ? [`${name} ${parsed.seasonHint}`, name] : [name];
}

export function compareEpisode(a: string, b: string): number {
  const norm = (s: string): [number, string, number] => {
    const m = String(s).match(/^([A-Za-z]*)(\d+)?(v(\d))?$/);
    if (!m) return [999, String(s), 0];
    const kindRank = m[1] ? 100 : 0;
    return [kindRank + Number(m[2] ?? 0), m[1] ?? '', Number(m[4] ?? 0)];
  };
  const [na, sa, va] = norm(a);
  const [nb, sb, vb] = norm(b);
  if (na !== nb) return na - nb;
  if (sa !== sb) return sa.localeCompare(sb);
  return va - vb;
}
