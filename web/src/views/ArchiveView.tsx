import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApp, type ArchiveFilter } from '../store';
import type { AnimeGroup, GroupStatus } from '../types';
import {
  STATUS_CLASS, STATUS_COLOR, STATUS_TEXT, entryTargetName, formatDateTime, formatSize, formatStamp, formatTime,
  groupTargetDir, highlight, isTextSelecting, matchGroup, pad, padEpisode, parseQuery, sourceLabel
} from '../utils';
import { ConflictDialog, MoveItemDialog, RenameDialog, ResolveDialog, type MoveItemTarget } from '../components/Dialogs';
import { EntryMoveHost, usePlanDirs, type MoveEntry } from '../components/EntryMove';

export default function ArchiveView() {
  return (
    <>
      <Toolbar />
      <ExecProgressNotice />
      <TargetRootNotice />
      <SnapshotNotice />
      <MemoryNotice />
      <main className="layout">
        <SourcePanel />
        <TargetPanel />
      </main>
      <Legend />
      <StatusBar />
      <DialogHost />
      <BatchBar />
    </>
  );
}

/**
 * 归档执行进度提示条（断点续传 + 停止 + 失败项标明）。
 *
 * 三种场景：
 *  ① running —— 页面被关掉/刷新了，但**服务端仍在后台搬文件**：
 *     实时展示进度（每 1.5s 轮询），可以在这里直接「停止归档」。
 *  ② stopped / interrupted —— 没跑完就停了：点「继续归档」接着跑（已搬的自动跳过），
 *     或直接「撤销整批」把这一批搬回去。
 *  ③ failedItems —— 迁移失败（已自动重试 3 次仍失败）：标出来，等用户后续人工处理。
 */
