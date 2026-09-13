/**
 * 媒体库索引生成（《需求与设计文档》8.2 / 8.9 / 7.8 ~ 7.10）
 *
 * 索引来源目录：`已看\Anime`（与归档目标同一目录）
 * 产出：`library.json` + `library.js`（供 file:// 双击打开时用 <script> 读取）
 *
 * 说明：不调 ffprobe（无时长）、不下载封面，索引生成只需一次本地目录遍历。
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  LibraryAnime,
  LibraryFile,
  LibraryIndex,
  LibraryStats,
  LibrarySubDir,
  MonthStat,
  YearStat
} from '../types';
import { VIDEO_EXTS, toLongPath, DEFAULT_FS_CONCURRENCY } from '../fsx/fsx';
import { Semaphore } from '../util/pool';
import { compareByEpisode, parseName } from './parser';
import { Store } from './store';

export const SPECIAL_DIRS = ['_未识别', '_待确认'];

/** 索引遍历的全局并发阀（同上：单次 stat 在 NAS 上是一个网络往返，并发才能提速） */
const IO_SEM = new Semaphore(DEFAULT_FS_CONCURRENCY);

export interface IndexOptions {
  libraryRoot: string;
  /** 索引写出目录（网站目录），可多个 */
  siteDirs: string[];
  onLog?: (msg: string) => void;
}

export async function buildLibraryIndex(store: Store, opts: IndexOptions): Promise<LibraryIndex> {
  const root = opts.libraryRoot;
  const originMap = await store.allMoveLogs();
  const aliases = store.getAliasesRaw().entries;

  const anime: LibraryAnime[] = [];
  const yearsMap = new Map<number, Map<number, string[]>>();
  let seq = 0;

  const topEntries = await readDir(root);

  for (const top of topEntries) {
    if (!top.isDir) continue;

    if (top.name.startsWith('_')) {
      // 特殊目录（_未识别 / _待确认）→ 单个灰色分组
      const animeEntry = await buildSpecial(store, root, top.name, originMap, () => ++seq);
      if (animeEntry) anime.push(animeEntry);
      continue;
    }

    if (!/^\d{4}$/.test(top.name)) {
      // 非年份目录也作为特殊目录处理（不参与图表统计）
      const animeEntry = await buildSpecial(store, root, top.name, originMap, () => ++seq);
      if (animeEntry) anime.push(animeEntry);
      continue;
    }

    const year = Number(top.name);
    const monthDirs = await readDir(path.join(root, top.name));
    for (const md of monthDirs) {
      if (!md.isDir) continue;
      const month = Number(md.name);
      const anchorDirs = await readDir(path.join(root, top.name, md.name));

      for (const ad of anchorDirs) {
        if (!ad.isDir) {
          // 年份/月份 下直接出现的松散文件 → 归到一个「未分类」条目
          continue;
        }
        const relPath = [top.name, md.name, ad.name].join('\\');
        const entry = await buildAnime(
          store,
          path.join(root, top.name, md.name),
          ad.name,
          relPath,
          Number.isFinite(month) ? month : null,
          year,
          aliases,
          originMap,
          () => ++seq
        );
        anime.push(entry);
        if (!yearsMap.has(year)) yearsMap.set(year, new Map());
        const m = yearsMap.get(year)!;
        const key = Number.isFinite(month) ? month : 0;
        if (!m.has(key)) m.set(key, []);
        m.get(key)!.push(entry.id);
      }
    }
  }

  /* ---------- 统计（特殊目录不参与） ---------- */
  const stats = computeStats(anime);

  const years = Array.from(yearsMap.entries())
    .map(([year, months]) => ({
      year,
      months: Array.from(months.entries())
        .map(([month, animeIds]) => ({ month, animeIds }))
        .sort((a, b) => b.month - a.month)
    }))
    .sort((a, b) => b.year - a.year);

  const index: LibraryIndex = {
    generatedAt: new Date().toISOString(),
    libraryRoot: root,
    years,
    anime,
    stats
  };

  const written = await store.writeLibraryIndex(index, opts.siteDirs);
  opts.onLog?.(`✅ 索引已生成：${index.stats.animeCount} 部 / ${index.stats.fileCount} 个文件 → ${written.join(', ')}`);
  return index;
}

/* ---------------- 组装 ---------------- */

