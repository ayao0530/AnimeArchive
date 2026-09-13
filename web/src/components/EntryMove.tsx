/**
 * 「二次整理」：把一个 / 一批条目改归到另一部番剧。
 *
 * 这是「发现归错位置了，想改」的统一入口 —— 归档结果区（树形视图 / 对照列表）与媒体库都用它。
 *
 * ⚠ 两种条目必须分开处理，这是最容易搞混的地方：
 *  - **文件真的已经在归档目录里** → `/api/library/move`，**真实移动磁盘文件**，并重建媒体库索引；
 *  - **还只是方案**（没执行过归档）→ 走方案记忆，只改「打算归到哪」，不动磁盘。
 * 一次操作里两者可以混在一起（比如整组调整），各自走各自的路。
 */
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../store';
import { api } from '../api/client';
import { formatSize, pad } from '../utils';
import { MoveItemDialog, type DirItem, type MoveItemTarget } from './Dialogs';

/**
 * 把「本次归档方案」里已识别出来的番剧整理成可选列表。
 *
 * 为什么需要它：首次使用时归档目录里一个番剧文件夹都没有，
 * 只能从「已归档文件夹」里选的话选择框等于没用；
 * 而本次扫描已经确认/识别出的番剧（含尚未创建的）才是当下真正能复用的名单。
 *
 * @param excludeIds 要排除的分组（正在编辑的那几个，选它们没有意义）
 */