function ExecProgressNotice() {
  const st = useApp(s => s.execProgress);
  const dismiss = useApp(s => s.dismissExecProgress);
  const execute = useApp(s => s.execute);
  const stop = useApp(s => s.stopExecute);
  const undoBatch = useApp(s => s.undoBatch);
  const toggleLog = useApp(s => s.toggleLog);
  const plan = useApp(s => s.plan);
  // 关闭网页时服务会自动关闭（可在 ⚙ 设置里关掉）→ 文案要说法一致
  const autoClose = useApp(s => s.config?.shutdownOnPageClose !== false);

  if (!st) return null;
  const handled = st.done + st.failed + st.skipped;
  const percent = st.total ? Math.round((handled / st.total) * 100) : 0;
  const remaining = Math.max(0, st.total - handled);
  const fails = st.failedItems ?? [];

  /* 失败项提示条：对比「全部处理完」也要显示 —— 用户说「后续再处理」，所以得留着 */
  const failBar = fails.length ? (
    <div className="notice-bar fail">
      <span>
        ⚠ <b>{fails.length} 项迁移失败</b>：已自动重试 3 次仍未成功，<b>源文件原样保留、未移动</b>。
        记录已写入批次日志，需你后续手动处理。
      </span>
      <span className="spacer" />
      <button className="mini" onClick={() => toggleLog(true)}>📜 查看日志</button>
      <button className="mini ghost" onClick={() => void dismiss()}>知道了</button>
      <details className="fail-more">
        <summary>展开这 {fails.length} 项的完整路径与失败原因</summary>
        <div className="list">
          {fails.map(f => (
            <div key={f.fromPath}>
              <span className="fp">{f.fromPath}</span>
              <span className="fe">✘ 尝试 {f.attempts} 次仍失败：{f.error}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  ) : null;

  if (st.running) {
    return (
      <>
        <div className="notice-bar run">
          <span>
            🔄 <b>归档正在后台进行</b>·{handled} / {st.total}（{percent}%）
            {st.lastItem ? <span className="mono" style={{ opacity: .7 }}> {st.lastItem.split('\\').pop()}</span> : null}
          </span>
          <span className="spacer" />
          <span style={{ fontSize: 11.5, opacity: .85 }}>
            {autoClose
              ? '关掉网页会先停下载入的批次并关闭服务（可在 ⚙ 设置里关掉）；刷新页面不受影响'
              : '关掉/刷新页面不影响：任务在本地服务里跑，重新打开会自动接上'}
          </span>
          <button className="mini stop" onClick={() => void stop()}>⏹ 停止归档</button>
        </div>
        {failBar}
      </>
    );
  }

  if (remaining > 0) {
    return (
      <>
        <div className="notice-bar warn">
          <span>
            {st.stopped ? <>⏹ <b>已停止归档</b>：已处理 {handled} / {st.total} 项，还剩 <b>{remaining}</b> 项未处理。</>
              : <>⏸ <b>上次归档未跑完</b>：已处理 {handled} / {st.total} 项，还剩 <b>{remaining}</b> 项。</>}
            点「继续归档」<b>接着跑</b>（已归档的会自动跳过），或把这一批<b>撤销</b>回去。
          </span>
          <span className="spacer" />
          <button className="mini" disabled={!plan} onClick={() => void execute()}>▶ 继续归档</button>
          <button className="mini rev" onClick={() => void undoBatch(st.batchId)}>↩ 撤销整批</button>
          <button className="mini ghost" onClick={() => void dismiss()}>知道了</button>
        </div>
        {failBar}
      </>
    );
  }

  return failBar ? <>{failBar}</> : null;
}

/**
 * 「上次扫描结果」提示条：打开页面时直接载入上次结果，不再每次重新扫描。
 */
function SnapshotNotice() {
  const snapshot = useApp(s => s.snapshot);
  const busy = useApp(s => s.busy);
  const scan = useApp(s => s.scan);

  if (!snapshot) return null;

  // 上次扫描出来的项已经全部归档完成
  if (!snapshot.groups) {
    return (
      <div className="notice-bar snap">
        <span>📂 上次扫描结果里的文件已全部归档完成（{formatStamp(snapshot.savedAt)}）</span>
        <span className="spacer" />
        <span style={{ fontSize: 11.5, opacity: .85 }}>有新文件时点一下扫描即可</span>
        <button className="mini" onClick={() => void scan()} disabled={!!busy}>↻ 扫描新文件</button>
      </div>
    );
  }

  return (
    <div className="notice-bar snap">
      <span>
        📂 已载入上次扫描结果{snapshot.from === 'cache' ? '（本机备份）' : ''} ·{' '}
        <span className="mono">{formatStamp(snapshot.savedAt)}</span> ·{' '}
        {snapshot.groups} 组 / {snapshot.files} 个文件
        {snapshot.stale && <span style={{ color: '#ffd47a' }}> · ⚠ 之后做过撤回，建议重新扫描</span>}
      </span>
      <span className="spacer" />
      <span style={{ fontSize: 11.5, opacity: .85 }}>文件有增减时请重新扫描以获取最新列表</span>
      <button className="mini" onClick={() => void scan()} disabled={!!busy}>↻ 重新扫描</button>
    </div>
  );
}

/**
 * 方案记忆提示条：重新扫描后自动恢复的人工确认结果 + 一键清除入口。
 */
function MemoryNotice() {
  const restoredInfo = useApp(s => s.restoredInfo);
  const overriddenPaths = useApp(s => s.overriddenPaths);
  const clearPlanMemory = useApp(s => s.clearPlanMemory);

  if (!restoredInfo && !overriddenPaths.length) return null;

  const parts: string[] = [];
  if (restoredInfo?.groups) parts.push(`${restoredInfo.groups} 个分组的确认结果`);
  if (restoredInfo?.items) parts.push(`${restoredInfo.items} 个单独调整`);
  if (!parts.length && overriddenPaths.length) parts.push(`${overriddenPaths.length} 个单独调整`);

  return (
    <div className="notice-bar mem">
      <span>📌 方案记忆：已自动恢复 {parts.join('、')}，无需重新点选</span>
      <span className="spacer" />
      <span style={{ fontSize: 11.5, opacity: .8 }}>按「源目录 + 归档根目录」保存，关掉浏览器也不会丢</span>
      <button className="mini" onClick={() => clearPlanMemory()}>🧹 清除方案记忆</button>
    </div>
  );
}

/**
 * 多选后的悬浮批量操作条：一次性把同一个番剧名应用到多个分组。
 */
function BatchBar() {
  const selected = useApp(s => s.selected);
  const groups = useApp(s => s.groups);
  const clearSelected = useApp(s => s.clearSelected);
  const resolveGroups = useApp(s => s.resolveGroups);
  const animeDirs = useApp(s => s.animeDirs);
  const [batchOpen, setBatchOpen] = useState(false);
  const planDirs = usePlanDirs(selected);

  if (!selected.length) return null;
  const targets = groups.filter(g => selected.includes(g.groupId));
  if (!targets.length) return null;

  return (
    <>
      <div className="batch-bar">
        <span>已选中 <b>{targets.length}</b> 个分组（共 {targets.reduce((a, g) => a + g.items.length, 0)} 个文件/文件夹）</span>
        <span className="spacer" />
        <button className="mini" onClick={() => setBatchOpen(true)}>🔎 批量确认名称</button>
        <button className="mini" onClick={() => clearSelected()}>清空选择</button>
      </div>

      {batchOpen && (
        <ResolveDialog
          groups={targets}
          loadDirs={animeDirs}
          planDirs={planDirs}
          onClose={() => setBatchOpen(false)}
          onApply={p => {
            void resolveGroups(targets.map(g => g.groupId), {
              zhName: p.zhName, year: p.year, month: p.month, saveAlias: p.saveAlias
            });
            setBatchOpen(false);
          }}
          onDefer={p => {
            void resolveGroups(targets.map(g => g.groupId), {
              zhName: p.zhName || targets[0].zhName || targets[0].rawNames[0] || '未确认',
              year: p.year || targets[0].year || 0,
              month: p.month || targets[0].month || 0,
              saveAlias: false,
              deferred: true
            });
            setBatchOpen(false);
          }}
        />
      )}
    </>
  );
}

/**
 * 归档根目录提示条：
 * 目录不存在（或不可写）时明确提示，并提供「一键创建」——执行归档前必须解决。
 */
function TargetRootNotice() {
  const targetRoot = useApp(s => s.targetRoot);
  const targetStatus = useApp(s => s.targetStatus);
  const serviceOnline = useApp(s => s.serviceOnline);
  const createTargetRoot = useApp(s => s.createTargetRoot);
  const checkTargetRoot = useApp(s => s.checkTargetRoot);

  if (!serviceOnline || !targetRoot || !targetStatus?.checked || targetStatus.checking) return null;
  if (targetStatus.exists && targetStatus.writable) return null;

  const missing = !targetStatus.exists;

  return (
    <div className={`notice-bar${missing ? '' : ' err'}`}>
      <span>
        {missing ? '📁 归档根目录尚未创建：' : '⚠ 归档根目录不可写（NAS 未连接或权限不足）：'}
        <span className="mono">{targetRoot}</span>
      </span>
      <span className="spacer" />
      {missing ? (
        <>
          <button className="mini" onClick={() => void createTargetRoot()}>➕ 立即创建该目录</button>
          <span style={{ fontSize: 11.5, opacity: .85 }}>
            归档时会自动创建 <span className="mono">{'{年份}\\{月份}\\{番剧名}'}</span> 各级子目录
          </span>
        </>
      ) : (
        <button className="mini" onClick={() => void checkTargetRoot(false)}>↻ 重新检测</button>
      )}
    </div>
  );
}

/* =========================================================
   工具条
   ========================================================= */

const CHIPS: Array<{ key: ArchiveFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'ready', label: '可归档' },
  { key: 'review', label: '待确认' },
  { key: 'conflict', label: '冲突' },
  { key: 'unrecognized', label: '未识别' }
];

function Toolbar() {
  const query = useApp(s => s.query);
  const setQuery = useApp(s => s.setQuery);
  const filter = useApp(s => s.filter);
  const setFilter = useApp(s => s.setFilter);
  const treeView = useApp(s => s.treeView);
  const setTreeView = useApp(s => s.setTreeView);
  const scan = useApp(s => s.scan);
  const busy = useApp(s => s.busy);
  const serviceOnline = useApp(s => s.serviceOnline);

  return (
    <div className="toolbar" id="toolbarArchive">
      <div className="search">
        <span className="ico">🔍</span>
        <input
          id="archiveQ"
          value={query}
          spellCheck={false}
          placeholder="预览内定位：番剧名 / 中文名 / 文件名 / year:2021 / month:04 / ep:04 / type:sp"
          onChange={e => setQuery(e.target.value)}
        />
        {query && <span className="clear" onClick={() => setQuery('')}>✕</span>}
      </div>
      <div className="chips">
        {CHIPS.map(c => (
          <span key={c.key} className={`chip${filter === c.key ? ' on' : ''}`} onClick={() => setFilter(c.key)}>
            {c.label}
          </span>
        ))}
      </div>
      <div className="seg" id="segView">
        <span className={treeView === 'tree' ? 'on' : ''} onClick={() => setTreeView('tree')}>树形视图</span>
        <span className={treeView === 'diff' ? 'on' : ''} onClick={() => setTreeView('diff')}>对照列表</span>
      </div>
      <button onClick={() => void scan()} disabled={!!busy || !serviceOnline}>↻ 扫描并生成方案</button>
    </div>
  );
}

/** 列表分批渲染的批大小（分组 / 卡片内条目） */
const GROUP_CHUNK = 40;
const ITEM_CHUNK = 40;

/**
 * 渐进式渲染：先画前 N 个，滚到底再追加 N 个。
 *
 * 为什么要它：一次扫描动辄几百个分组、上千个文件行，
 * 全量塞进 DOM 会让页面滚动/输入都卡；而用户实际上只看最前面那几个。
 */function useLazyCount(total: number, step: number, resetKey: string) {
  const [shown, setShown] = useState(step);
  // 换搜索词 / 换筛选 / 换方案 → 回到第一批
  useEffect(() => { setShown(step); }, [resetKey, total, step]);
  const more = useCallback(
    () => setShown(v => (v >= total ? v : Math.min(total, v + step))),
    [total, step]
  );
  const visible = Math.min(shown, total);
  return { visible, more, hasMore: visible < total };
}

/** 滚到底部附近时追加（取 600px 提前量，滚起来不会“卡空”） */
function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 600;
}

/** 列表底部的「已显示 N / M」提示与「加载更多」按钮 */
function LazyFooter({ shown, total, hasMore, onMore }: {
  shown: number; total: number; hasMore: boolean; onMore: () => void;
}) {
  if (total <= shown && !hasMore) {
    return total > GROUP_CHUNK ? <div className="lazy-foot">— 已显示全部 {total} 项 —</div> : null;
  }
  return (
    <div className="lazy-foot">
      已显示 <b>{shown}</b> / {total} 项
      <button className="mini" onClick={onMore}>加载更多</button>
    </div>
  );
}

/* =========================================================
   左侧：原始文件区
   ========================================================= */

/**
 * 「空列表」提示：不能一律写「尚未扫描」。
 *
 * 用户扫描完发现源目录里没有新视频时，界面原来仍旧显示「尚未扫描」
 * ⇒ 看起来像扫描压根没跑。这里改成根据 `scanInfo` / 上次扫描快照**分档说明**：
 *  ① 上次结果里的文件已全部归档完成 → 告诉他「都处理完了」，并给「扫描新文件」
 *  ② 扫过了但一个视频都没找到 → 报出扫描数字（忽略/排除多少）+ 该检查什么
 *  ③ 扫过了、也扫到了文件，但没形成分组 → 说明并给出重新扫描入口
 *  ④ 真的没扫过 → 保留原来的引导文案
 *
 * `variant='source'`（原始文件区）与 `'target'`（归档结果区 / 对照列表）只是措辞不同，
 * 判定逻辑完全一样。
 */
function EmptyHint({ variant }: { variant: 'source' | 'target' }) {
  const scanInfo = useApp(s => s.scanInfo);
  const snapshot = useApp(s => s.snapshot);
  const busy = useApp(s => s.busy);
  const scan = useApp(s => s.scan);
  const isSrc = variant === 'source';

  /** 为真时在提示下方给一个「重新扫描」入口 */
  let title: string;
  let detail: ReactNode;
  let scanBtn = false;

  if (snapshot && snapshot.groups === 0) {
    // ① 服务端快照被裁剪成空 = 上次扫出来的项已经全部归档完成
    title = isSrc ? '上次扫描的文件已全部归档完成' : '没有待归档的目标';
    detail = (
      <>
        上次扫描时间 <span className="mono">{formatStamp(snapshot.savedAt)}</span>。
        <br />
        把新文件放进源目录后，点 <code>↻ 扫描并生成方案</code> 即可。
      </>
    );
    scanBtn = true;
  } else if (scanInfo) {
    // ② / ③ 本次会话确实扫过了 —— 按扫描结果里的数字说清楚
    const { files, dirs, skippedNonVideo, excluded } = scanInfo;
    const nums = `扫描结果：视频 ${files} 个 / 文件夹 ${dirs} 个` +
      (skippedNonVideo ? ` · 已忽略非视频 ${skippedNonVideo} 个` : '') +
      (excluded ? ` · 已排除归档目录内 ${excluded} 项` : '');
    if (!files) {
      title = isSrc ? '扫描完成，但源目录里没有视频文件' : '没有可归档的目标';
      detail = (
        <>
          {nums}。
          <br />
          可能原因：已经全部归档过了（归档后的文件在归档根目录里，不再重复扫描）；
          或者上面「源目录」填的不是待归档目录。
          <br />
          确认源目录里有新文件后，点 <code>↻ 扫描并生成方案</code> 再扫一次。
        </>
      );
    } else {
      title = isSrc ? '扫描完成，但没有可归档的分组' : '没有可归档的目标';
      detail = (
        <>
          {nums}，但都没有形成归档分组（多数情况是这些文件已经处理过了）。
          <br />
          若刚往源目录里放了新文件，再点一次 <code>↻ 扫描并生成方案</code>。
        </>
      );
    }
    scanBtn = true;
  } else {
    // ④ 真的还没扫过
    title = isSrc ? '尚未扫描' : '没有匹配的归档目标';
    detail = isSrc ? (
      <>填写上方「源目录」与「归档根目录」，点击 <code>↻ 扫描并生成方案</code></>
    ) : (
      <>检索条件可能过于严格</>
    );
  }

  return (
    <div className="empty">
      {title}
      <br />
      {detail}
      {scanBtn && (
        <div style={{ marginTop: 12 }}>
          <button className="mini" onClick={() => void scan()} disabled={!!busy}>↻ 扫描并生成方案</button>
        </div>
      )}
    </div>
  );
}

function SourcePanel() {
  const groups = useApp(s => s.groups);
  const query = useApp(s => s.query);
  const filter = useApp(s => s.filter);
  const doneSet = useApp(s => s.doneSet);
  const sourceRoot = useApp(s => s.sourceRoot);

  const done = useMemo(() => new Set(doneSet), [doneSet]);
  const pq = useMemo(() => parseQuery(query), [query]);
  const list = useMemo(
    () => groups.filter(g => matchGroup(g, pq, filter, done)),
    [groups, pq, filter, done]
  );
  const lazy = useLazyCount(list.length, GROUP_CHUNK, `${query}|${filter}|${groups.length}`);
  const shown = list.slice(0, lazy.visible);

  return (
    <section className="panel">
      <div className="panel-head">
        <span>📥 原始文件区</span>
        <span className="hint">源目录：{sourceRoot || '（未填写）'} · 共 {list.length} / {groups.length} 组</span>
      </div>
      <div
        className="panel-body"
        id="sourceList"
        onScroll={e => { if (lazy.hasMore && nearBottom(e.currentTarget)) lazy.more(); }}
      >
        {!groups.length && <EmptyHint variant="source" />}
        {groups.length > 0 && !list.length && (
          <div className="empty">
            没有匹配的文件组<br />
            试试清空检索条件，或使用 <code>year:2021</code> 这类语法
          </div>
        )}
        {shown.map(g => <GroupCard key={g.groupId} group={g} terms={pq.terms} done={done.has(g.groupId)} />)}
        {list.length > 0 && (
          <LazyFooter shown={lazy.visible} total={list.length} hasMore={lazy.hasMore} onMore={lazy.more} />
        )}
      </div>
    </section>
  );
}

function GroupCard({ group, terms, done }: { group: AnimeGroup; terms: string[]; done: boolean }) {  const expanded = useApp(s => s.expanded[group.groupId] !== false);
  const toggleExpanded = useApp(s => s.toggleExpanded);
  const setLinked = useApp(s => s.setLinked);
  const linkedGroupId = useApp(s => s.linkedGroupId);
  const decision = useApp(s => s.decisionOf(group.groupId, group.status));
  const setDecision = useApp(s => s.setDecision);
  const selected = useApp(s => s.selected.includes(group.groupId));
  const toggleSelect = useApp(s => s.toggleSelect);
  const allGroups = useApp(s => s.groups);
  const overriddenPaths = useApp(s => s.overriddenPaths);
  const removeItemOverride = useApp(s => s.removeItemOverride);
  const removeItemsOverride = useApp(s => s.removeItemsOverride);
  const [dialog, setDialog] = useState<null | 'conflict' | 'resolve' | 'rename'>(null);
  /** 待「单独调整」的条目（≥1 个都走同一个弹窗：1 个 = 单个，多个 = 批量） */
  const [moveItems, setMoveItems] = useState<MoveItemTarget[] | null>(null);
  /** 文件列表里勾选的条目（按源路径记） */
  const [picked, setPicked] = useState<string[]>([]);
  const overridden = useMemo(() => new Set(overriddenPaths), [overriddenPaths]);
  const isSplitGroup = group.rawKey.startsWith('__manual_item__');

  const pickedSet = useMemo(() => new Set(picked), [picked]);
  const allPicked = group.items.length > 0 && picked.length === group.items.length;
  const togglePick = (p: string) =>
    setPicked(prev => (prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]));
  const targetsOf = (paths: string[]): MoveItemTarget[] =>
    group.items
      .filter(it => paths.includes(it.scanItem.path))
      .map(it => ({ path: it.scanItem.path, name: it.scanItem.name, isDir: it.scanItem.isDir }));

  /** 条目很多的分组先只画前 ITEM_CHUNK 行，避免上千行一起渲染导致掉帧 */
  const [showAllItems, setShowAllItems] = useState(false);

  const st: GroupStatus = done ? 'done' : group.status;
  const conf = group.resolution?.confidence ?? 0;
  const sameKeyCount = allGroups.filter(x => x.rawKey === group.rawKey && x.groupId !== group.groupId).length;

  const foot = () => {
    if (st === 'conflict') {
      return (
        <div className="card-foot">
          <button className="mini conflict-btn" onClick={() => setDialog('conflict')}>⚙ 处理冲突</button>
          <span className="ft-hint">目标已存在同名文件，需选择处理方式</span>
        </div>
      );
    }
    if (st === 'review') {
      return (
        <div className="card-foot">
          <button className="mini resolve-btn" onClick={() => setDialog('resolve')}>🔎 确认名称</button>
          <label className="ft-hint" style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={decision.execute}
              onChange={e => setDecision(group.groupId, { execute: e.target.checked })}
              style={{ accentColor: 'var(--accent)' }}
            />
            确认后一并归档
          </label>
        </div>
      );
    }
    if (st === 'unrecognized') {
      return (
        <div className="card-foot">
          <button className="mini resolve-btn" onClick={() => setDialog('resolve')}>🔎 指定番剧名</button>
          <label className="ft-hint" style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={decision.execute}
              onChange={e => setDecision(group.groupId, { execute: e.target.checked })}
              style={{ accentColor: 'var(--accent)' }}
            />
            移入 <code>_未识别/</code>（不误归档）
          </label>
        </div>
      );
    }
    if (st === 'deferred') {
      return (
        <div className="card-foot">
          <span className="ft-hint" style={{ color: '#ffd47a' }}>⏸ 已暂不处理，将移入 _待确认/</span>
          <label className="ft-hint" style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={decision.execute}
              onChange={e => setDecision(group.groupId, { execute: e.target.checked })}
              style={{ accentColor: 'var(--accent)' }}
            />
            一并移入
          </label>
        </div>
      );
    }
    if (st === 'skipped') {
      return <div className="card-foot"><span className="ft-hint" style={{ color: '#ffbd85' }}>⏭ 已选择跳过，该文件不会归档</span></div>;
    }
    if (group.resolved) {
      return (
        <div className="card-foot">
          <span className="ft-hint" style={{ color: '#7fe6bf' }}>
            ✅ 已人工确认{group.saveAlias ? '，别名已写回本地别名表' : ''}
          </span>
          <button className="mini" onClick={() => setDialog('rename')}>✏️ 改目标文件夹名</button>
        </div>
      );
    }
    return (
      <div className="card-foot">
        <span className="ft-hint" style={{ color: '#7fe6bf' }}>✅ 高置信度，将自动归档</span>
        <button className="mini" onClick={() => setDialog('rename')}>✏️ 改目标文件夹名</button>
        <label className="ft-hint" style={{ cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={decision.execute}
            onChange={e => setDecision(group.groupId, { execute: e.target.checked })}
            style={{ accentColor: 'var(--accent)' }}
          />
          参与本次归档
        </label>
      </div>
    );
  };

  return (
    <div
      className={`card ${st}${linkedGroupId === group.groupId ? ' linked' : ''}${selected ? ' picked' : ''}`}
      data-card={group.groupId}
      onMouseEnter={() => setLinked(group.groupId)}
      onMouseLeave={() => setLinked(null)}
    >
      <div className="card-main">
        <div className="name-row">
          <input
            type="checkbox"
            className="pick"
            checked={selected}
            title="勾选后可批量确认名称"
            onClick={e => e.stopPropagation()}
            onChange={() => toggleSelect(group.groupId)}
            style={{ accentColor: 'var(--accent)', flex: 'none' }}
          />
          <span className="raw-name" dangerouslySetInnerHTML={{ __html: highlight(group.rawNames.join(' / ') || '—', terms) }} />
          <span className="to-arrow">➜</span>
          {group.zhName ? (
            <span className="zh-name" dangerouslySetInnerHTML={{ __html: highlight(group.zhName, terms) }} />
          ) : (
            <span className="zh-name" style={{ color: '#ff9aa5' }}>❓ 未识别</span>
          )}
        </div>
        <div className="meta">
          <span className={`pill ${STATUS_CLASS[st]}`}>{STATUS_TEXT[st]}</span>
          {group.year ? <span className="pill src">{group.year} 年 {pad(group.month)} 月</span> : <span className="pill">未定年月</span>}
          <span className="pill">置信度 {(conf * 100).toFixed(0)}%</span>
          <span className="pill">匹配层级 {group.resolution?.matchLevel ?? '—'}</span>
          <span className="pill">来源 {sourceLabel(group.resolution?.dataSource)}</span>
          {group.releaseGroup && <span className="pill">{group.releaseGroup}</span>}
          <span className="pill">{group.items.length} 项 · {formatSize(group.totalSize)}</span>
        </div>
        {group.note && <div className="meta"><span className={`pill ${STATUS_CLASS[st]}`}>ⓘ {group.note}</span></div>}
        {(group.resolution?.note || group.resolution?.timeNote) && (
          <div className="meta">
            {group.resolution?.note && (
              <span className="pill web">🔎 {group.resolution.note}</span>
            )}
            {group.resolution?.timeNote && (
              <span className="pill time">🕒 {group.resolution.timeNote}</span>
            )}
          </div>
        )}
        <div className="target-line">📂 {groupTargetDir(group)}</div>
        <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--txt-3)', cursor: 'pointer' }}
             onClick={e => { e.stopPropagation(); toggleExpanded(group.groupId); }}>
          {expanded ? '▾' : '▸'} {group.items.length} 个文件/文件夹
        </div>
      </div>

      {expanded && (
        <div className="items-head">
          <label className="ih-all" onClick={e => e.stopPropagation()}>
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() => setPicked(allPicked ? [] : group.items.map(it => it.scanItem.path))}
              style={{ accentColor: 'var(--accent)', flex: 'none' }}
            />
            全选
          </label>
          <span className="ih-hint">
            {picked.length
              ? <>已选 <b>{picked.length}</b> / {group.items.length} 项，可一次归到同一部番剧</>
              : '勾选多个文件后可「批量分开归档」'}
          </span>
          <span className="spacer" />
          {picked.length > 0 && (
            <>
              <button className="mini" onClick={() => setMoveItems(targetsOf(picked))}>
                {picked.length > 1 ? `↗ 批量分开归档（${picked.length}）` : '↗ 分开归档'}
              </button>
              <button className="mini ghost" onClick={() => setPicked([])}>清空</button>
            </>
          )}
        </div>
      )}

      {expanded && (
        <ul className="items">
          {group.items.slice(0, showAllItems ? group.items.length : ITEM_CHUNK).map((it, i) => {
            const isOverridden = overridden.has(it.scanItem.path);
            const isPicked = pickedSet.has(it.scanItem.path);
            const cls = [isOverridden ? 'overridden' : '', isPicked ? 'picked' : ''].filter(Boolean).join(' ');
            return (
              <li
                key={`${group.groupId}-${i}`}
                className={cls || undefined}
                /* 整行可勾选（用户要求）：条目是**最小单元**，本身不可再展开 ⇒ 点行上的任意位置都算勾选 */
                onClick={() => { if (!isTextSelecting()) togglePick(it.scanItem.path); }}
                title="点这一行任意位置即可勾选（行内的按钮不受影响）"
              >
                <input
                  type="checkbox"
                  className="pick-item"
                  checked={isPicked}
                  title="勾选后可与其它文件一起「批量分开归档」（也可以直接点这一行任意位置）"
                  onClick={e => e.stopPropagation()}
                  onChange={() => togglePick(it.scanItem.path)}
                  style={{ accentColor: 'var(--accent)', flex: 'none' }}
                />
                <span className="ep-badge">{padEpisode(it.parsed.episode) || '—'}</span>
                <span className={`fname${it.scanItem.isDir ? ' dir-badge' : ''}`}>
                  {it.scanItem.isDir ? '📁' : '🎬'}{' '}
                  <span dangerouslySetInnerHTML={{ __html: highlight(it.scanItem.name, terms) }} />
                </span>
                {it.renameTo
                  ? <span className="fsize" style={{ color: '#7fe6bf' }}>→ {it.renameTo}</span>
                  : <span className="fsize">
                      {it.scanItem.isDir ? `内含 ${it.scanItem.childCount} 个文件 · ` : ''}
                      {formatSize(it.scanItem.size)}
                    </span>}
                {/*
                  两个时间都要看：
                   - 创建时间：文件生成 / 拷入当前位置的时间（批量拷入时整批一样，参考价值有限）
                   - 修改时间：文件自身的时间，通常就是这一集的发布时间（参与置信度加权）
                */}
                <span
                  className="ftime"
                  title={`创建时间：${it.scanItem.btime ? formatTime(it.scanItem.btime) : '未知（旧扫描结果，重新扫描后显示）'}\n文件生成 / 拷入当前位置的时间`}
                ><b>创建</b>{formatDateTime(it.scanItem.btime)}</span>
                <span
                  className="ftime mt"
                  title={`修改时间：${it.scanItem.mtime ? formatTime(it.scanItem.mtime) : '未知'}\n文件自身的时间，通常就是该集的发布时间（参与置信度加权）`}
                ><b>修改</b>{formatDateTime(it.scanItem.mtime)}</span>
                <span className="item-actions">
                  {isOverridden && (
                    <button
                      className="mini ghost"
                      title="取消单独调整，该文件回到原分组"
                      onClick={e => { e.stopPropagation(); void removeItemOverride(it.scanItem.path); }}
                    >↩</button>
                  )}
                  <button
                    className="mini ghost"
                    title="把该文件/文件夹单独归到其它番剧（勾选多个可批量）"
                    onClick={e => {
                      e.stopPropagation();
                      setMoveItems([{ path: it.scanItem.path, name: it.scanItem.name, isDir: it.scanItem.isDir }]);
                    }}
                  >↗</button>
                </span>
              </li>
            );
          })}
          {!showAllItems && group.items.length > ITEM_CHUNK && (
            <li className="items-more">
              <button className="mini" onClick={() => setShowAllItems(true)}>
                还有 {group.items.length - ITEM_CHUNK} 项 · 显示全部
              </button>
              <span className="ft-hint" style={{ marginLeft: 8 }}>
                （逐个渲染上千行会很卡，所以先只画前 {ITEM_CHUNK} 项）
              </span>
            </li>
          )}
        </ul>
      )}

      {isSplitGroup && (
        <div className="card-foot">
          <span className="ft-hint" style={{ color: '#8fd0ff' }}>
            ↗ 该分组由「单独调整」拆出
            {group.items.length > 1 ? `（${group.items.length} 个条目一起调整）` : ''}
          </span>
          <button
            className="mini"
            onClick={() => { void removeItemsOverride(group.items.map(it => it.scanItem.path)); }}
          >↩ 取消调整{group.items.length > 1 ? `（${group.items.length} 项）` : ''}</button>
        </div>
      )}

      {foot()}

      {dialog === 'conflict' && <ConflictHost group={group} onClose={() => setDialog(null)} />}
      {dialog === 'resolve' && <ResolveHost group={group} sameKeyCount={sameKeyCount} onClose={() => setDialog(null)} />}
      {dialog === 'rename' && <RenameHost group={group} onClose={() => setDialog(null)} />}
      {moveItems && (
        <MoveItemHost
          group={group}
          items={moveItems}
          onClose={() => setMoveItems(null)}
          onDone={() => setPicked([])}
        />
      )}
    </div>
  );
}

