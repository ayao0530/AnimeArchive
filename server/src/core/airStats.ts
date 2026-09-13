/**
 * 「播出月份」统计口径（媒体库 📊 统计与图表用）
 *
 * 归档目录是 `{年份}\{月份}\{番剧名}\`，但**月份桶不能简单地"每个文件夹算 1 部"**，
 * 否则月度分布会失真。这里实现三条口径（用户 2026-09-13 明确要求）：
 *
 *  1. **集数 ≤ 3 的不纳入统计** —— 这种通常是零散/不完整的归档
 *     （例：`2026\04\又被杀掉了呢，侦探大人` 只有 2 集），会把月份分布带偏。
 *  2. **集数 > 14 且在 1/4/7/10 月播出的，按季度重复计入** —— 半年番/年番在下一季仍在播，
 *     当季统计不该漏掉它（例：`2026\04\Re：从零开始的异世界生活 第四季 丧失篇` 16 集 ⇒ 04 与 07 都计入）。
 *     跨几个季度 = `ceil(集数 / 14)`（约 14 集/季：16⇒2、24⇒2、36⇒3、52⇒4，最多 4 季）。
 *     ⚠ 起点不是季度月（如 2 月）的一律**不处理**，按原样只计入自己那个月
 *     （例：`2026\02\名侦探光之美少女！` 33 集 —— 常年番，跨季分摊没有意义）。
 *  3. **集数 ≠ 文件数** —— `[FLsnow][Star-Detective_Precure][05][1080p]` 这种子目录里可能有 3 个文件
 *     （正片 + 字体/章节等），它只该算 **1 集**。所以：
 *     `集数 = 顶层视频文件数 + 子目录数`，其中 `SP` / `OP&ED` 子目录**不算集数**。
 *
 * 年份桶：同一部番剧在**同一年内只计一次**（跨季只跨年时才同时出现在两年的年份桶里）。
 */
import { LibraryAnime, LibraryFile, MonthStat, YearStat } from '../types';

/** 集数 ≤ 3 的番剧不纳入统计 */
export const MIN_EPISODES = 4;
/** 集数 > 14 才做跨季度分摊 */
export const SPREAD_THRESHOLD = 14;
/** 一季按 14 集算（12~13 集的一季番不跨季，15 集起跨 2 季） */
export const EPISODES_PER_COUR = 14;
/** 最多跨 4 个季度 */
const MAX_COURS = 4;
/** 只有这些月份（季度起点）播出的番剧才做跨季分摊 */
const QUARTER_MONTHS = [1, 4, 7, 10];
/** 这些子目录不算「集」（SP / OP&ED 是特典，不是正片） */
const NON_EPISODE_SUB_DIRS = ['sp', 'op&ed'];

/**
 * 集数：**顶层视频文件** + **子目录数**（每个子目录算 1 集）。
 * ⚠ 不能用「文件总数」：一个字幕组的多文件发布目录会被算成好几集；
 *   也不能让 SP / OP&ED 之类的特典子目录抬高集数。
 */
export function animeEpisodes(a: LibraryAnime): number {
  const topVideos = a.files.filter(f => f.type === 'video').length;
  const epDirs = (a.subDirs ?? []).filter(
    s => !NON_EPISODE_SUB_DIRS.includes((s.dir ?? '').trim().toLowerCase())
  ).length;
  return topVideos + epDirs;
}

/** 索引里的 `episodes` 不可信/未计算（缺失或 ≤0）时现算 —— ⚠ 别把「未计算」当成「0 集」 */
export function resolvedEpisodes(a: LibraryAnime): number {
  const cached = a.episodes;
  return typeof cached === 'number' && cached > 0 ? cached : animeEpisodes(a);
}

/** 该番剧要计入哪些「年-月」桶 */
export function attributedMonths(a: LibraryAnime, episodes: number): Array<{ year: number; month: number }> {
  const base = { year: a.year as number, month: a.month ?? 0 };
  if (episodes <= SPREAD_THRESHOLD) return [base];
  if (!QUARTER_MONTHS.includes(base.month)) return [base];

  const cours = Math.min(MAX_COURS, Math.max(2, Math.ceil(episodes / EPISODES_PER_COUR)));
  const out: Array<{ year: number; month: number }> = [];
  let year = base.year;
  let month = base.month;
  for (let i = 0; i < cours; i++) {
    out.push({ year, month });
    month += 3;
    if (month > 12) { month -= 12; year += 1; }
  }
  return out;
}

export interface AirStats {
  /** 播出月份桶（年降序 → 月降序）；跨季番剧会在多个桶里各出现一次 */
  months: MonthStat[];
  /** 年份桶（年降序）；同年内同一部番剧只计一次 */
  years: YearStat[];
  /** 被口径排除的番剧数（集数 < MIN_EPISODES） */
  excludedShort: number;
  /** 做了跨季分摊的番剧数 */
  spreadCount: number;
}

function filesOf(a: LibraryAnime): LibraryFile[] {
  return [...a.files, ...(a.subDirs ?? []).flatMap(s => s.files)];
}

export function computeAirStats(anime: LibraryAnime[]): AirStats {
  const byMonth = new Map<string, MonthStat>();
  const byYear = new Map<number, YearStat>();
  let excludedShort = 0;
  let spreadCount = 0;

  anime.filter(a => !a.special && a.year !== null).forEach(a => {
    const episodes = resolvedEpisodes(a);
    if (episodes < MIN_EPISODES) { excludedShort += 1; return; }

    const months = attributedMonths(a, episodes);
    if (months.length > 1) spreadCount += 1;

    const fs = filesOf(a);
    const fileCount = fs.length;
    const totalSize = fs.reduce((x, f) => x + f.size, 0);

    months.forEach(({ year, month }) => {
      const key = `${year}-${month}`;
      const cur = byMonth.get(key)
        ?? { year, month, animeCount: 0, fileCount: 0, totalSize: 0, episodeCount: 0 };
      cur.animeCount += 1;
      cur.fileCount += fileCount;
      cur.totalSize += totalSize;
      cur.episodeCount += episodes;
      byMonth.set(key, cur);
    });

    // 年份桶：同一年内去重（跨季跨年时才同时进两个年份）
    new Set(months.map(m => m.year)).forEach(year => {
      const cur = byYear.get(year)
        ?? { year, animeCount: 0, fileCount: 0, totalSize: 0, episodeCount: 0 };
      cur.animeCount += 1;
      cur.fileCount += fileCount;
      cur.totalSize += totalSize;
      cur.episodeCount += episodes;
      byYear.set(year, cur);
    });
  });

  return {
    months: Array.from(byMonth.values()).sort((a, b) => (b.year - a.year) || (b.month - a.month)),
    years: Array.from(byYear.values()).sort((a, b) => b.year - a.year),
    excludedShort,
    spreadCount
  };
}
