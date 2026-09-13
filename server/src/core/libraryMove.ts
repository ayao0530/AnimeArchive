/**
 * 媒体库内的二次整理（《需求与设计文档》9.8 的延伸）
 *
 * 归档完成后，在「归档结果区」发现某个文件归错了位置时，
 * 不必回原始文件区重来一遍 —— 直接把它移到正确的番剧文件夹里。
 *
 * 安全约束：
 *  - **只能在归档根目录内部移动**（用 normalized 祖先判断，杜绝移出去）
 *  - 目标目录不存在则逐级创建（年 / 月 / 番剧名 / SP|OP&ED）
 *  - 目标已有同名文件 → 自动加 `(1)`，**绝不覆盖**
 *  - 移走之后如果原来的目录空了，把它（以及跟着变空的年/月目录）删掉
 *  - 全程记入 rename 日志（可追溯），并重建媒体库索引
 */
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { Store } from './store';
import {
  ensureDir, exists, isInside, isValidFolderName, moveItem, resolveUniqueName,
  sanitizePathSegment, toLongPath
} from '../fsx/fsx';
import { OperationLog } from '../types';

export interface MoveInLibraryRequest {
  /** 要移动的文件/文件夹：归档根目录下的完整路径 */
  fromPath: string;
  /** 目标番剧名（官方中文名） */
  zhName: string;
  /** 目标首播年份 / 月份 */
  year: number;
  month: number;
  /** 可选：放进 SP / OP&ED 子目录 */
  subDir?: 'SP' | 'OP&ED' | null;
  /** 可选：改名（不含目录） */
  newName?: string;
}

export interface MoveInLibraryResult {
  fromPath: string;
  toPath: string;
  /** 目标番剧文件夹相对于归档根的路径 */
  relTargetDir: string;
  renamed: boolean;
  /** 因为这次移动而变空、被顺手删掉的目录（可能含番剧名 / 月 / 年几层） */
  cleanedDirs: string[];
}