function MoveItemHost({
  group, items, onClose, onDone
}: { group: AnimeGroup; items: MoveItemTarget[]; onClose: () => void; onDone: () => void }) {
  const moveItemsToAnime = useApp(s => s.moveItemsToAnime);
  const animeDirs = useApp(s => s.animeDirs);
  const targetRoot = useApp(s => s.targetRoot);
  const current = `${targetRoot.replace(/[\\/]+$/, '')}\\${groupTargetDir(group)}`;
  const planDirs = usePlanDirs([group.groupId]);
  return (
    <MoveItemDialog
      items={items}
      currentTarget={current}
      loadDirs={animeDirs}
      planDirs={planDirs}
      onClose={onClose}
      onApply={p => {
        void moveItemsToAnime(items.map(i => i.path), { zhName: p.zhName, year: p.year, month: p.month });
        onDone();
        onClose();
      }}
    />
  );
}

/* 弹窗宿主：把 store 里的 action 注入到通用弹窗组件 */
function ConflictHost({ group, onClose }: { group: AnimeGroup; onClose: () => void }) {
  const applyConflict = useApp(s => s.applyConflict);
  const targetRoot = useApp(s => s.targetRoot);
  return (
    <ConflictDialog
      group={group}
      targetRoot={targetRoot}
      onClose={onClose}
      onApply={strategy => { void applyConflict(group.groupId, strategy); onClose(); }}
    />
  );
}

