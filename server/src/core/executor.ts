/**
 * 执行器：剪切移动 + 冲突处理 + 日志（《需求与设计文档》5.4 / 5.5 / 7.7 / 8.6）
 *
 * 安全原则：
 *  1. 默认 Dry-Run：先出方案，用户确认后才动文件
 *  2. 剪切移动；跨设备自动降级「复制 → 校验 → 删除源」
 *  3. 全量日志（原路径 → 新路径 + 时间戳 + 校验结果）
 *  4. 失败隔离：单条失败不中断整批，失败项保留源文件
 *  5. 不删除任何文件（除跨设备剪切语义中校验通过后删除源）
 */
import * as path from 'node:path';
import {
  ArchivePlan,
  BatchLog,
  EntryStatus,
  ExecuteState,
  FailedMove,
  OperationLog,
  PlanEntry
} from '../types';
import { checkPathLength, exists, isInside, isWritableDir, moveItem, resolveUniqueName } from '../fsx/fsx';
import { Store } from './store';

export type ConflictStrategy = 'rename' | 'skip';

/** 默认并发度：与扫描保持一致（NAS 上单次操作是一个网络往返） */
const DEFAULT_EXEC_CONCURRENCY = 10;

/**
 * 单条迁移失败后自动重试的次数（共尝试 1 + 3 次）。
 * NAS 上偶发的 EPERM / 网络瞬断占绝大多数，重试基本都能成。
 */
export const MAX_MOVE_RETRIES = 3;
/** 重试前的等待（毫秒），逐次拉长，给 NAS 一点缓过来的时间 */
const RETRY_BACKOFF_MS = [300, 800, 1500];
/** `execute-state.json` 里最多保留多少条失败项（完整记录始终在批次日志里） */
const MAX_FAILED_KEEP = 200;

const delay = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

/* =========================================================
   停止执行归档
   ---------------------------------------------------------
   语义：点「停止」后**不再取新条目**，但已经在飞的那几条（最多 concurrency 个）
   会让它跑完 —— 否则会在 NAS 上留下复制到一半的文件。
   ========================================================= */

let activeBatchId: string | null = null;
let stopRequested = false;

/** 请求停止当前批次（没有正在跑的批次时返回 stopped:false） */
export function requestExecuteStop(): { stopped: boolean; batchId: string | null } {
  if (!activeBatchId) return { stopped: false, batchId: null };
  stopRequested = true;
  return { stopped: true, batchId: activeBatchId };
}

/** 是否有批次正在执行 */
export function isExecuteRunning(): boolean {
  return activeBatchId !== null;
}

export interface EntryDecision {
  /** 是否执行该条目 */
  execute: boolean;
  /** 冲突策略 */
  strategy?: ConflictStrategy;
  /** 用户在方案中手动指定的目标文件名（不含目录） */
  targetName?: string;
}

export interface ExecuteOptions {
  plan: ArchivePlan;
  decisions: Record<string, EntryDecision>;
  /** 并发度（NAS 上单个移动是一次网络往返，并发才能提速；默认 10） */
  concurrency?: number;
  onEvent?: (ev: ExecEvent) => void;
}

export type ExecEvent =
  | { type: 'start'; batchId: string; total: number }
  | { type: 'entry'; entryId: string; index: number; total: number; status: 'done' | 'failed' | 'skipped'; fromPath: string; toPath: string; error?: string | null; note?: string | null; attempts?: number }
  | { type: 'done'; batchId: string; success: number; failed: number; skipped: number; stopped?: boolean; logPath: string };

export interface ExecuteResult {
  batchId: string;
  success: number;
  failed: number;
  skipped: number;
  /** 是否因为用户点「停止归档」而提前收尾 */
  stopped: boolean;
  /** 方案里的条目是否已全部处理完 */
  finished: boolean;
  /** 迁移失败项（已用尽自动重试），供界面标明 + 后续人工处理 */
  failedItems: FailedMove[];
  logs: OperationLog[];
}