async function buildAnime(
  store: Store,
  parentDir: string,
  animeName: string,
  relPath: string,
  month: number | null,
  year: number | null,
  aliases: Record<string, { zh: string; aliases?: string[]; bangumiId?: number | null }>,
  originMap: Map<string, string>,
  nextUid: () => number
): Promise<LibraryAnime> {
  const dir = path.join(parentDir, animeName);
  const { files, subDirs } = await collectFiles(dir, relPath, originMap, nextUid);

  const aliasEntry = findAlias(aliases, animeName);
  const alternateNames = aliasEntry
    ? Array.from(new Set([...(aliasEntry.aliases ?? [])].filter(Boolean))).slice(0, 8)
    : [];

  const totalSize = files.reduce((a, f) => a + f.size, 0)
    + subDirs.reduce((a, s) => a + s.files.reduce((x, f) => x + f.size, 0), 0);

  return {
    id: `a-${relPath.replace(/[\\/]/g, '-')}`,
    zhName: animeName,
    aliases: alternateNames,
    year,
    month,
    bangumiId: aliasEntry?.bangumiId ?? null,
    cover: '',
    relPath,
    totalSize,
    fileCount: files.length + subDirs.reduce((a, s) => a + s.files.length, 0),
    files,
    subDirs,
    special: false
  };
}

async function buildSpecial(
  store: Store,
  root: string,
  dirName: string,
  originMap: Map<string, string>,
  nextUid: () => number
): Promise<LibraryAnime | null> {
  const dir = path.join(root, dirName);
  const { files, subDirs } = await collectFiles(dir, dirName, originMap, nextUid, true);
  const all = [...files, ...subDirs.flatMap(s => s.files)];
  if (!all.length) return null;
  return {
    id: `sp-${dirName}`,
    zhName: dirName,
    aliases: [],
    year: null,
    month: null,
    bangumiId: null,
    cover: '',
    relPath: dirName,
    totalSize: all.reduce((a, f) => a + f.size, 0),
    fileCount: all.length,
    files,
    subDirs,
    special: true
  };
}

/** 收集目录内的文件与子目录（一级子目录作为 subDirs，更深层并入 subDirs 的 files） */
async function collectFiles(
  dir: string,
  relBase: string,
  originMap: Map<string, string>,
  nextUid: () => number,
  keepRelative = false
): Promise<{ files: LibraryFile[]; subDirs: LibrarySubDir[] }> {
  const files: LibraryFile[] = [];
  const subDirs: LibrarySubDir[] = [];
  const entries = await readDir(dir);
  const fileEntries = entries.filter(e => !e.isDir);
  const dirEntries = entries.filter(e => e.isDir);

  // 先并发取回所有文件属性，再按目录项原顺序装配，保证结果顺序稳定
  const got = await Promise.all(fileEntries.map(e => statEntry(dir, e.name, originMap)));
  for (const f of got) {
    files.push({ ...f, uid: `f${nextUid()}` });
  }
  // 装配完再按集数排序（见 compareByEpisode）：文件名序会把多字幕组各排成一堆
  files.sort(compareByEpisode);

  const subs = await Promise.all(
    dirEntries.map(e => collectFileTree(path.join(dir, e.name), originMap, nextUid, keepRelative))
  );
  for (let i = 0; i < dirEntries.length; i++) {
    // 子目录**本身**也可能是一整个被归档进来的文件夹（isDir 条目），
    // 所以它自己也会有一条移动日志 —— 拿它来判断能不能整体撤回 / 移动
    const subPath = path.join(dir, dirEntries[i].name);
    const subOrigin = Store.resolveOrigin(originMap, subPath);
    subDirs.push({
      dir: dirEntries[i].name,
      files: subs[i],
      fullPath: subPath,
      originPath: subOrigin,
      revertable: Boolean(subOrigin),
      totalSize: subs[i].reduce((a, f) => a + f.size, 0)
    });
  }

  return { files, subDirs };
}

