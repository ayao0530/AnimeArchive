/**
 * 文件系统封装：长路径、非法字符、Move → Copy 降级、安全校验。
 * 对应《需求与设计提示词》第 10 章「已知坑」。
 */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { Semaphore } from '../util/pool';

/**
 * 文件系统并发度默认值。
 *
 * NAS（SMB）单次操作是「网络往返」而不是本地磁盘寻道，瓶颈在延迟。
 * 10 路并发能在不把 NAS 打满的前提下把等待重叠起来，实测快数倍。
 */
export const DEFAULT_FS_CONCURRENCY = 10;

export const VIDEO_EXTS = new Set([
  '.mp4', '.mkv', '.avi', '.wmv', '.flv', '.mov', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg',
  '.rmvb', '.rm', '.webm', '.vob', '.3gp', '.ogv', '.divx', '.asf'
]);

export const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|]/;

/** Windows 保留名 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** 归一化路径（绝对 + 统一分隔符），用于安全的「是否在归档根目录内」判断 */
export function normalizePath(p: string): string {
  let s = String(p ?? '').trim().replace(/\//g, '\\');
  s = s.replace(/\\+$/, '');
  if (!s) return '';
  const isUnc = s.startsWith('\\\\');
  let abs: string;
  try {
    abs = path.resolve(s);
  } catch {
    abs = s;
  }
  if (isUnc && !abs.startsWith('\\\\')) {
    abs = s; // 极端情况保底
  }
  return abs.replace(/\\+$/, '');
}

/** 加长路径前缀（仅当超过 259 字符时） */
export function toLongPath(p: string): string {
  const s = String(p ?? '');
  if (process.platform !== 'win32') return s;
  if (s.length <= 259) return s;
  if (s.startsWith('\\\\?\\')) return s;
  if (s.startsWith('\\\\')) return '\\\\?\\UNC\\' + s.slice(2);
  if (/^[a-zA-Z]:\\/.test(s)) return '\\\\?\\' + s;
  return s;
}

/**
 * 用 `\` 拼接路径片段，**并保住 UNC 前缀**。
 *
 * ⚠ 绝对不要图省事写成 `parts.join('\\').replace(/\\+/g, '\\')`：
 * 那会把 UNC 开头的 `\\server\share` **压成** `\server\share`，
 * 在 Windows 上会被解析成「当前盘符根目录」下的路径 ——
 * 也就是说 `\\NAS\share\Anime\…` 会静默变成 `<盘符>:\NAS\share\Anime\…`，
 * 文件被移动到了**本机磁盘**上，而且下次扫描还会因为「目标已存在」而报一堆假冲突。
 * 实测踩过一次：1076 个文件 / 384 GB 被移到了本地磁盘的 `<盘符>:\NAS\…`。
 */
export function joinWinPath(...parts: Array<string | null | undefined>): string {
  const joined = parts.filter((p): p is string => Boolean(p)).join('\\');
  if (!joined) return '';
  const lead = joined.startsWith('\\\\') ? '\\\\' : '';
  return lead + joined.slice(lead.length).replace(/\\+/g, '\\').replace(/\\+$/, '');
}

/** 路径长度预警 */
export function checkPathLength(target: string): string | null {
  const len = toLongPath(target).length;
  if (len > 32000) return `目标路径过长（${len} 字符），超出系统上限`;
  if (target.length > 259) return `目标路径超过 260 字符（${target.length}），已自动启用长路径支持`;
  return null;
}

/** 归一化后的「是否在某个根目录内」判断（大小写不敏感） */
export function isInside(child: string, root: string): boolean {
  const c = normalizePath(child).toLowerCase();
  const r = normalizePath(root).toLowerCase();
  if (!c || !r) return false;
  if (c === r) return true;
  return c.startsWith(r.endsWith('\\') ? r : r + '\\');
}

/** 清洗单个路径段（去非法字符、保留名、首尾点空格） */
export function sanitizePathSegment(name: string): string {
  let v = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!v) v = '未命名';
  if (RESERVED.test(v)) v = `_${v}`;
  if (v.length > 120) v = v.slice(0, 120);
  return v;
}

export function isValidFolderName(name: string): { ok: boolean; reason?: string } {
  const v = String(name ?? '').trim();
  if (!v) return { ok: false, reason: '名称不能为空' };
  if (ILLEGAL_NAME_CHARS.test(v)) return { ok: false, reason: '名称含非法字符 \\ / : * ? " < > |' };
  if (RESERVED.test(v)) return { ok: false, reason: '名称是 Windows 保留名' };
  if (v.endsWith('.') || v.endsWith(' ')) return { ok: false, reason: '名称不能以点或空格结尾' };
  if (v.length > 120) return { ok: false, reason: '名称过长（>120 字符）' };
  return { ok: true };
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.stat(toLongPath(p));
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(toLongPath(dir), { recursive: true });
}