/** 判断条目是否可执行 */
function isExecutable(status: EntryStatus, decision: EntryDecision | undefined): boolean {
  // 正常归档：默认执行（除非显式 execute:false）
  if (status === 'ready') return decision?.execute !== false;
  // 待确认项：必须人工确认（execute:true）后才执行
  if (status === 'review') return decision?.execute === true;
  // 冲突项：默认按「自动重命名 (1)」执行；选择「跳过」则不执行
  if (status === 'conflict') return decision?.execute !== false && (decision?.strategy ?? 'rename') === 'rename';
  // 未识别 / 暂不处理：默认**不**移动，需用户在界面上显式勾选（移入 _未识别/ 、_待确认/）
  if (status === 'unrecognized' || status === 'deferred') return decision?.execute === true;
  return false; // skipped / done / failed
}

export async function executePlan(store: Store, opts: ExecuteOptions): Promise<ExecuteResult> {
  const targetRoot = opts.plan.targetRoot;

  // 归档根目录必须存在且可写，否则中止且不改动任何源文件
  if (!(await isWritableDir(targetRoot))) {
    throw new Error(
      `归档根目录不存在或不可写：「${targetRoot}」。` +
      `已中止，未修改任何源文件。请确认 NAS 已连接，或在界面上点击「创建归档目录」。`
    );
  }
  // 同一时间只允许一个批次：两批并发会互相抢 rename / 生成重复的 (1)(2)
  if (activeBatchId) {
    throw new Error(`已有归档批次正在执行（${activeBatchId}）。请等它结束，或先点「停止归档」。`);
  }

  /* 批次号：可读的时间戳 + 随机后缀。
   * ⚠ 后缀不能省：用户「点停止 → 马上点继续」时，两批很可能落在**同一秒**，
   * 同号会让第二批的日志覆盖第一批（批次号也是日志文件名和撤回依据），
   * 结果是「撤销整批」撤到错误的那一批上。 */
  const batchId = `batch-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 8)}`;
  activeBatchId = batchId;
  stopRequested = false;
  try {
    return await runBatch(store, opts, batchId);
  } finally {
    activeBatchId = null;
    stopRequested = false;
  }
}