function ResolveHost({ group, sameKeyCount, onClose }: { group: AnimeGroup; sameKeyCount: number; onClose: () => void }) {
  const resolveGroup = useApp(s => s.resolveGroup);
  const animeDirs = useApp(s => s.animeDirs);
  const planDirs = usePlanDirs([group.groupId]);
  return (
    <ResolveDialog
      groups={[group]}
      loadDirs={animeDirs}
      planDirs={planDirs}
      sameKeyCount={sameKeyCount}
      onClose={onClose}
      onApply={p => {
        void resolveGroup(group.groupId, {
          zhName: p.zhName, year: p.year, month: p.month,
          saveAlias: p.saveAlias, applySameKey: p.applySameKey
        });
        onClose();
      }}
      onDefer={p => {
        void resolveGroup(group.groupId, {
          zhName: p.zhName || group.zhName || group.rawNames[0] || '未确认',
          year: p.year || group.year || 0,
          month: p.month || group.month || 0,
          saveAlias: false,
          applySameKey: false,
          deferred: true
        });
        onClose();
      }}
    />
  );
}

function RenameHost({ group, onClose }: { group: AnimeGroup; onClose: () => void }) {
  const renameGroupFolder = useApp(s => s.renameGroupFolder);
  const targetRoot = useApp(s => s.targetRoot);
  const root = targetRoot.replace(/[\\/]+$/, '');
  return (
    <RenameDialog
      title="✏️ 重命名番剧文件夹（归档方案）"
      initial={group.zhName}
      locationHint={`${root}\\${group.year ?? '?'}\\${pad(group.month ?? '?')}\\<文件夹名>\\`}
      note={
        <>
          ℹ 只改<b>番剧文件夹</b>这一层：<code>{'{年份}/{月份}'}</code> 与里面的<b>文件名都不会改动</b>。
          此处仅影响归档方案，不会动源文件，需重新执行归档才生效。
        </>
      }
      onClose={onClose}
      onApply={v => { void renameGroupFolder(group.groupId, v); onClose(); }}
    />
  );
}