export function usePlanDirs(excludeIds: string[]): DirItem[] {
  const groups = useApp(s => s.groups);
  const excludeKey = excludeIds.join('|');
  return useMemo(() => {
    const skip = new Set(excludeKey ? excludeKey.split('|') : []);
    const seen = new Set<string>();
    const out: DirItem[] = [];
    groups.forEach(g => {
      if (skip.has(g.groupId)) return;
      if (!g.zhName || !g.year || !g.month) return;
      const key = `${g.zhName.toLowerCase()}|${g.year}|${g.month}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        name: g.zhName,
        year: g.year,
        month: g.month,
        relPath: `${g.year}\\${pad(g.month)}\\${g.zhName}`,
        from: 'plan'
      });
    });
    out.sort((a, b) => ((b.year ?? 0) - (a.year ?? 0)) || ((b.month ?? 0) - (a.month ?? 0)) || a.name.localeCompare(b.name, 'zh'));
    return out;
  }, [groups, excludeKey]);
}

/** 待二次操作的条目：`archivedPath` 有值 = 文件已经在磁盘上，需要真实移动 */
export interface MoveEntry {
  /** 源目录里的原始路径（改方案用） */
  path: string;
  name: string;
  isDir: boolean;
  /** 已经归档后的真实磁盘路径（有值 → 走 /api/library/move 真实移动） */
  archivedPath?: string;
  /** 字节数（可选）—— 仅用于执行期显示「正在移动 11 个文件（5.6 GB）」 */
  size?: number;
}

export function EntryMoveHost({
  items,
  currentTarget,
  planDirs = [],
  onClose,
  onDone
}: {
  items: MoveEntry[];
  /** 它们当前所在的归档位置（弹窗里的提示） */
  currentTarget: string;
  /** 本次方案里已识别出的番剧，供「快速选择」直接挑 */
  planDirs?: DirItem[];
  onClose: () => void;
  /**
   * 全部条目都处理成功后的回调（失败时不调）。
   *
   * 为什么要它：媒体库的多选批量移动得知道「这批已经搬完了」才能清空勾选 ——
   * 否则被搬走的路径会留在选择集里，下一次批量操作就会拿到一堆不存在的路径；
   * 而失败时**不清空**，用户可以直接重试。
   */
  onDone?: () => void;
}) {
  const animeDirs = useApp(s => s.animeDirs);
  const loadLibrary = useApp(s => s.loadLibrary);
  const moveItemsToAnime = useApp(s => s.moveItemsToAnime);
  const pushLog = useApp(s => s.pushLog);
  const showToast = useApp(s => s.showToast);

  const onDisk = items.filter(i => i.archivedPath);
  const planned = items.filter(i => !i.archivedPath);
  const mode: 'plan' | 'disk' | 'mixed' =
    onDisk.length === 0 ? 'plan' : planned.length === 0 ? 'disk' : 'mixed';

  /**
   * 执行期的界面状态。
   *
   * 为什么要计时：批量接口是**一次请求**（没有逐文件进度），几 GB 在 NAS 上要几十秒，
   * 光一个转圈无法让人安心 —— 秒数在动就说明还活着；同时也提醒别重复点。
   * `note` 只切换阶段文案，计时器贯整个操作（不分段重置）。
   */
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!busy) return;
    const from = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - from) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const totalSize = items.reduce((a, i) => a + (i.size ?? 0), 0);
  const sizeHint = onDisk.length === items.length
    ? (totalSize > 0 ? `${items.length} 个文件（${formatSize(totalSize)}）` : `${items.length} 个文件`)
    : `${items.length} 个条目`;

  return (
    <MoveItemDialog
      mode={mode}
      items={items.map<MoveItemTarget>(i => ({ path: i.archivedPath ?? i.path, name: i.name, isDir: i.isDir }))}
      currentTarget={currentTarget}
      loadDirs={animeDirs}
      planDirs={planDirs}
      busy={busy ? { note: `${note}（已用 ${elapsed} 秒，请勿重复点击）` } : null}
      onClose={onClose}
      onApply={p => {
        void (async () => {
          setBusy(true);
          setNote(`正在移动 ${sizeHint}…`);
          const errs: string[] = [];
          let moved = 0;
          let unchanged = 0;
          let cleaned = 0;

          /* ① 已经在磁盘上的：真的搬文件。
                **多于一小时也走同一个批量接口** —— 逐条调单文件接口会「每搬一条就重建一次索引」，
                整部番剧 100 集就是 100 次全量重建。 */
          if (onDisk.length > 0) {
            const paths = onDisk.map(i => i.archivedPath as string);
            try {
              const r = await api.libraryMoveBatch({
                fromPaths: paths, zhName: p.zhName, year: p.year, month: p.month
              });
              moved = r.moved;
              unchanged = r.unchanged;
              cleaned = r.cleanedDirs.length;
              if (r.moved > 0) {
                pushLog(
                  paths.length > 1
                    ? `📁 批量移位：${r.moved} / ${paths.length} 个文件 → ${r.relTargetDir || p.zhName}`
                    : `📁 已归档文件移位：${paths[0]} → ${r.results[0]?.toPath ?? ''}`,
                  'ok'
                );
              }
              if (r.unchanged > 0) {
                pushLog(`ℹ ${r.unchanged} 个文件本来就在目标番剧里，无需移动`, 'warn');
              }
              if (r.cleanedDirs.length) {
                // 移空之后顺手把空目录删掉了 —— 这是个「删」操作，必须让用户看得见
                const shown = r.cleanedDirs.slice(0, 3).join('、');
                pushLog(
                  `🧹 原目录已空，顺手清理 ${r.cleanedDirs.length} 个空文件夹：${shown}${r.cleanedDirs.length > 3 ? ' 等' : ''}`,
                  'ok'
                );
              }
              for (const f of r.failed) {
                errs.push(`${f.fromPath.split('\\').pop()}：${f.error}`);
              }
            } catch (err) {
              errs.push((err as Error).message);
            }
          }

          /* ② 还只是方案的：改方案记忆（同一目标的条目会自动并成一个拆出分组） */
          if (planned.length) {
            try {
              await moveItemsToAnime(planned.map(i => i.path), p);
            } catch (err) {
              errs.push(`方案调整失败：${(err as Error).message}`);
            }
          }

          if (moved) {
            setNote('正在刷新媒体库…');
            await loadLibrary();
          }
          setBusy(false);
          setNote('');
          onClose();

          if (!errs.length) onDone?.();

          if (errs.length) {
            pushLog(`❌ 有 ${errs.length} 项没处理成功：${errs.join('；')}`, 'err');
            showToast(`⚠ 部分未成功：${errs[0]}`, '#ef5566');
          } else if (moved) {
            showToast(
              `📁 已真实移动 ${moved} 个文件 →「${p.zhName}」${cleaned > 0 ? `（顺带清理 ${cleaned} 个空文件夹）` : ''}`,
              '#27c08a'
            );
          } else if (unchanged > 0 && !planned.length) {
            showToast('ℹ 它们本来就在这个位置，没有文件需要移动', '#f2b632');
          } else {
            showToast(`↗ 已改归到「${p.zhName}」（改的是方案，执行归档后生效）`, '#27c08a');
          }
        })();
      }}
    />
  );
}
