/**
 * 递归扫描（《需求与设计文档》1.3 / 2.4）
 *
 * 规则：
 *  - 扫描 NAS 共享根目录，**排除归档根目录及其所有子目录**（用绝对路径归一化后判断）
 *  - 只收集「视频文件」与「文件夹」
 *  - 非视频文件忽略
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ScanItem } from '../types';
import { DEFAULT_FS_CONCURRENCY, VIDEO_EXTS, isInside, measureDir, normalizePath, toLongPath } from '../fsx/fsx';
import { Semaphore } from '../util/pool';
import { parseName } from './parser';

export interface ScanOptions {
  /** 源目录 */
  sourceRoot: string;
  /** 归档根目录（排除） */
  excludeRoot?: string;
  /** 进度回调 */
  onProgress?: (info: { scanned: number; current: string }) => void;
  /** 最大扫描条目（保护，0 = 不限） */
  limit?: number;
  /** 最大递归深度（默认 4） */
  maxDepth?: number;
  /**
   * 文件系统并发度（默认 10）。
   * NAS 上单次操作是一次网络往返，串行会非常慢；10 路并发通常快数倍。
   */
  concurrency?: number;
}

/** 明显的「容器型」目录名：不是番剧，需要继续向下递归 */
const CONTAINER_DIR = /^(?:[0-9]{4}(?:[\s\-年]|$)|[0-9]{4}[春夏秋冬]|新番|未整理|未归档|待整理|downloads?|torrents?|bt|已完成|other|misc|temp|tmp|anime|番剧|动漫|视频|media|videos?|.*(?:合集|合辑|收藏|整理))$/i;

export interface ScanResult {
  sourceRoot: string;
  items: ScanItem[];
  files: number;
  dirs: number;
  skippedNonVideo: number;
  /** 归档根目录内的文件夹/文件数量（被排除的） */
  excluded: number;
}

let idSeed = 0;
export function nextId(prefix = 'i'): string {
  idSeed += 1;
  return `${prefix}${Date.now().toString(36)}${idSeed.toString(36)}`;
}

/**
 * stat 的时间戳（毫秒）→ ISO 字符串。
 *
 * `primary <= 0` 表示该文件系统不提供这个时间（部分文件系统 / SMB 实现没有创建时间），
 * 此时退化为 `fallback`；两者都不可用时返回空串（**不要退化成"当前时间"**，
 * 否则界面会显示错误的时间、时间线索也会拿到一个假的"未来"信号）。
 */
function isoTime(primary: number | undefined, fallback: number | undefined): string {
  const ms = Number.isFinite(primary) && (primary as number) > 0
    ? (primary as number)
    : Number.isFinite(fallback) ? (fallback as number) : 0;
  return ms > 0 ? new Date(ms).toISOString() : '';
}

/**
 * 扫描源目录中除归档根目录以外的所有视频文件与文件夹。
 *
 * 移动单元（ScanItem）的判定：
 *  - 视频文件 → 一定是一个单元
 *  - 文件夹 → 若**文件夹名本身能识别出番剧名**（如 `[Lilith-Raws] Full Dive - 03 [...]`），
 *             则整个文件夹作为一个整体移动，不拆散内部文件（R-3）；
 *             否则视为「容器目录」（如 `2024春番`、`未整理`），继续向下递归。
 *  - 归档根目录及其所有子目录一律排除。
 */