async function runBatch(store: Store, opts: ExecuteOptions, batchId: string): Promise<ExecuteResult> {
  const { plan, decisions } = opts;
  const targetRoot = plan.targetRoot;

  const runnable = plan.entries.filter(e => isExecutable(e.status, decisions[e.entryId]));
  const logs: OperationLog[] = [];
  const failedItems: FailedMove[] = [];
  let success = 0;
  let failed = 0;
  let skipped = 0;
  let index = 0;

  opts.onEvent?.({ type: 'start', batchId, total: runnable.length });

  // 并发搬文件：NAS 上一次移动就是一个网络往返（尤其跨卷时还要复制），串行会非常慢
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_EXEC_CONCURRENCY, 32));
  const queue = runnable.slice();

  /* ---- 进度落盘（断点续传）：关掉页面/刷新也能看到并继续 ---- */
  const state: ExecuteState = {
    batchId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    running: true,
    total: runnable.length,
    done: 0,
    failed: 0,
    skipped: 0,
    sourceRoot: plan.sourceRoot,
    targetRoot,
    lastItem: null
  };
  await store.saveExecuteState(state);
  // 进度写盘不必每条都写：并发下会互相覆盖，且磁盘写入本身也是开销。
  // ⚠ 必须**串行化**：`void flushState()` 是不等待的，如果直接写，
  // 一条还在飞的旧快照可能在最终 flush 之后落地，把 stopped/failedItems 抹掉。
  let lastFlush = 0;
  let stateWrite: Promise<void> = Promise.resolve();
  const flushState = async (force = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastFlush < 800) return;
    lastFlush = now;
    state.updatedAt = new Date().toISOString();
    const snapshot = { ...state };
    stateWrite = stateWrite.then(() => store.saveExecuteState(snapshot).catch(() => undefined));
    await stateWrite;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      // 用户点了「停止归档」→ 立刻不再取新条目。
      // 已经在飞的那几条（最多 concurrency 个）会让它们跑完，
      // 半途硬断会在 NAS 上留下复制到一半的碎文件。
      if (stopRequested) return;
      const entry = queue.shift();
      if (!entry) return;
      index++;
      const decision = decisions[entry.entryId];
      const res = await runEntry(store, batchId, entry, decision, targetRoot);
      if (res.log) {
        logs.push(res.log);
        // 逐条写日志：中途被关页面 / 杀进程也不会丢，仍可撒回已归档的那部分
        await store.appendBatchJournal(batchId, res.log).catch(() => undefined);
      }
      if (res.outcome === 'done') success++;
      else if (res.outcome === 'failed') {
        failed++;
        // 失败项单独记一份：界面需要能一直标着「这 N 项要人工处理」，
        // 而不是只在日志里一闪而过（用户明确要求“我后续再处理”）。
        if (failedItems.length < MAX_FAILED_KEEP) {
          failedItems.push({
            fromPath: entry.fromPath,
            toPath: res.log?.toPath ?? entry.toPath,
            error: res.log?.error ?? '未知错误',
            attempts: res.attempts,
            timestamp: new Date().toISOString()
          });
        }
      } else skipped++;
      state.done = success;
      state.failed = failed;
      state.skipped = skipped;
      state.lastItem = entry.fromPath;
      void flushState();
      opts.onEvent?.({
        type: 'entry',
        entryId: entry.entryId,
        index,
        total: runnable.length,
        status: res.outcome,
        fromPath: entry.fromPath,
        toPath: res.log?.toPath ?? entry.toPath,
        error: res.log?.error ?? null,
        note: res.note ?? entry.note,
        attempts: res.attempts
      });
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // 被停止时队列里还会有没取的条目 → 这次批次就不算「跑完」
  const stopped = stopRequested;
  const finished = queue.length === 0;

  const batch: BatchLog = {
    batchId,
    createdAt: new Date().toISOString(),
    sourceRoot: plan.sourceRoot,
    targetRoot,
    entries: logs
  };
  await store.writeBatchLog(batch);

  // 完成：进度标记为跑完（留下记录供 UI 展示「上次已完成 N/M」）
  state.running = false;
  state.interrupted = false;
  state.stopped = stopped;
  state.finished = finished;
  state.done = success;
  state.failed = failed;
  state.skipped = skipped;
  state.failedItems = failedItems;
  await flushState(true);

  opts.onEvent?.({ type: 'done', batchId, success, failed, skipped, stopped, logPath: path.join(store.logsDir, `batch-${batchId}.json`) });

  return { batchId, success, failed, skipped, stopped, finished, failedItems, logs };
}

