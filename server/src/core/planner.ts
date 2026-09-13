/**
 * 归档方案生成（《需求与设计文档》5.1 / 7.5 / 7.6 / 实施提示词 7.4）
 *
 * 目标路径：
 *   正常：      {归档根}\{年}\{月两位}\{官方中文名}\{原文件或文件夹}
 *   SP/OVA：    {归档根}\{年}\{月两位}\{官方中文名}\SP\{...}
 *   OP/ED/NC：  {归档根}\{年}\{月两位}\{官方中文名}\OP&ED\{...}
 *   未识别：    {归档根}\_未识别\{原名}\{...}
 *   待确认：    {归档根}\_待确认\{番剧名}\{...}
 */
import * as path from 'node:path';
import {
  AnimeGroup,
  ArchivePlan,
  EntryStatus,
  PlanEntry,
  PlanStats
} from '../types';
import { exists, sanitizePathSegment, toLongPath, joinWinPath } from '../fsx/fsx';
import { mapLimit } from '../util/pool';
import { pad2, sanitizeFileName } from '../util/text';
import * as fsp from 'node:fs/promises';

const UNRECOGNIZED_DIR = '_未识别';
const DEFERRED_DIR = '_待确认';

/**
 * 冲突检测的并发度。
 *
 * 每个条目都要 `stat` 一次目标路径，而 NAS 上这就是一次网络往返（~5~30ms）：
 * 8000 多个文件串行查要一分多钟，界面就会一直停在「尚未生成方案」。
 */
const CONFLICT_CONCURRENCY = 16;

export interface PlanOptions {
  sourceRoot: string;
  targetRoot: string;
  /** 是否检测目标冲突（需要访问文件系统；dry-run 也建议开启以给出真实预览） */
  detectConflicts?: boolean;
  /** 冲突检测并发度（默认 16） */
  concurrency?: number;
}