/** 读取单个目录项的文件元信息（不分配 uid，由调用方按顺序分配） */
async function statEntry(
  dir: string,
  name: string,
  originMap: Map<string, string>,
  displayName?: string
): Promise<Omit<LibraryFile, 'uid'>> {
  const full = path.join(dir, name);
  const st = await IO_SEM.run(() => fsp.stat(toLongPath(full)).catch(() => null));
  const parsed = parseName(name, false);
  const origin = Store.resolveOrigin(originMap, full);
  return {
    name: displayName ?? name,
    fullPath: full,
    size: st ? st.size : 0,
    type: VIDEO_EXTS.has(path.extname(name).toLowerCase()) ? 'video' : 'other',
    episode: parsed.episode,
    originPath: origin,
    revertable: Boolean(origin),
    mtime: st ? new Date(st.mtimeMs).toISOString() : ''
  };
}

async function collectFileTree(
  dir: string,
  originMap: Map<string, string>,
  nextUid: () => number,
  keepRelative = false
): Promise<LibraryFile[]> {
  const out: LibraryFile[] = [];
  const entries = await readDir(dir);
  const dirEntries = entries.filter(e => e.isDir);
  const fileEntries = entries.filter(e => !e.isDir);

  const got = await Promise.all(
    fileEntries.map(e => statEntry(dir, e.name, originMap, keepRelative ? path.join(path.basename(dir), e.name) : undefined))
  );
  for (const f of got) out.push({ ...f, uid: `f${nextUid()}` });

  const subs = await Promise.all(
    dirEntries.map(e => collectFileTree(path.join(dir, e.name), originMap, nextUid, keepRelative))
  );
  for (const s of subs) out.push(...s);

  out.sort(compareByEpisode);   // 同 compareByEpisode 注释：按集数，不按文件名
  return out;
}

async function readDir(dir: string): Promise<Array<{ name: string; isDir: boolean }>> {
  const list = await IO_SEM.run(() => fsp.readdir(toLongPath(dir), { withFileTypes: true }).catch(() => []));
  return list.map(e => ({ name: e.name, isDir: e.isDirectory() }));
}

function findAlias(
  aliases: Record<string, { zh: string; aliases?: string[]; bangumiId?: number | null }>,
  zhName: string
): { zh: string; aliases?: string[]; bangumiId?: number | null } | null {
  const key = zhName.trim().toLowerCase();
  if (aliases[key]) return aliases[key];
  for (const v of Object.values(aliases)) {
    if (v.zh === zhName) return v;
  }
  return null;
}

/**
 * 统计（图表用）。**不含**特殊目录（`_未识别` / `_待确认`）。
 *
 * 同时给出两种粒度：`years`（按年份）与 `months`（按年+月）——
 * 归档目录本身就是 `{年份}\{月份}\` 两级，月度统计能看出「当季追番」的分布。
 */
export function computeStats(anime: LibraryAnime[]): LibraryStats {
  const normal = anime.filter(a => !a.special);
  const specials = anime.filter(a => a.special);
  const filesOf = (a: LibraryAnime): LibraryFile[] => [...a.files, ...a.subDirs.flatMap(s => s.files)];

  const allFiles = normal.flatMap(filesOf);
  const byYear = new Map<number, YearStat>();
  const byMonth = new Map<string, MonthStat>();
  normal.forEach(a => {
    if (a.year === null) return;
    const fs = filesOf(a);
    const fileCount = fs.length;
    const totalSize = fs.reduce((x, f) => x + f.size, 0);

    const cur = byYear.get(a.year) ?? { year: a.year, animeCount: 0, fileCount: 0, totalSize: 0 };
    cur.animeCount += 1;
    cur.fileCount += fileCount;
    cur.totalSize += totalSize;
    byYear.set(a.year, cur);

    // 月份缺失（手工建的目录等）归到 month = 0 的兜底桶，界面上显示为「YYYY-未知」
    const month = a.month ?? 0;
    const key = `${a.year}-${month}`;
    const mc = byMonth.get(key) ?? { year: a.year, month, animeCount: 0, fileCount: 0, totalSize: 0 };
    mc.animeCount += 1;
    mc.fileCount += fileCount;
    mc.totalSize += totalSize;
    byMonth.set(key, mc);
  });

  return {
    animeCount: normal.length,
    fileCount: allFiles.length,
    totalSize: allFiles.reduce((a, f) => a + f.size, 0),
    revertableCount: allFiles.filter(f => f.revertable).length,
    specialCount: specials.length,
    years: Array.from(byYear.values()).sort((a, b) => b.year - a.year),
    months: Array.from(byMonth.values()).sort((a, b) => (b.year - a.year) || (b.month - a.month))
  };
}