/* =========================================================
   右侧：归档结果区 / 对照列表
   ========================================================= */

function TargetPanel() {
  const groups = useApp(s => s.groups);
  const plan = useApp(s => s.plan);
  const query = useApp(s => s.query);
  const filter = useApp(s => s.filter);
  const treeView = useApp(s => s.treeView);
  const doneSet = useApp(s => s.doneSet);

  const done = useMemo(() => new Set(doneSet), [doneSet]);
  const pq = useMemo(() => parseQuery(query), [query]);
  const list = useMemo(
    () => groups.filter(g => matchGroup(g, pq, filter, done)),
    [groups, pq, filter, done]
  );

  /* 一个分组都没有（不是被筛选掉）→ 用「按真实原因分档」的提示，别一律说「检索条件太严」 */
  const emptyWhenNone = groups.length ? undefined : <EmptyHint variant="target" />;

  return (
    <section className="panel">
      <div className="panel-head">
        <span id="targetTitle">{treeView === 'diff' ? '📋 归档对照列表' : '📂 归档结果区'}</span>
        <span className="hint">
          {treeView === 'diff'
            ? `原路径 ➜ 归档后路径（共 ${plan?.entries.length ?? 0} 条）· 每条都有 ↗ 可二次改归`
            : '年份 / 月份 / 官方中文名 · 每行 ↗ 可二次改归'}
        </span>
      </div>
      <div className="panel-body" id="targetList">
        {treeView === 'diff'
          ? <DiffTable groups={list} terms={pq.terms} emptyWhenNone={emptyWhenNone} />
          : <TargetTree groups={list} terms={pq.terms} done={done} emptyWhenNone={emptyWhenNone} />}
      </div>
    </section>
  );
}