export async function buildPlan(
  groups: AnimeGroup[],
  opts: PlanOptions
): Promise<ArchivePlan> {
  const entries: PlanEntry[] = [];
  const targetRoot = opts.targetRoot.replace(/[\\/]+$/, '');
  let entrySeq = 0;
  /**
   * 待做冲突检测的条目。
   *
   * 分两步走：先**同步**把全部目标路径算出来，再**并发**批量查存在性。
   * 以前是「算一个查一个（await）」，8000 多个文件就是 8000 多次串行的网络往返，
   * 在 NAS 上要一分多钟，界面一直卡在「尚未生成方案」。
   */
  const checks: Array<{ index: number; toPath: string; isDir: boolean }> = [];

  /**
   * 快速通道：归档根目录**是空的** → 不可能有同名冲突，直接跳过全部存在性检查。
   *
   * NAS 上一次 stat 就是一次网络往返（实测 25ms 以上），8286 个条目串行查要几分钟，
   * 而首次归档时目标目录本来就空 —— 一次 readdir 就能省掉 8000 多次往返。
   * （即使目标根为空，也只需要读一层：里面的年月/番剧目录属于它内部，不会与根目录同级。）
   */
  let detectConflicts = opts.detectConflicts !== false;
  if (detectConflicts) {
    const top = await fsp.readdir(toLongPath(targetRoot)).catch(() => null);
    if (top && top.length === 0) detectConflicts = false;
  }

  for (const g of groups) {
    const relDir = relativeTargetDir(g);
    for (const gi of g.items) {
      const originalName = gi.scanItem.name;
      const targetName = gi.renameTo || originalName;
      const parts = [targetRoot];
      if (relDir) parts.push(relDir);
      if (gi.parsed.subDir) parts.push(gi.parsed.subDir);
      parts.push(targetName);
      // ⚠ 必须用 joinWinPath：普通 join + 压斜杠会把 UNC 的 `\\` 压成一个，
      //   导致 `\\NAS\share\Anime\…` 变成 `\NAS\share\…`（= 当前盘符！）
      const toPath = joinWinPath(...parts);

      let status: EntryStatus = g.status;
      let conflictType: PlanEntry['conflictType'] = 'none';
      let action: PlanEntry['action'] = 'move';
      const noteParts: string[] = [];

      if (gi.scanItem.isDir) {
        noteParts.push(`文件夹 · 内含 ${gi.scanItem.childCount} 个文件（整体移动，不拆散）`);
      }
      if (gi.parsed.subDir === 'SP') noteParts.push('→ 单独存入 SP/ 子目录');
      if (gi.parsed.subDir === 'OP&ED') noteParts.push('→ 单独存入 OP&ED/ 子目录');

      /* ---- 冲突检测：只登记，稍后并发查 ---- */
      if ((status === 'ready' || status === 'review') && detectConflicts) {
        if (normalizeKey(gi.scanItem.path) === normalizeKey(toPath)) {
          status = 'skipped';
          action = 'skip';
          noteParts.push('源路径与目标路径相同，已跳过（避免自我移动）');
        } else {
          checks.push({ index: entries.length, toPath, isDir: gi.scanItem.isDir });
        }
      }

      // 跳过 / 未识别 / 待确认 的条目不动
      if (status === 'unrecognized' || status === 'skipped' || status === 'deferred') {
        action = status === 'skipped' ? 'skip' : 'move';
      }

      entries.push({
        entryId: `e${++entrySeq}`,
        groupId: g.groupId,
        fromPath: gi.scanItem.path,
        toPath,
        name: originalName,
        targetName,
        isDir: gi.scanItem.isDir,
        size: gi.scanItem.size,
        action,
        status,
        conflictType,
        note: noteParts.length ? noteParts.join('；') : null,
        subDir: gi.parsed.subDir,
        episode: gi.parsed.episode,
        mediaType: gi.parsed.mediaType,
        relTargetDir: relDir
      });
    }
  }

  /* ---- 并发查存在性，回填冲突状态 ---- */
  const conc = Math.max(1, Math.min(opts.concurrency ?? CONFLICT_CONCURRENCY, 32));
  await mapLimit(checks, conc, async c => {
    if (!(await exists(c.toPath))) return;
    const e = entries[c.index];
    if (!e) return;
    e.status = 'conflict';
    e.conflictType = 'sameName';
    const msg = `目标目录已存在同名${c.isDir ? '文件夹' : '文件'}，默认自动重命名为 " (1)"`;
    e.note = e.note ? `${e.note}；${msg}` : msg;
  });

  const stats = computeStats(entries);

  // 把「冲突」结果同步回分组状态，便于界面卡片直接展示与处理
  for (const g of groups) {
    if (g.status !== 'ready' && g.status !== 'review') continue;
    const own = entries.filter(e => e.groupId === g.groupId);
    if (own.some(e => e.status === 'conflict')) g.status = 'conflict';
    else if (own.some(e => e.status === 'skipped')) g.status = 'skipped';
  }

  return {
    planId: `plan-${Date.now()}`,
    createdAt: new Date().toISOString(),
    sourceRoot: opts.sourceRoot,
    targetRoot,
    groups,
    entries,
    stats
  };
}

/** 目标相对目录（相对归档根目录） */
export function relativeTargetDir(g: AnimeGroup): string {
  if (g.status === 'unrecognized') {
    const base = g.items[0]?.scanItem.name ?? 'unknown';
    const stem = base.replace(/\.[^.]+$/, '');
    return `${UNRECOGNIZED_DIR}\\${sanitizeName(stem)}`;
  }
  if (g.status === 'deferred') {
    return `${DEFERRED_DIR}\\${sanitizeName(g.zhName || g.rawNames[0] || '未确认')}`;
  }
  if (g.year === null || g.month === null) {
    return `${DEFERRED_DIR}\\${sanitizeName(g.zhName || '未确认')}`;
  }
  return `${g.year}\\${pad2(g.month)}\\${sanitizeName(g.zhName)}`;
}

function sanitizeName(name: string): string {
  return sanitizePathSegment(sanitizeFileName(name)) || '未命名';
}

export function computeStats(entries: PlanEntry[]): PlanStats {
  const count = (s: EntryStatus): number => entries.filter(e => e.status === s).length;
  return {
    total: entries.length,
    totalSize: entries.reduce((a, e) => a + e.size, 0),
    ready: count('ready'),
    review: count('review'),
    conflict: count('conflict'),
    unrecognized: count('unrecognized'),
    deferred: count('deferred'),
    skipped: count('skipped')
  };
}

function normalizeKey(p: string): string {
  return toLongPath(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 确保归档根目录存在且可写（不修改任何源文件） */
export async function ensureTargetRoot(targetRoot: string): Promise<void> {
  await fsp.mkdir(toLongPath(targetRoot), { recursive: true });
}

/** 计算条目目标所在目录 */
export function targetDirOf(entry: PlanEntry, targetRoot: string): string {
  return path.dirname(entry.toPath) || targetRoot;
}