export async function moveInLibrary(
  store: Store,
  libraryRoot: string,
  req: MoveInLibraryRequest
): Promise<MoveInLibraryResult> {
  const root = String(libraryRoot ?? '').replace(/[\\/]+$/, '');
  if (!root) throw new Error('尚未设置归档根目录');

  const fromPath = String(req.fromPath ?? '').trim();
  if (!fromPath) throw new Error('缺少要移动的文件路径');
  if (!isInside(fromPath, root)) {
    throw new Error(`只允许在归档根目录内部移动：「${fromPath}」不在「${root}」内`);
  }
  if (!(await exists(fromPath))) throw new Error(`要移动的文件不存在：「${fromPath}」`);

  const zhName = String(req.zhName ?? '').trim();
  const nameCheck = isValidFolderName(zhName);
  if (!nameCheck.ok) throw new Error(`目标番剧名不合法：${nameCheck.reason}`);

  const isDir = await isDirectory(fromPath);

  // 文件不能移到它自己所在的目录里
  if (isInside(path.dirname(fromPath), root) === false) throw new Error('源路径不在归档根目录内');

  const year = Number(req.year);
  const month = Number(req.month);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    throw new Error('请提供合法的首播年份与月份（1–12）');
  }

  const segs = [String(year), String(month).padStart(2, '0'), sanitizePathSegment(zhName)];
  if (req.subDir === 'SP' || req.subDir === 'OP&ED') segs.push(req.subDir);
  const targetDir = path.join(root, ...segs);

  let fileName = path.basename(fromPath);
  if (req.newName && req.newName.trim()) {
    const n = req.newName.trim();
    if (/[\\/:*?"<>|]/.test(n)) throw new Error('新文件名含非法字符 \\ / : * ? " < > |');
    fileName = n;
  }

  // 源与目标完全相同 → 什么都没做
  const directTarget = path.join(targetDir, fileName);
  if (directTarget.toLowerCase() === fromPath.toLowerCase()) {
    return { fromPath, toPath: fromPath, relTargetDir: segs.join('\\'), renamed: false, cleanedDirs: [] };
  }

  await ensureDir(targetDir);

  let toPath = directTarget;
  let renamed = false;
  if (await exists(toPath)) {
    // 目标已存在 → 自动 (1)，绝不覆盖
    const unique = await resolveUniqueName(targetDir, fileName);
    toPath = path.join(targetDir, unique);
    renamed = unique !== fileName;
  }

  await moveItem(fromPath, toPath);

  // 移走之后：原来的番剧文件夹可能已经空了（比如把最后一集挪走 / 整部挪空）
  // → 顺手删掉，并且往上一路清（月、年也空了就一起清，但**绝不动归档根本身**）。
  const cleanedDirs = await pruneEmptyDirsUpward(root, path.dirname(fromPath));

  // 记一笔，便于日后追溯（沿用重命名日志的格式）
  await store.appendRenameLog({
    renameId: `mv-${Date.now()}`,
    fromPath,
    toPath,
    result: 'success',
    error: null,
    timestamp: new Date().toISOString()
  });

  // 顺便也补一条操作日志，让「撤回」体系能看到这次移动
  const log: OperationLog = {
    logId: `mv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    batchId: 'library-move',
    fromPath,
    toPath,
    result: 'success',
    error: null,
    timestamp: new Date().toISOString(),
    reversible: true,
    originPath: fromPath,
    opType: 'move',
    isDir
  };
  await store.appendBatchJournal('library-move', log);

  return { fromPath, toPath, relTargetDir: segs.join('\\'), renamed, cleanedDirs };
}

/**
 * 移动走一个文件后，把**因此变空的**目录逐级删掉。
 *
 * 为什么需要：挪走最后一集之后，`2023\07\某番剧\` 会留成一个空壳，
 * 年份 / 月份目录也可能跟着空掉，时间一长归档区里全是空文件夹。
 *
 * 安全约束：
 *  - 只删**归档根目录内部**的目录（`isInside` 挡一层，复用了 UNC 事故的教训），
 *    **绝不动归档根本身**
 *  - 只有 `readdir` 结果为空才删（有隐藏/系统文件也算非空）
 *  - 从最深的目录往上走，**一遇到非空就立刻停**，不会误伤兄弟目录
 *  - 删不掉（被占用、权限）就默默停住，不当失败上报 —— 清理是附带的，不该弄脏主流程
 */
/**
 * 向上清理时「还能继续往上爬一层吗」。
 *
 * ⚠ 必须**同时**判两件事：
 *  - `isInside` 是**含自身**的语义（`isInside(root, root) === true`），
 *    光用它挡不住「把归档根自己也当成一层」—— 归档根绝对不能删！
 *  - 还要用 resolve 后的字符串比较把「已到根」这种情形单独摘出来。
 * 抽成函数是为了让自检能直接锁住这个边界（A35）。
 */
export function canClimbTo(cur: string, root: string): boolean {
  if (!cur) return false;
  const curAbs = path.resolve(cur);
  const rootAbs = path.resolve(root);
  return curAbs.toLowerCase() !== rootAbs.toLowerCase() && isInside(curAbs, rootAbs);
}

async function pruneEmptyDirsUpward(root: string, startDir: string): Promise<string[]> {
  const removed: string[] = [];
  const rootAbs = path.resolve(root);
  let cur = path.resolve(startDir);

  while (canClimbTo(cur, rootAbs)) {
    let isEmpty = false;
    try {
      isEmpty = (await fsp.readdir(toLongPath(cur))).length === 0;
    } catch {
      return removed;   // 目录已经不在了 → 停
    }
    if (!isEmpty) return removed;

    try {
      await fsp.rmdir(toLongPath(cur));
      removed.push(cur);
    } catch {
      return removed;   // 删不掉 → 停（不报错）
    }
    cur = path.dirname(cur);
  }
  return removed;
}

/**
 * 批量版：把一整部番剧（或任意一组文件）一起移到另一部番剧。
 *
 * 为什么要单独做一个批量函数（而不是让前端循环调单文件接口）：
 * 每个单文件请求结束后都会**重建一次媒体库索引**，整部番剧 100 集就是 100 次重建，
 * 慢到没法用。批量版只让调用方在结束时重建一次。
 *
 * 失败隔离：单条失败（文件被别人删了、被占用）只计入 `failed`，**不中断整批** ——
 * 与执行归档的行为保持一致。
 */
export interface MoveManyInLibraryRequest {
  /** 要一起移动的文件完整路径（都必须在归档根目录内） */
  fromPaths: string[];
  zhName: string;
  year: number;
  month: number;
  subDir?: 'SP' | 'OP&ED' | null;
}

export interface MoveManyInLibraryResult {
  /** 真的搬走的条数 */
  moved: number;
  /** 本来就在目标位置、不需要动的条数（例如点了「移到自己所在的番剧」） */
  unchanged: number;
  /** 失败项 */
  failed: Array<{ fromPath: string; error: string }>;
  /** 目标番剧文件夹（相对归档根的路径） */
  relTargetDir: string;
  /** 因为这次批量移动而变空、被顺手删掉的目录 */
  cleanedDirs: string[];
  results: MoveInLibraryResult[];
}

export async function moveManyInLibrary(
  store: Store,
  libraryRoot: string,
  req: MoveManyInLibraryRequest
): Promise<MoveManyInLibraryResult> {
  const results: MoveInLibraryResult[] = [];
  const failed: Array<{ fromPath: string; error: string }> = [];
  const cleanedDirs: string[] = [];
  let moved = 0;
  let unchanged = 0;

  for (const fromPath of req.fromPaths) {
    try {
      const r = await moveInLibrary(store, libraryRoot, {
        fromPath,
        zhName: req.zhName,
        year: req.year,
        month: req.month,
        subDir: req.subDir ?? null
      });
      results.push(r);
      if (r.toPath.toLowerCase() === r.fromPath.toLowerCase()) unchanged++;
      else moved++;
      if (r.cleanedDirs.length) cleanedDirs.push(...r.cleanedDirs);
    } catch (err) {
      failed.push({ fromPath, error: (err as Error).message });
    }
  }

  return {
    moved,
    unchanged,
    failed,
    relTargetDir: results[0]?.relTargetDir ?? '',
    cleanedDirs,
    results
  };
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const fsp = await import('node:fs/promises');
    const st = await fsp.stat(p);
    return st.isDirectory();
  } catch {
    return false;
  }
}