function TargetTree({ groups, terms, done, emptyWhenNone }: {
  groups: AnimeGroup[]; terms: string[]; done: Set<string>;
  /** 一个分组都没有（不是被筛选掉）时展示的提示；调用方决定说什么 */
  emptyWhenNone?: ReactNode;
}) {
  const collapsed = useApp(s => s.collapsed);
  const toggleCollapsed = useApp(s => s.toggleCollapsed);
  const setCollapsed = useApp(s => s.setCollapsed);
  const setLinked = useApp(s => s.setLinked);
  const linkedGroupId = useApp(s => s.linkedGroupId);
  const [renaming, setRenaming] = useState<AnimeGroup | null>(null);
  const [moving, setMoving] = useState<{ items: MoveEntry[]; currentTarget: string } | null>(null);

  /**
   * 已经真正落到磁盘上的文件（按「原始路径」索引）。
   *
   * 有了它才能判断某一行到底「只是方案」还是「文件已经在归档目录里」：
   *  - 已在磁盘 → 可以真的把文件移到别的番剧（/api/library/move）
   *  - 仅在方案里 → 只能改方案（记入方案记忆）
   * 用 originPath 而不是目标路径来配对，是因为冲突时目标可能被改成了 `(1)`。
   */
  const archivedByOrigin = useArchivedByOrigin();
  const planDirsForMove = usePlanDirs([]);

  /** 把这一组的所有条目整理成「待二次操作」列表（哪些已在磁盘、哪些还只是方案） */
  const groupMoveEntries = (g: AnimeGroup): MoveEntry[] =>
    g.items.map((it, i) => ({
      path: it.scanItem.path,
      name: entryTargetName(g, i),
      isDir: it.scanItem.isDir,
      archivedPath: archivedByOrigin.get(it.scanItem.path.toLowerCase())?.fullPath
    }));

  const groupLabel = (g: AnimeGroup): string =>
    `${g.year ?? '?'}\\${pad(g.month ?? '?')}\\${g.zhName || '未识别'}`;

  const years = useMemo(() => {
    const map = new Map<number, Map<number, AnimeGroup[]>>();
    groups.forEach(g => {
      const st: GroupStatus = done.has(g.groupId) ? 'done' : g.status;
      let y: number;
      let m: number;
      if (st === 'unrecognized') { y = 0; m = 0; }
      else if (st === 'deferred' || g.year === null || g.month === null) { y = -1; m = 0; }
      else { y = g.year; m = g.month; }
      if (!map.has(y)) map.set(y, new Map());
      const mm = map.get(y)!;
      if (!mm.has(m)) mm.set(m, []);
      mm.get(m)!.push(g);
    });
    return Array.from(map.entries()).sort((a, b) => b[0] - a[0]);
  }, [groups, done]);

  if (!groups.length) {
    return <>{emptyWhenNone ?? <div className="empty">没有匹配的归档目标<br />检索条件可能过于严格</div>}</>;
  }

  /**
   * 组数很多时，**月份默认折叠**（年份仍然展开）。
   *
   * 归档树里每个分组会展开成它所有的文件行（实测 742 组 / 8286 行），
   * 全量渲染会让页面首次加载就卡住。默认只画「年 + 月」两层
   * （几十行），想看哪个月份就点哪个 —— 这才是「按需加载」在树上的自然形态。
   */
  const autoCollapseMonths = groups.length > 60;
  const monthCollapsed = (key: string): boolean =>
    collapsed[key] === undefined ? autoCollapseMonths : !!collapsed[key];

  return (
    <div className="tree">
      <div className="tree-hint">
        ℹ 每行的 <b>↗</b> 都是「改归档目标」：<b>已经在磁盘上</b>的文件会被<b>真实移动</b>（媒体库同步更新）；
        <b>还没搬</b>的只改方案（记入方案记忆，下次执行归档生效）。番剧名那一行的 <b>↗</b> 是整组调整。
      </div>
      {autoCollapseMonths && (
        <div className="tree-hint">
          ℹ 共有 {groups.length} 个分组，为保流畅**月份默认折叠**：点月份行即可展开（展开才即时渲染）
        </div>
      )}
      {years.map(([y, months]) => {
        const yKey = `y${y}`;
        const yCollapsed = !!collapsed[yKey];
        const yCount = Array.from(months.values()).reduce((a, arr) => a + arr.reduce((x, g) => x + g.items.length, 0), 0);
        const yLabel = y === 0 ? '⚠ _未识别' : y === -1 ? '⚠ _待确认' : `${y} 年`;
        const monthList = Array.from(months.entries()).sort((a, b) => b[0] - a[0]);

        return (
          <div className="node-year" key={yKey}>
            <div className={`row${yCollapsed ? ' collapsed' : ''}`} onClick={() => toggleCollapsed(yKey)}>
              <span className="caret">▼</span>
              <span className="label">📅 {yLabel}</span>
              <span className="count">{yCount} 项</span>
            </div>
            {!yCollapsed && (
            <div className="children">
              {monthList.map(([m, gs]) => {
                const mKey = `${yKey}-m${m}`;
                const mCollapsed = monthCollapsed(mKey);
                const mCount = gs.reduce((a, g) => a + g.items.length, 0);
                return (
                  <div className="node-month" key={mKey}>
                    <div className={`row${mCollapsed ? ' collapsed' : ''}`}
                         onClick={() => setCollapsed(mKey, !mCollapsed)}>
                      <span className="caret">▼</span>
                      <span className="label">🗓 {m === 0 ? '未分类' : `${pad(m)} 月`}</span>
                      <span className="count">{mCount} 项</span>
                    </div>
                    {/* ⚠ 折叠时**不要渲染**子树：
                        以前只是加 .hidden（display:none），8000+ 个文件行仍然会建 DOM，
                        打开页面依旧要几秒。现在真正不建节点，展开时才渲染。 */}
                    {!mCollapsed && (
                    <div className="children">
                      {gs.map(g => {
                        const st: GroupStatus = done.has(g.groupId) ? 'done' : g.status;
                        const dot = STATUS_COLOR[st];
                        const nodeId = `node-${g.groupId}`;
                        return (
                          <div
                            className={`node-anime${linkedGroupId === g.groupId ? ' linked' : ''}`}
                            data-node={g.groupId}
                            id={nodeId}
                            key={g.groupId}
                            onMouseEnter={() => setLinked(g.groupId)}
                            onMouseLeave={() => setLinked(null)}
                          >
                            <div className="row" style={{ cursor: 'default' }}>
                              <span className="label" dangerouslySetInnerHTML={{ __html: `📁 ${g.zhName ? highlight(g.zhName, terms) : '❓ 未识别'}` }} />
                              <span className={`pill ${STATUS_CLASS[st]}`} style={{ marginLeft: 6 }}>{STATUS_TEXT[st]}</span>
                              <span className="count">{g.items.length} 项</span>
                              <button
                                className="mini"
                                title="重命名目标文件夹（仅文件夹名）"
                                onClick={e => { e.stopPropagation(); setRenaming(g); }}
                              >
                                ✏️
                              </button>
                              <button
                                className="mini"
                                title={`把这一组（${g.items.length} 项）整体改到另一部番剧（已归档的真实移动，未归档的改方案）`}
                                onClick={e => {
                                  e.stopPropagation();
                                  setMoving({ items: groupMoveEntries(g), currentTarget: groupLabel(g) });
                                }}
                              >
                                ↗
                              </button>
                            </div>
                            {g.items.map((it, i) => {
                              const archived = archivedByOrigin.get(it.scanItem.path.toLowerCase());
                              return (
                              <div className="file-row" key={`${g.groupId}-r${i}`}>
                                <span className="dot" style={{ background: dot }} />
                                <span className="fname">
                                  {it.scanItem.isDir ? '📁' : '🎬'}{' '}
                                  <span dangerouslySetInnerHTML={{ __html: highlight(entryTargetName(g, i), terms) }} />
                                </span>
                                {it.renameTo && <span className="from" style={{ color: '#7fe6bf' }}>冲突重命名</span>}
                                <span className="from">← 来自 {it.parsed.animeRawName || it.scanItem.name}</span>
                                <button
                                  className={`mini${archived ? '' : ' ghost'}`}
                                  title={archived
                                    ? '这个文件已经归档在磁盘上了：点此把它真实移动到另一部番剧'
                                    : '这个条目还没搬：点此改它的归档目标（记入方案记忆，下次执行归档生效）'}
                                  onClick={e => {
                                    e.stopPropagation();
                                    setMoving({
                                      items: [{
                                        path: it.scanItem.path,
                                        name: it.scanItem.name,
                                        isDir: it.scanItem.isDir,
                                        archivedPath: archived?.fullPath
                                      }],
                                      currentTarget: groupLabel(g)
                                    });
                                  }}
                                >↗</button>
                              </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                    )}
                  </div>
                );
              })}
            </div>
            )}
          </div>
        );
      })}

      {renaming && (
        <TargetRenameHost group={renaming} onClose={() => setRenaming(null)} />
      )}

      {moving && (
        <EntryMoveHost
          items={moving.items}
          currentTarget={moving.currentTarget}
          planDirs={planDirsForMove}
          onClose={() => setMoving(null)}
        />
      )}
    </div>
  );
}

/**
 * 已经真正落到磁盘上的文件，按「原始路径」索引。
 *
 * 有了它才能判断某一行到底「只是方案」还是「文件已经在归档目录里」：
 *  - 已在磁盘 → 可以真的把文件移到别的番剧（`/api/library/move`）
 *  - 仅在方案里 → 只能改方案（记入方案记忆）
 * 用 `originPath` 而不是目标路径配对，是因为冲突时目标可能被改成了 `(1)`。
 */
function useArchivedByOrigin(): Map<string, { fullPath: string; name: string; isDir: boolean }> {
  const library = useApp(s => s.library);
  return useMemo(() => {
    const m = new Map<string, { fullPath: string; name: string; isDir: boolean }>();
    (library?.anime ?? []).forEach(a => a.files.forEach(f => {
      if (f.originPath) m.set(f.originPath.toLowerCase(), { fullPath: f.fullPath, name: f.name, isDir: false });
    }));
    return m;
  }, [library]);
}

/** 待二次操作的条目：`archivedPath` 有值 = 文件已经在磁盘上，需要真实移动 */

function TargetRenameHost({ group, onClose }: { group: AnimeGroup; onClose: () => void }) {
  const renameGroupFolder = useApp(s => s.renameGroupFolder);
  const targetRoot = useApp(s => s.targetRoot);
  const root = targetRoot.replace(/[\\/]+$/, '');
  return (
    <RenameDialog
      title="✏️ 重命名番剧文件夹（归档方案）"
      initial={group.zhName}
      locationHint={`${root}\\${group.year ?? '?'}\\${pad(group.month ?? '?')}\\<文件夹名>\\`}
      note={
        <>
          ℹ 只改<b>番剧文件夹</b>这一层：<code>{'{年份}/{月份}'}</code> 与里面的<b>文件名都不会改动</b>。
          此处仅修改归档方案，立即反映到对照列表；需重新执行归档才会生效。
        </>
      }
      onClose={onClose}
      onApply={v => { void renameGroupFolder(group.groupId, v); onClose(); }}
    />
  );
}

function DiffTable({ groups, terms, emptyWhenNone }: {
  groups: AnimeGroup[]; terms: string[];
  /** 一个分组都没有（不是被筛选掉）时展示的提示 */
  emptyWhenNone?: ReactNode;
}) {
  const plan = useApp(s => s.plan);
  const doneSet = useApp(s => s.doneSet);
  const sourceRoot = useApp(s => s.sourceRoot);
  const targetRoot = useApp(s => s.targetRoot);
  const [moving, setMoving] = useState<{ items: MoveEntry[]; currentTarget: string } | null>(null);
  const archivedByOrigin = useArchivedByOrigin();
  const planDirs = usePlanDirs([]);
  const done = useMemo(() => new Set(doneSet), [doneSet]);

  if (!groups.length) return <>{emptyWhenNone ?? <div className="empty">没有匹配记录</div>}</>;

  const entryMap = new Map((plan?.entries ?? []).map(e => [`${e.groupId}|${e.name}|${e.isDir}`, e]));
  const srcRoot = sourceRoot.replace(/[\\/]+$/, '');
  const dstRoot = targetRoot.replace(/[\\/]+$/, '');

  return (
    <>
    <table className="diff-table">
      <thead>
        <tr>
          <th style={{ width: 60 }}>状态</th>
          <th>原始路径</th>
          <th />
          <th>归档后路径</th>
          <th style={{ width: 74 }}>置信度</th>
          <th style={{ width: 40 }} title="二次操作：把这一条改归到另一部番剧">操作</th>
        </tr>
      </thead>
      <tbody>
        {groups.flatMap(g => {
          const st: GroupStatus = done.has(g.groupId) ? 'done' : g.status;
          const skipMark = st === 'unrecognized' || st === 'skipped';
          return g.items.map((it, i) => {
            const e = entryMap.get(`${g.groupId}|${it.scanItem.name}|${it.scanItem.isDir}`);
            const from = `${srcRoot}\\${it.scanItem.name}`;
            const to = e?.toPath ?? `${dstRoot}\\${groupTargetDir(g)}\\${it.parsed.subDir ? `${it.parsed.subDir}\\` : ''}${it.renameTo || it.scanItem.name}`;
            // 已经归档到磁盘的：换成真实磁盘路径，才能真的移动
            const archived = archivedByOrigin.get((it.scanItem.path || from).toLowerCase());
            return (
              <tr key={`${g.groupId}-${i}`}>
                <td><span className={`pill ${STATUS_CLASS[st]}`}>{STATUS_TEXT[st]}</span></td>
                <td className="diff-from" dangerouslySetInnerHTML={{ __html: `${skipMark ? '🚫 ' : ''}${highlight(from, terms)}` }} />
                <td className="diff-arrow">➜</td>
                <td className="diff-to" dangerouslySetInnerHTML={{ __html: highlight(to, terms) }} />
                <td style={{ color: '#697691' }}>{((g.resolution?.confidence ?? 0) * 100).toFixed(0)}%</td>
                <td>
                  <button
                    className={`mini${archived ? '' : ' ghost'}`}
                    title={archived
                      ? '已归档在磁盘上：点此真实移动到另一部番剧'
                      : '还没搬：点此改归档目标（记入方案记忆）'}
                    onClick={() => setMoving({
                      items: [{
                        path: it.scanItem.path || from,
                        name: it.scanItem.name,
                        isDir: it.scanItem.isDir,
                        archivedPath: archived?.fullPath
                      }],
                      currentTarget: e?.relTargetDir || `${g.year ?? '?'}\\${pad(g.month ?? '?')}\\${g.zhName}`
                    })}
                  >↗</button>
                </td>
              </tr>
            );
          });
        })}
      </tbody>
    </table>
    {moving && (
      <EntryMoveHost
        items={moving.items}
        currentTarget={moving.currentTarget}
        planDirs={planDirs}
        onClose={() => setMoving(null)}
      />
    )}
    </>
  );
}

/* =========================================================
   图例 / 状态栏 / 全局弹窗宿主
   ========================================================= */

function Legend() {
  const groups = useApp(s => s.groups);
  if (!groups.length) return null;
  return (
    <div className="legend">
      <span><i style={{ background: '#27c08a' }} />可归档（高置信度）</span>
      <span><i style={{ background: '#f2b632' }} />待确认（中置信度）</span>
      <span><i style={{ background: '#f2802b' }} />冲突（同名已存在）</span>
      <span><i style={{ background: '#ef5566' }} />未识别</span>
      <span><i style={{ background: '#3ba9ff' }} />已完成</span>
      <span>💡 悬停左侧卡片或右侧目录可双向高亮联动</span>
      <span>SP / OVA → <b>SP</b> 子目录；OP / ED / NC → <b>OP&amp;ED</b> 子目录</span>
      <span>✏️ 仅支持手动重命名<b>番剧文件夹名</b>；文件名永不改动</span>
      <span>↗ 归档结果区／对照列表每条都能<b>二次改归</b>：已归档的<b>真实移动</b>，未归档的只改方案</span>
    </div>
  );
}

function StatusBar() {
  const groups = useApp(s => s.groups);
  const plan = useApp(s => s.plan);
  const doneSet = useApp(s => s.doneSet);
  const scanInfo = useApp(s => s.scanInfo);
  const query = useApp(s => s.query);
  const filter = useApp(s => s.filter);
  const busy = useApp(s => s.busy);
  const toggleLog = useApp(s => s.toggleLog);
  const bulkDecision = useApp(s => s.bulkDecision);
  const serviceOnline = useApp(s => s.serviceOnline);
  const selected = useApp(s => s.selected);
  const setSelected = useApp(s => s.setSelected);
  const clearSelected = useApp(s => s.clearSelected);
  const restoredInfo = useApp(s => s.restoredInfo);
  const overriddenPaths = useApp(s => s.overriddenPaths);
  const clearPlanMemory = useApp(s => s.clearPlanMemory);

  if (!groups.length) return null;

  const done = new Set(doneSet);
  const st = (g: AnimeGroup): GroupStatus => (done.has(g.groupId) ? 'done' : g.status);
  const items = groups.reduce((a, g) => a + g.items.length, 0);
  const count = (s: GroupStatus) => groups.filter(g => st(g) === s).length;
  const pq = parseQuery(query);
  const visible = groups.filter(g => matchGroup(g, pq, filter, done));
  const filtered = query.trim() || filter !== 'all';

  return (
    <footer className="statusbar">
      <span className="stat"><span className="dot" style={{ background: '#7c5cff' }} />组 <b>{groups.length}</b></span>
      <span className="stat"><span className="dot" style={{ background: '#3ba9ff' }} />文件/文件夹 <b>{items}</b></span>
      <span className="stat"><span className="dot" style={{ background: '#27c08a' }} />可归档 <b>{count('ready') + count('done')}</b></span>
      <span className="stat"><span className="dot" style={{ background: '#f2b632' }} />待确认 <b>{count('review')}</b></span>
      <span className="stat"><span className="dot" style={{ background: '#f2802b' }} />冲突 <b>{count('conflict')}</b></span>
      <span className="stat"><span className="dot" style={{ background: '#ef5566' }} />未识别 <b>{count('unrecognized')}</b></span>
      {count('review') > 0 && (
        <span className="stat">
          <button
            className="mini"
            disabled={!serviceOnline}
            title="把全部待确认项按当前推荐名称直接加入归档方案"
            onClick={() => { bulkDecision('review', true); }}
          >
            ⚡ 一键全确认（{count('review')}）
          </button>
        </span>
      )}
      <span className="stat">
        <button
          className="mini"
          title="勾选当前筛选结果，可一次性批量指定番剧名"
          onClick={() => setSelected(visible.map(g => g.groupId))}
        >
          ☑ 选择筛选结果（{visible.length}）
        </button>
        {selected.length > 0 && (
          <button className="mini" onClick={() => clearSelected()}>✕ 清空选择（{selected.length}）</button>
        )}
        {(!!restoredInfo || overriddenPaths.length > 0) && (
          <button
            className="mini"
            title="删除本机保存的归档方案记忆，下次扫描从零开始"
            onClick={() => clearPlanMemory()}
          >
            🧹 清除方案记忆
          </button>
        )}
      </span>
      {filtered && <span className="stat" style={{ color: 'var(--txt-3)' }}>筛选结果：{query || filter}</span>}
      {scanInfo && (
        <span className="stat" style={{ color: 'var(--txt-3)' }}>
          扫描：视频 {scanInfo.files} / 文件夹 {scanInfo.dirs} / 排除归档目录 {scanInfo.excluded} 项
        </span>
      )}
      <div className="right">
        <div className={`progress-wrap${busy ? ' on' : ''}`}>
          <div className="progress-bar" style={{ width: `${busy?.percent ?? 0}%` }} />
        </div>
        <span className="stat" style={{ color: 'var(--txt-3)' }}>
          {plan ? `共 ${plan.entries.length} 项待处理` : '尚未生成方案'}
        </span>
        <button onClick={() => toggleLog()}>📜 变更日志</button>
      </div>
    </footer>
  );
}

/** 让「点左侧卡片 → 右侧滚动定位并闪烁」生效 */
function DialogHost() {
  const linkedGroupId = useApp(s => s.linkedGroupId);
  const lastRef = useRef<string | null>(null);

  if (linkedGroupId && lastRef.current !== linkedGroupId) {
    lastRef.current = linkedGroupId;
    // 在下一帧滚动定位（仅在用户主动点击卡片时视觉上可见）
    window.setTimeout(() => {
      const el = document.getElementById(`node-${linkedGroupId}`);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 60);
  }
  return null;
}