/** 目录是否可写（用于 NAS 断连探测） */
export async function isWritableDir(dir: string): Promise<boolean> {
  try {
    await fsp.access(toLongPath(dir), fs.constants.W_OK);
    const st = await fsp.stat(toLongPath(dir));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** 目录是否可读 */
export async function isReadableDir(dir: string): Promise<boolean> {
  try {
    await fsp.access(toLongPath(dir), fs.constants.R_OK);
    const st = await fsp.stat(toLongPath(dir));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** 拆分文件名与扩展名（对 `xxx.tar.gz` 只拆最后一个扩展名） */
export function splitExt(name: string): { base: string; ext: string } {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, idx), ext: name.slice(idx) };
}

/**
 * 计算不冲突的目标名称：
 * 已存在同名 → 依次尝试 `xxx (1).mp4`、`xxx (2).mp4` ……
 */
export async function resolveUniqueName(dir: string, name: string): Promise<string> {
  if (!(await exists(path.join(dir, name)))) return name;
  const { base, ext } = splitExt(name);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${base} (${i})${ext}`;
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
  throw new Error(`无法为「${name}」找到可用的不冲突名称`);
}

/**
 * 移动（剪切）文件或文件夹。
 * 同设备：fs.rename；跨设备（EXDEV）：复制 → 校验大小 → 删除源。
 * 返回实际使用的模式。
 */
export async function moveItem(
  from: string,
  to: string,
  onProgress?: (copiedBytes: number) => void
): Promise<{ mode: 'rename' | 'copy' }> {
  await ensureDir(path.dirname(to));
  const src = toLongPath(from);
  const dst = toLongPath(to);

  try {
    await fsp.rename(src, dst);
    return { mode: 'rename' };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EXDEV' && code !== 'EPERM' && code !== 'ENOTSUP') throw err;
    // 跨设备 / 不支持 rename → 降级为复制 → 校验 → 删除源
  }

  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await copyDirRecursive(src, dst, onProgress);
    const srcCount = await countEntries(src);
    const dstCount = await countEntries(dst);
    if (srcCount !== dstCount) {
      throw new Error(`跨设备复制校验失败：源 ${srcCount} 项 / 目标 ${dstCount} 项，已保留源文件`);
    }
    await fsp.rm(src, { recursive: true, force: false });
  } else {
    await fsp.copyFile(src, dst);
    const dstStat = await fsp.stat(dst);
    if (dstStat.size !== st.size) {
      throw new Error(`跨设备复制校验失败：源 ${st.size} 字节 / 目标 ${dstStat.size} 字节，已保留源文件`);
    }
    await fsp.unlink(src);
  }
  return { mode: 'copy' };
}

async function countEntries(dir: string): Promise<number> {
  let n = 0;
  const walk = async (d: string): Promise<void> => {
    const list = await fsp.readdir(d, { withFileTypes: true });
    for (const e of list) {
      n++;
      if (e.isDirectory()) await walk(path.join(d, e.name));
    }
  };
  await walk(dir);
  return n;
}

async function copyDirRecursive(
  src: string,
  dst: string,
  onProgress?: (bytes: number) => void
): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const list = await fsp.readdir(src, { withFileTypes: true });
  for (const e of list) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDirRecursive(s, d, onProgress);
    } else if (e.isSymbolicLink()) {
      const link = await fsp.readlink(s);
      await fsp.symlink(link, d).catch(() => undefined);
    } else {
      await fsp.copyFile(s, d);
      const st = await fsp.stat(d);
      onProgress?.(st.size);
    }
  }
}

/**
 * 统计文件夹内部文件数量与总大小（并发执行，适配 NAS 的高延迟）。
 *
 * 优化点（重要）：
 *  ① 每个文件的大小必须靠 `stat` 拿到，而 NAS 上一次 `stat` 就是一个网络往返 —— 串行做会非常慢，
 *     所以这里用信号量把等待重叠起来，10 路并发通常能快数倍；
 *  ② 顺带返回**顶层是否有视频文件**，供 scanner 判断「容器目录」，省掉一次重复的 `readdir`。
 */
export async function measureDir(
  dir: string,
  sem: Semaphore = new Semaphore(DEFAULT_FS_CONCURRENCY)
): Promise<{ size: number; count: number; hasDirectVideo: boolean }> {
  let size = 0;
  let count = 0;
  let hasDirectVideo = false;

  const walk = async (d: string, isTop: boolean): Promise<void> => {
    const list = await sem
      .run(() => fsp.readdir(toLongPath(d), { withFileTypes: true }))
      .catch(() => [] as fs.Dirent[]);

    const dirs: string[] = [];
    const stats: Array<Promise<void>> = [];

    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        dirs.push(p);
        continue;
      }
      if (isTop && VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) hasDirectVideo = true;
      count++;
      stats.push(
        sem.run(() => fsp.stat(toLongPath(p)))
          .then(st => { size += st.size; })
          .catch(() => { /* 忽略个别文件读取失败 */ })
      );
    }

    // 同层的文件 stat 一起等；子目录并行下钻
    await Promise.all([
      Promise.all(stats),
      ...dirs.map(sub => walk(sub, false))
    ]);
  };

  await walk(dir, true);
  return { size, count, hasDirectVideo };
}

/** 只读/读安全删除空目录 */
export async function removeIfEmpty(dir: string): Promise<void> {
  try {
    const list = await fsp.readdir(toLongPath(dir));
    if (!list.length) await fsp.rmdir(toLongPath(dir));
  } catch { /* 忽略 */ }
}

/** 递归读取目录（含子目录）的项 */
export async function readDirSafe(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(toLongPath(dir), { withFileTypes: true });
  } catch {
    return [];
  }
}