async function runEntry(
  store: Store,
  batchId: string,
  entry: PlanEntry,
  decision: EntryDecision | undefined,
  targetRoot: string
): Promise<{ outcome: 'done' | 'failed' | 'skipped'; log: OperationLog | null; note?: string; attempts: number }> {
  const now = () => new Date().toISOString();
  const baseLog = (toPath: string, result: 'success' | 'failed', error: string | null): OperationLog => ({
    logId: `${batchId}-${entry.entryId}`,
    batchId,
    fromPath: entry.fromPath,
    toPath,
    result,
    error,
    timestamp: now(),
    reversible: result === 'success',
    originPath: entry.fromPath,
    opType: 'move',
    size: entry.size,
    isDir: entry.isDir
  });

  // 冲突策略：跳过
  if (entry.status === 'conflict' && (decision?.strategy ?? 'rename') === 'skip') {
    return { outcome: 'skipped', log: null, attempts: 0 };
  }

  /* ---------- 安全护栏（P0） ----------
   * 目标路径必须真的落在「归档根目录」里面。
   * 为什么必须查：曾经踩过 UNC 路径被压掉一个反斜杠的 bug
   * （`\\NAS\share\Anime\…` → `\NAS\share\Anime\…`），
   * Windows 会把 `\NAS\…` 当成「当前盘符根目录」，于是文件被移到了本机 F: 盘上。
   * 这一行能在任何路径计算错误时把批次停住，而不是默默把文件搬错地方。
   */
  if (!isInside(entry.toPath, targetRoot)) {
    return {
      outcome: 'failed',
      attempts: 0,
      log: baseLog(entry.toPath, 'failed',
        `目标路径不在归档根目录内，已拒绝执行（安全护栏）。目标=${entry.toPath}；归档根=${targetRoot}`)
    };
  }

  /* ---------- 断点续跑 ----------
   * 刷新页面 / 重新点「执行归档」时会重跑同一份方案：
   *  - 源已不在 + 目标已存在  → 说明上次已经搬过去了，**记为跳过**（而不是报失败）
   *  - 源已不在 + 目标也不在  → 真的丢了，记为失败
   */
  if (!(await exists(entry.fromPath))) {
    // 目标已存在 → 上次已经搬过去了：**只报跳过，不再写一份日志**
    // （否则撒回时会把它算成本批次搬的，撤回就会错误地多动一次文件）
    if (await exists(entry.toPath)) {
      return { outcome: 'skipped', log: null, note: '该条目已在之前的批次中归档（断点续跑，无需重复处理）', attempts: 0 };
    }
    return {
      outcome: 'failed',
      log: baseLog(entry.toPath, 'failed', '源文件不存在（可能已被移动或删除），已跳过'),
      attempts: 0
    };
  }

  const lenWarn = checkPathLength(entry.toPath);
  if (lenWarn && entry.toPath.length > 30000) {
    return { outcome: 'failed', log: baseLog(entry.toPath, 'failed', lenWarn), attempts: 0 };
  }

  /* ---------- 计算最终目标路径 + 迁移（失败自动重试） ----------
   * 关键：**唯一名只算一次**。
   * 如果每次都重算，那么「第一次其实已经复制成功、只是删源失败」的条目
   * 会在重试时又去找 `(1)`、`(2)`，在 NAS 上堆出一串重复文件。
   * 所以第一次算出来的路径就是这条挪动的唯一目标，重试只重试同一个目标。
   * （`copyFile` 是覆盖写，重试不会留下半截文件）
   */
  let toPath: string | null = null;
  let lastErr: Error | null = null;
  let attempts = 0;
  const maxAttempts = MAX_MOVE_RETRIES + 1;

  // 用 while + 自增，不要用 for：for 在退出时还会执行一次 `attempts++`，
  // 于是「已尝试 4 次」会被记成「已尝试 5 次」
  while (attempts < maxAttempts) {
    attempts++;
    try {
      if (!toPath) {
        let p = entry.toPath;
        if (decision?.targetName && decision.targetName.trim()) {
          p = path.join(path.dirname(entry.toPath), decision.targetName.trim());
        }
        // 源 == 目标 → 不用搬
        if (path.resolve(entry.fromPath).toLowerCase() === path.resolve(p).toLowerCase()) {
          return { outcome: 'skipped', log: null, attempts: 0 };
        }
        // 目标已存在 → 自动加 (1)（冲突项选了「跳过」则不执行）
        if (await exists(p)) {
          if (entry.status === 'conflict' && (decision?.strategy ?? 'rename') === 'skip') {
            return { outcome: 'skipped', log: null, attempts: 0 };
          }
          const unique = await resolveUniqueName(path.dirname(p), path.basename(p));
          p = path.join(path.dirname(p), unique);
        }
        toPath = p;
      }

      await moveItem(entry.fromPath, toPath);
      const log = baseLog(toPath, 'success', lenWarn);
      log.attempts = attempts;
      if (attempts > 1) log.error = `前 ${attempts - 1} 次尝试失败，第 ${attempts} 次成功（已自动重试）`;
      return { outcome: 'done', log, attempts };
    } catch (err) {
      lastErr = err as Error;
      // 源已经不在（被别的程序搬走 / 删掉）→ 再重试没有意义
      const stillThere = await exists(entry.fromPath).catch(() => false);
      if (!stillThere) break;
      if (attempts < maxAttempts) {
        await delay(RETRY_BACKOFF_MS[Math.min(attempts - 1, RETRY_BACKOFF_MS.length - 1)]);
      }
    }
  }

  const shown = toPath ?? entry.toPath;
  const retryNote = attempts > 1
    ? `已尝试 ${attempts} 次（首次 + ${attempts - 1} 次自动重试），仍失败`
    : '已尝试 1 次';
  const log = baseLog(shown, 'failed', `${lastErr?.message ?? '未知错误'} —— ${retryNote}`);
  log.attempts = attempts;
  return { outcome: 'failed', log, attempts };
}