export async function scanSource(opts: ScanOptions): Promise<ScanResult> {
  const sourceRoot = normalizePath(opts.sourceRoot);
  const excludeRoot = opts.excludeRoot ? normalizePath(opts.excludeRoot) : '';
  const limit = opts.limit ?? 0;
  const maxDepth = opts.maxDepth ?? 4;
  const sem = new Semaphore(Math.max(1, opts.concurrency ?? DEFAULT_FS_CONCURRENCY));

  /** 整个子树的扫描产物（按目录顺序拼接，保证每次扫描的条目顺序稳定） */
  interface SubResult {
    items: ScanItem[];
    files: number;
    dirs: number;
    skippedNonVideo: number;
    excluded: number;
  }
  const emptySub = (): SubResult => ({ items: [], files: 0, dirs: 0, skippedNonVideo: 0, excluded: 0 });

  let scanned = 0;

  const rootStat = await fsp.stat(toLongPath(sourceRoot)).catch(() => null);
  if (!rootStat || !rootStat.isDirectory()) {
    throw new Error(`源目录不存在或不可访问：「${sourceRoot}」`);
  }

  const walk = async (dir: string, depth: number): Promise<SubResult> => {
    const out = emptySub();
    const entries = await sem
      .run(() => fsp.readdir(toLongPath(dir), { withFileTypes: true }))
      .catch(err => {
        if (depth === 0) throw new Error(`无法读取源目录「${dir}」：${(err as Error).message}`);
        return [] as fs.Dirent[];
      });

    // 同一目录下的条目**并发**处理；结果按原下标回填，保证顺序稳定
    const sub = await Promise.all(
      entries.map((e, idx) => processEntry(e, idx, out, dir, depth))
    );
    // 按目录顺序合并（并发子目录之间也按名字顺序拼接）
    sub.sort((a, b) => a.idx - b.idx);
    for (const r of sub) {
      out.items.push(...r.items);
      out.files += r.files;
      out.dirs += r.dirs;
      out.skippedNonVideo += r.skippedNonVideo;
      out.excluded += r.excluded;
    }
    return out;
  };

  /** 处理单个条目；`out` 只用于汇总「本层」的排除计数（顺序不影响正确性） */
  const processEntry = async (
    e: fs.Dirent,
    idx: number,
    out: SubResult,
    dir: string,
    depth: number
  ): Promise<{ idx: number } & SubResult> => {
    const r: { idx: number } & SubResult = { idx, ...emptySub() };
    if (limit && scanned >= limit) return r;

    const full = path.join(dir, e.name);

    // 排除归档根目录自身及其所有子目录
    if (excludeRoot && isInside(full, excludeRoot)) {
      out.excluded++;
      return r;
    }

    scanned++;
    opts.onProgress?.({ scanned, current: e.name });

    if (e.isDirectory()) {
      // measureDir 顺带告诉我们「顶层有没有视频文件」，不再单独 readdir 一次
      const { size, count, hasDirectVideo } = await measureDir(full, sem);
      const parsed = parseName(e.name, true);
      const isContainer =
        !parsed.recognized ||
        parsed.animeRawName.length < 2 ||
        (!hasDirectVideo && depth < maxDepth);

      if (isContainer && depth < maxDepth) {
        return { idx, ...(await walk(full, depth + 1)) };
      }

      const st = await sem.run(() => fsp.stat(toLongPath(full))).catch(() => null);
      r.items.push({
        id: nextId('d'),
        path: full,
        name: e.name,
        isDir: true,
        size,
        childCount: count,
        mtime: isoTime(st?.mtimeMs, st?.ctimeMs),
        btime: isoTime(st?.birthtimeMs, st?.mtimeMs)
      });
      r.dirs++;
      return r;
    }

    if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!VIDEO_EXTS.has(ext)) {
        r.skippedNonVideo++;
        return r;
      }
      const st = await sem.run(() => fsp.stat(toLongPath(full))).catch(() => null);
      r.items.push({
        id: nextId('f'),
        path: full,
        name: e.name,
        isDir: false,
        size: st ? st.size : 0,
        childCount: 0,
        mtime: isoTime(st?.mtimeMs, st?.ctimeMs),
        btime: isoTime(st?.birthtimeMs, st?.mtimeMs)
      });
      r.files++;
      return r;
    }

    return r;
  };

  const res = await walk(sourceRoot, 0);

  return {
    sourceRoot,
    items: res.items,
    files: res.files,
    dirs: res.dirs,
    skippedNonVideo: res.skippedNonVideo,
    excluded: res.excluded
  };
}

/**
 * 扫描媒体库（已看/Anime），**不做排除**，供 indexer 使用。
 * 返回顶层条目（年份目录 / _未识别 / _待确认 等）。
 */
export async function readRootEntries(dir: string): Promise<Array<{ name: string; isDir: boolean; path: string }>> {
  const list = await fsp.readdir(toLongPath(dir), { withFileTypes: true }).catch(() => []);
  return list.map(e => ({
    name: e.name,
    isDir: e.isDirectory(),
    path: path.join(dir, e.name)
  }));
}