/* =========================================================
   撤回：整批撤销 + 单文件撤回
   ========================================================= */

export interface RevertOptions {
  /** 指定批次（整批撤销） */
  batchId?: string;
  /** 指定单文件（当前完整路径） */
  filePath?: string;
  onEvent?: (ev: { type: 'entry'; fromPath: string; toPath: string; result: 'success' | 'failed'; error: string | null }) => void;
}

export async function revert(
  store: Store,
  opts: RevertOptions
): Promise<{ success: number; failed: number; skipped: number }> {
  let targets: Array<{ fromPath: string; originPath: string; batchId: string | null }> = [];

  if (opts.filePath) {
    const wanted = opts.filePath;
    const key = wanted.toLowerCase();
    const map = await store.allMoveLogs();
    const origin = Store.resolveOrigin(map, wanted) ?? map.get(key);
    if (!origin) throw new Error('该文件没有归档记录（可能不是本工具归档的），无法撤回');
    const batches = await store.listBatchLogs();
    const hit = batches.find(b => b.entries.some(e => e.toPath.toLowerCase() === key));
    targets = [{ fromPath: wanted, originPath: origin, batchId: hit?.batchId ?? null }];
  } else {
    const batches = await store.listBatchLogs();
    const batch = opts.batchId ? batches.find(b => b.batchId === opts.batchId) : batches[0];
    if (!batch) throw new Error('没有可撤销的批次');
    targets = batch.entries
      .filter(e => e.result === 'success' && e.reversible)
      .map(e => ({ fromPath: e.toPath, originPath: e.originPath, batchId: e.batchId }));
    // 反向顺序撤销，避免父目录先行引发冲突
    targets.reverse();
  }

  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const t of targets) {
    try {
      if (!(await exists(t.fromPath))) {
        // 该文件已被移回（或已被删除）→ 记为跳过，不算失败
        skipped++;
        continue;
      }
      const dir = path.dirname(t.originPath);
      const unique = await resolveUniqueName(dir, path.basename(t.originPath));
      const finalTarget = path.join(dir, unique);
      await moveItem(t.fromPath, finalTarget);
      success++;
      await store.appendRevertLog({
        revertId: `rv-${Date.now()}-${success}`,
        batchId: t.batchId,
        filePath: t.fromPath,
        targetPath: finalTarget,
        result: 'success',
        error: null,
        timestamp: new Date().toISOString(),
        note: unique !== path.basename(t.originPath) ? '原位置已存在同名文件，已重命名后移回' : null
      });
      opts.onEvent?.({ type: 'entry', fromPath: t.fromPath, toPath: finalTarget, result: 'success', error: null });
    } catch (err) {
      failed++;
      await store.appendRevertLog({
        revertId: `rv-${Date.now()}-f${failed}`,
        batchId: t.batchId,
        filePath: t.fromPath,
        targetPath: t.originPath,
        result: 'failed',
        error: (err as Error).message,
        timestamp: new Date().toISOString(),
        note: null
      });
      opts.onEvent?.({ type: 'entry', fromPath: t.fromPath, toPath: t.originPath, result: 'failed', error: (err as Error).message });
    }
  }
  return { success, failed, skipped };
}
