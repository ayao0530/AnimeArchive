/**
 * 全局状态（Zustand）
 */
import { create } from 'zustand';
import {
  api, executeStream, probeService, scanStream, setApiPort
} from './api/client';
import type {
  AnimeGroup, AppConfig, ArchivePlan, EntryDecision, ExecuteState, GroupStatus,
  LibraryIndex, ScanSnapshot, StreamEvent
} from './types';
import { formatStamp, joinWinPath, nowTime } from './utils';
import {
  applyMemory, clearLocalSnapshot, clearMemory, loadLocalSnapshot, loadMemory, saveLocalSnapshot,
  saveMemory, type PlanMemory
} from './planMemory';

declare global {
  interface Window {
    __LIBRARY__?: LibraryIndex | null;
    __LIBRARY_GENERATED_AT__?: string;
  }
}

export interface LogLine {
  id: number;
  time: string;
  msg: string;
  kind: '' | 'ok' | 'warn' | 'err';
}

export type ArchiveFilter = 'all' | 'ready' | 'review' | 'conflict' | 'unrecognized';

let logSeq = 0;
let toastTimer: number | undefined;
let targetCheckTimer: number | undefined;

export interface AppState {
  /* ---------------- 全局 ---------------- */
  view: 'archive' | 'library';
  themeIdx: number;
  serviceOnline: boolean;
  servicePort: number;
  serviceVersion: string;
  config: AppConfig | null;
  booted: boolean;

  toast: { msg: string; color: string } | null;
  logs: LogLine[];
  logOpen: boolean;

  /* ---------------- 视图① ---------------- */
  sourceRoot: string;
  targetRoot: string;
  busy: null | {
    title: string;
    current: string;
    percent: number;
    /** 显示「停止归档」按钮（仅执行归档时） */
    stoppable?: boolean;
    /** 自定义底部提示行（不给则用归档那套文案） */
    hint?: string;
  };
  /** 服务端返回的原始扫描分组（未经记忆修饰）—— 所有用户决策都由记忆叠加在其上 */
  rawGroups: AnimeGroup[];
  groups: AnimeGroup[];
  plan: ArchivePlan | null;
  query: string;
  filter: ArchiveFilter;
  treeView: 'tree' | 'diff';
  collapsed: Record<string, boolean>;
  expanded: Record<string, boolean>;
  doneSet: string[];
  decisions: Record<string, EntryDecision>;
  linkedGroupId: string | null;
  lastBatchId: string | null;
  scanInfo: { files: number; dirs: number; skippedNonVideo: number; excluded: number } | null;
  /** 归档根目录状态（用于提示「目录不存在，是否创建」） */
  targetStatus: { checked: boolean; exists: boolean; writable: boolean; checking: boolean } | null;
  /** 本次扫描从「方案记忆」恢复的规模（用于提示） */
  restoredInfo: { groups: number; items: number } | null;
  /** 被单独调整过（拆出原组）的源路径集合 */
  overriddenPaths: string[];
  /** 已从「上次扫描快照」载入（而非本次扫描）时的时间与规模，用于提示 */
  snapshot: { savedAt: string; groups: number; files: number; stale?: boolean; from?: 'server' | 'cache' } | null;

  /* ---------------- 视图② ---------------- */
  library: LibraryIndex | null;
  libraryLoading: boolean;
  /** 上次刷新媒体库失败的原因（非 null 时列表顶部会显示红色提示条 + 重试） */
  libraryError: string | null;
  libQuery: string;
  chartMode: 'count' | 'size';

  /* ---------------- actions ---------------- */
  boot: () => Promise<void>;
  setView: (v: 'archive' | 'library') => void;
  cycleTheme: () => void;
  showToast: (msg: string, color?: string) => void;
  pushLog: (msg: string, kind?: LogLine['kind']) => void;
  toggleLog: (open?: boolean) => void;

  setPaths: (src: string, dst: string) => void;
  checkTargetRoot: (silent?: boolean) => Promise<void>;
  createTargetRoot: () => Promise<void>;
  setQuery: (q: string) => void;
  setFilter: (f: ArchiveFilter) => void;
  setTreeView: (v: 'tree' | 'diff') => void;
  toggleCollapsed: (key: string) => void;
  /** 显式设置折叠状态（月份有「默认折叠」策略，切换时必须用这个而不是 toggle） */
  setCollapsed: (key: string, collapsed: boolean) => void;
  toggleExpanded: (groupId: string) => void;
  setLinked: (groupId: string | null) => void;

  decisionOf: (groupId: string, status: GroupStatus) => EntryDecision;
  setDecision: (groupId: string, patch: Partial<EntryDecision>) => void;
  bulkDecision: (status: GroupStatus, execute: boolean, strategy?: 'rename' | 'skip') => void;

  scan: () => Promise<void>;
  execute: () => Promise<void>;
  /** 停止正在执行的归档：不再开始新文件，已在搬的几个会先完成 */
  stopExecute: () => Promise<void>;
  /** 整批撤销（默认撤销最近一次批次；也可显式指定 batchId） */
  undoBatch: (batchId?: string) => Promise<void>;
  resolveGroup: (
    groupId: string,
    payload: { zhName: string; year: number; month: number; saveAlias: boolean; deferred?: boolean; applySameKey?: boolean }
  ) => Promise<void>;
  /** 批量确认：把同一个名称一次应用到多个分组（多选 / 同名组） */
  resolveGroups: (
    groupIds: string[],
    payload: { zhName: string; year: number; month: number; saveAlias: boolean; deferred?: boolean }
  ) => Promise<void>;
  /** 已归档文件夹列表（供弹窗选择） */
  animeDirs: () => Promise<Array<{ name: string; year: number | null; month: number | null; relPath: string }>>;
  /** 把单个文件/文件夹拆出原组，单独改归到另一部番剧 */
  moveItemToAnime: (
    fromPath: string,
    payload: { zhName: string; year: number; month: number; subDir?: 'SP' | 'OP&ED' | null }
  ) => Promise<void>;
  /** 批量：把多个文件/文件夹一起拆出原组，改归到同一部番剧（同一目标的条目会自动合并成一个分组） */
  moveItemsToAnime: (
    fromPaths: string[],
    payload: { zhName: string; year: number; month: number; subDir?: 'SP' | 'OP&ED' | null }
  ) => Promise<void>;
  /** 取消某个条目的单独调整 */
  removeItemOverride: (fromPath: string) => Promise<void>;
  /** 批量取消多个条目的单独调整（批量调整拆出的分组可整组撤销） */
  removeItemsOverride: (fromPaths: string[]) => Promise<void>;
  /** 清空方案记忆 */
  clearPlanMemory: () => void;
  /** 保存设置（数据源 / 阈值），下次扫描生效 */
  saveSettings: (patch: Partial<AppConfig>) => Promise<void>;
  /** 载入服务端保存的「上次扫描结果」（启动时调用；无快照 / 目录不匹配则不载入） */
  loadSnapshot: () => Promise<boolean>;

  /* 归档执行进度（断点续传） */
  execProgress: ExecuteState | null;
  /** 拉取当前执行进度；running 时会自动轮询直到结束 */
  loadExecProgress: () => Promise<void>;
  /** 清掉「上次未完成」提示 */
  dismissExecProgress: () => Promise<void>;

  /* 多选批量 */
  selected: string[];
  toggleSelect: (groupId: string) => void;
  setSelected: (ids: string[]) => void;
  clearSelected: () => void;
  selectAllVisible: (ids: string[]) => void;
  applyConflict: (groupId: string, strategy: 'rename' | 'skip') => Promise<void>;
  renameGroupFolder: (groupId: string, newName: string) => Promise<void>;
  rebuildPlan: () => Promise<void>;
  /** 依据「原始扫描结果 + 方案记忆」重新生成界面分组与归档方案 */
  refreshPlan: () => Promise<void>;

  loadLibrary: () => Promise<void>;
  rebuildIndex: () => Promise<void>;  setLibQuery: (q: string) => void;
  setChartMode: (m: 'count' | 'size') => void;
  play: (fullPath: string, name: string) => Promise<void>;
  revertFile: (fullPath: string, name: string) => Promise<void>;
  renameLibraryAnime: (relPath: string, newName: string) => Promise<void>;
  shutdownService: () => Promise<void>;
  reconnect: () => Promise<void>;
}

const THEME_ORDER: Array<'system' | 'dark' | 'light'> = ['system', 'dark', 'light'];

function applyTheme(t: 'system' | 'dark' | 'light'): void {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

/* =========================================================
   方案记忆：让「人工确认」在重新扫描后自动恢复
   ========================================================= */

/** 记忆作用域：同一组「源/目标目录」共享一份记忆 */
function memoryScope(sourceRoot: string, targetRoot: string): string {
  const norm = (s: string): string => (s || '').trim().replace(/[\\/]+$/, '').toLowerCase();
  return `${norm(sourceRoot)}>>${norm(targetRoot)}`;
}

/** 读取当前作用域的记忆 → 修改 → 写回 */
function mutateMemory(fn: (m: PlanMemory) => void): PlanMemory {
  const { sourceRoot, targetRoot } = useApp.getState();
  const scope = memoryScope(sourceRoot, targetRoot);
  const m = loadMemory(scope);
  fn(m);
  saveMemory(scope, m);
  return m;
}

/**
 * 把记忆套用到分组上（组级确认 + 条目级拆组），并同步 decisions。
 */
function decorateGroups(groups: AnimeGroup[]): {
  groups: AnimeGroup[];
  decisions: Record<string, EntryDecision>;
  restoredInfo: { groups: number; items: number } | null;
  overriddenPaths: string[];
} {
  const state = useApp.getState();
  const memory = loadMemory(memoryScope(state.sourceRoot, state.targetRoot));
  const applied = applyMemory(groups, memory);

  const decisions = { ...state.decisions };
  Object.entries(applied.include).forEach(([gid, inc]) => {
    decisions[gid] = { ...(decisions[gid] ?? { execute: true }), execute: inc };
  });

  const hasMemory = applied.restoredGroups > 0 || applied.restoredItems > 0;
  return {
    groups: applied.groups,
    decisions,
    restoredInfo: hasMemory ? { groups: applied.restoredGroups, items: applied.restoredItems } : null,
    overriddenPaths: Array.from(applied.overriddenPaths)
  };
}

export const useApp = create<AppState>((set, get) => ({
  view: 'archive',
  themeIdx: 0,
  serviceOnline: false,
  servicePort: 9999,
  serviceVersion: '',
  config: null,
  booted: false,

  toast: null,
  logs: [],
  logOpen: false,

  sourceRoot: '',
  targetRoot: '',
  busy: null,
  rawGroups: [],
  groups: [],
  plan: null,
  query: '',
  filter: 'all',
  treeView: 'tree',
  collapsed: {},
  expanded: {},
  doneSet: [],
  decisions: {},
  linkedGroupId: null,
  lastBatchId: null,
  scanInfo: null,
  targetStatus: null,
  restoredInfo: null,
  overriddenPaths: [],
  snapshot: null,
  execProgress: null,

  library: null,
  libraryLoading: false,
  libraryError: null,
  libQuery: '',
  chartMode: 'count',
  selected: [],

  /* ================= 启动 ================= */

  boot: async () => {
    applyTheme(THEME_ORDER[get().themeIdx]);
    const probe = await probeService(get().servicePort);
    set({ serviceOnline: probe.online, servicePort: probe.port, serviceVersion: probe.version ?? '' });
    if (probe.online) setApiPort(probe.port);

    // 离线兜底：indexer 会同时产出 library.js，双击打开（file://）时浏览器禁止 fetch，
    // 但允许动态加载 <script>，因此这里显式注入并读取 window.__LIBRARY__。
    const injected = await loadInjectedLibrary();
    if (injected) set({ library: injected });

    if (probe.online) {
      try {
        const cfg = await api.getConfig();
        set({
          config: cfg,
          sourceRoot: cfg.sourceRoot || get().sourceRoot,
          targetRoot: cfg.targetRoot || get().targetRoot,
          servicePort: cfg.port || probe.port
        });
        setApiPort(cfg.port || probe.port);
        get().pushLog(`⏻ 本地服务已连接 · 127.0.0.1:${cfg.port || probe.port}`, 'ok');
        await get().checkTargetRoot();
        // 直接载入「上次扫描结果」，避免每次打开都重新扫描
        await get().loadSnapshot();
        // 上次的归档可能还在服务端后台继续跑（页面被关掉并不等于任务停了）
        void get().loadExecProgress();
        await get().loadLibrary();
      } catch (err) {
        get().pushLog(`⚠ 读取配置失败：${(err as Error).message}`, 'warn');
      }
    } else {
      get().pushLog('⏻ 本地服务未启动 → 仅可只读浏览媒体库；播放 / 撤回 / 重命名不可用', 'warn');
      if (!injected) {
        try {
          const idx = await api.index();
          if (idx) set({ library: idx });
        } catch { /* file:// 下 fetch 同源不可用，忽略 */ }
      }
    }
    set({ booted: true });
  },

  setView: v => set({ view: v }),
  cycleTheme: () => {
    const idx = (get().themeIdx + 1) % THEME_ORDER.length;
    set({ themeIdx: idx });
    applyTheme(THEME_ORDER[idx]);
    const label = { system: '跟随系统', dark: '深色', light: '浅色' }[THEME_ORDER[idx]];
    get().showToast(`主题：${label}`);
  },

  showToast: (msg, color) => {
    set({ toast: { msg, color: color ?? '#323c4f' } });
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => set({ toast: null }), 2800);
  },

  pushLog: (msg, kind = '') => {
    set({ logs: [...get().logs, { id: ++logSeq, time: nowTime(), msg, kind }].slice(-500) });
  },

  toggleLog: open => set({ logOpen: open ?? !get().logOpen }),

  /* ================= 视图① ================= */

  setPaths: (src, dst) => {
    set({ sourceRoot: src, targetRoot: dst });
    scheduleTargetCheck();
  },

  /** 检测归档根目录是否存在 / 可写 */
  checkTargetRoot: async (silent = true) => {
    const { targetRoot, serviceOnline } = get();
    if (!targetRoot) { set({ targetStatus: null }); return; }
    if (!serviceOnline) {
      set({ targetStatus: { checked: true, exists: false, writable: false, checking: false } });
      return;
    }
    set({
      targetStatus: {
        checked: get().targetStatus?.checked ?? false,
        exists: get().targetStatus?.exists ?? false,
        writable: get().targetStatus?.writable ?? false,
        checking: true
      }
    });
    try {
      const r = await api.checkPath(targetRoot);
      set({ targetStatus: { checked: true, exists: r.exists, writable: r.writable, checking: false } });
    } catch (err) {
      set({ targetStatus: { checked: true, exists: false, writable: false, checking: false } });
      if (!silent) get().showToast(`❌ 目录检测失败：${(err as Error).message}`, '#ef5566');
    }
  },

  /** 创建归档根目录（需用户显式点击） */
  createTargetRoot: async () => {
    const { targetRoot, serviceOnline } = get();
    if (!serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    if (!targetRoot) { get().showToast('⚠️ 请先填写归档根目录', '#f2b632'); return; }
    try {
      const r = await api.ensureDir(targetRoot);
      set({ targetStatus: { checked: true, exists: true, writable: true, checking: false } });
      get().pushLog(`📁 ${r.created ? '已创建' : '已确认'}归档根目录：${r.path}`, 'ok');
      get().showToast(r.created ? '✅ 归档根目录已创建' : '✅ 归档根目录已存在', '#27c08a');
    } catch (err) {
      get().pushLog(`❌ 创建归档根目录失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
    }
  },
  setQuery: q => set({ query: q }),
  setFilter: f => set({ filter: f }),
  setTreeView: v => set({ treeView: v }),
  toggleCollapsed: key => set({ collapsed: { ...get().collapsed, [key]: !get().collapsed[key] } }),
  setCollapsed: (key, value) => set({ collapsed: { ...get().collapsed, [key]: value } }),
  toggleExpanded: id => set({ expanded: { ...get().expanded, [id]: get().expanded[id] === false } }),
  setLinked: id => set({ linkedGroupId: id }),

  decisionOf: (groupId, status) => {
    const d = get().decisions[groupId];
    if (d) return d;
    if (status === 'ready') return { execute: true };
    if (status === 'conflict') return { execute: true, strategy: 'rename' };
    return { execute: false };
  },

  setDecision: (groupId, patch) => {
    set({ decisions: { ...get().decisions, [groupId]: { ...get().decisionOf(groupId, 'ready'), ...patch } } });
    if (patch.execute !== undefined) {
      const g = get().groups.find(x => x.groupId === groupId);
      if (g && !g.rawKey.startsWith('__manual_item__')) {
        mutateMemory(m => {
          m.groups[g.rawKey] = { ...(m.groups[g.rawKey] ?? { updatedAt: '' }), include: patch.execute, updatedAt: new Date().toISOString() };
        });
      }
    }
  },

  bulkDecision: (status, execute, strategy) => {
    const next = { ...get().decisions };
    get().groups.forEach(g => {
      if (g.status !== status) return;
      next[g.groupId] = { execute, ...(strategy ? { strategy } : {}) };
    });
    set({ decisions: next });
  },

  scan: async () => {
    const { sourceRoot, targetRoot, serviceOnline } = get();
    if (!serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    if (!sourceRoot || !targetRoot) { get().showToast('⚠️ 请填写源目录与归档根目录', '#f2b632'); return; }

    set({
      busy: { title: '正在扫描源目录…', current: '', percent: 0 },
      snapshot: null,
      rawGroups: [],
      groups: [],
      plan: null,
      decisions: {},
      doneSet: [],
      scanInfo: null,
      restoredInfo: null,
      overriddenPaths: [],
      lastBatchId: null
    });
    get().pushLog(`↻ 开始扫描：${sourceRoot}（排除 ${targetRoot}）`);

    let step = 0;
    try {
      await scanStream({ sourceRoot, targetRoot, online: true }, async (ev: StreamEvent) => {
        switch (ev.type) {
          case 'phase':
            set({ busy: { title: ev.message, current: '', percent: 0 } });
            break;
          case 'target':
            set({ targetStatus: { checked: true, exists: ev.exists, writable: ev.writable, checking: false } });
            if (!ev.exists) {
              get().pushLog(`⚠ 归档根目录尚不存在：${ev.targetRoot}（可在界面上一键创建）`, 'warn');
            }
            break;
          case 'progress': {
            step = ev.scanned ?? ev.total ?? step;
            const percent = ev.total ? Math.round(((ev.scanned ?? 0) / ev.total) * 100) : Math.min(96, step % 100);
            set({
              busy: {
                title: ev.phase === 'normalize' ? '正在归一化名称…' : '正在扫描源目录…',
                current: ev.current ?? '',
                percent
              }
            });
            break;
          }
          case 'scanDone':
            set({
              scanInfo: {
                files: ev.files, dirs: ev.dirs,
                skippedNonVideo: ev.skippedNonVideo, excluded: ev.excluded
              }
            });
            get().pushLog(
              `✅ 扫描完成：视频 ${ev.files} 个 / 文件夹 ${ev.dirs} 个 / 忽略非视频 ${ev.skippedNonVideo} 个 / 排除归档目录内 ${ev.excluded} 项`,
              'ok'
            );
            break;
          case 'log':
            get().pushLog(ev.message);
            break;
          case 'plan': {
            // 服务端结果作为「原始分组」，随后叠加方案记忆
            set({ rawGroups: ev.plan.groups, plan: ev.plan });
            // 同时把结果备份到浏览器本地：万一服务端副本丢失，下次打开也能立刻看到
            saveLocalSnapshot(memoryScope(sourceRoot, targetRoot), {
              savedAt: new Date().toISOString(),
              sourceRoot,
              targetRoot,
              scanInfo: get().scanInfo ?? { files: 0, dirs: 0, skippedNonVideo: 0, excluded: 0 },
              groups: ev.plan.groups
            });
            const d = decorateGroups(ev.plan.groups);
            const noMemory = d.restoredInfo === null;
            if (noMemory) {
              set({ groups: ev.plan.groups, decisions: d.decisions, restoredInfo: null, overriddenPaths: [] });
            } else {
              // 记忆改变了分组结构 / 目标路径 → 需要让服务端重新计算方案
              set({
                groups: d.groups, decisions: d.decisions,
                restoredInfo: d.restoredInfo, overriddenPaths: d.overriddenPaths
              });
              await get().refreshPlan();
            }
            get().pushLog(
              `📋 方案已生成：${ev.plan.stats.total} 项（可归档 ${ev.plan.stats.ready} / 待确认 ${ev.plan.stats.review} / 冲突 ${ev.plan.stats.conflict} / 未识别 ${ev.plan.stats.unrecognized}）`,
              'ok'
            );
            const restored = get().restoredInfo;
            if (restored) {
              const parts: string[] = [];
              if (restored.groups) parts.push(`${restored.groups} 个分组的确认结果`);
              if (restored.items) parts.push(`${restored.items} 个单独调整`);
              get().pushLog(`♻ 已从方案记忆恢复：${parts.join('、')}（无需重新确认）`, 'ok');
              get().showToast(`♻ 已自动恢复 ${parts.join('、')}`, '#27c08a');
            }
            break;
          }
          case 'error':
            get().pushLog(`❌ ${ev.message}`, 'err');
            get().showToast(`❌ ${ev.message}`, '#ef5566');
            break;
          default:
            break;
        }
      });
    } catch (err) {
      get().pushLog(`❌ 扫描失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
    } finally {
      set({ busy: null });
    }
  },

  execute: async () => {
    const { plan, serviceOnline, decisions } = get();
    if (!serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    if (!plan) { get().showToast('⚠️ 请先扫描并生成归档方案', '#f2b632'); return; }

    const full: Record<string, EntryDecision> = {};
    plan.entries.forEach(e => {
      full[e.entryId] = decisions[e.groupId] ?? get().decisionOf(e.groupId, e.status);
    });

    const runnable = plan.entries.filter(e => full[e.entryId]?.execute);
    if (!runnable.length) { get().showToast('⚠️ 没有可归档的项目', '#f2b632'); return; }

    set({ busy: { title: '正在执行归档…', current: '', percent: 0, stoppable: true } });
    get().pushLog(`▶ 开始执行归档（共 ${runnable.length} 项）`);
    let batchId = '';
    let ok = 0;
    let fail = 0;
    let skip = 0;
    let stopped = false;

    try {
      await executeStream(plan, full, (ev: StreamEvent) => {
        switch (ev.type) {
          case 'start':
            batchId = ev.batchId;
            set({ lastBatchId: batchId });
            break;
          case 'entry': {
            if (ev.status === 'done') ok++;
            else if (ev.status === 'failed') fail++;
            else skip++;
            const percent = Math.round((ev.index / Math.max(1, ev.total)) * 100);
            set({ busy: { title: '正在执行归档…', current: ev.fromPath.split('\\').pop() ?? '', percent } });
            if (ev.status === 'done') {
              get().pushLog(`✔ 移动成功 → ${ev.toPath}`, 'ok');
              const gid = plan.entries.find(e => e.entryId === ev.entryId)?.groupId;
              if (gid && !get().doneSet.includes(gid)) set({ doneSet: [...get().doneSet, gid] });
            } else if (ev.status === 'failed') {
              const retried = ev.attempts && ev.attempts > 1 ? `（已自动重试 ${ev.attempts - 1} 次）` : '';
              get().pushLog(`✘ 失败${retried}：${ev.fromPath} —— ${ev.error}`, 'err');
            } else {
              get().pushLog(`⏭ 跳过：${ev.fromPath}`, 'warn');
            }
            break;
          }
          case 'phase':
            set({ busy: { title: ev.message, current: '', percent: 100 } });
            break;
          case 'log':
            get().pushLog(ev.message, 'ok');
            break;
          case 'indexDone':
            get().pushLog(`✅ 媒体库索引已重建（${ev.stats.animeCount} 部 / ${ev.stats.fileCount} 个文件）`, 'ok');
            break;
          case 'done':
            stopped = ev.stopped === true;
            if (stopped) {
              get().pushLog(`⏹ 已停止归档：成功 ${ok} / 失败 ${fail} / 跳过 ${skip}（未处理的可点「继续归档」接着跑）`, 'warn');
            } else {
              get().pushLog(`✅ 批次完成：成功 ${ok} / 失败 ${fail} / 跳过 ${skip}`, 'ok');
            }
            break;
          case 'error':
            get().pushLog(`❌ ${ev.message}`, 'err');
            get().showToast(`❌ ${ev.message}`, '#ef5566');
            break;
          default:
            break;
        }
      });
      if (stopped) {
        get().showToast(`⏹ 已停止归档：成功 ${ok} 项，可点「继续归档」接着跑`, '#f2b632');
      } else if (fail) {
        get().showToast(`✅ 归档完成：成功 ${ok} 项，${fail} 项失败（已记入日志，需人工处理）`, '#f2b632');
      } else {
        get().showToast(`✅ 归档完成：成功 ${ok} 项`, '#27c08a');
      }
      set({ logOpen: true });
      await get().loadLibrary();
    } catch (err) {
      get().pushLog(`❌ 执行失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
    } finally {
      set({ busy: null });
      // 同步服务端的执行进度（跑完了就消掉提示；断在中间则留着「可继续」提示）
      void get().loadExecProgress();
    }
  },

  /** 停止执行归档：不再开始新文件；已在搬的几个会先完成（避免 NAS 上留半个文件） */
  stopExecute: async () => {
    if (!get().serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    try {
      const r = await api.executeStop();
      if (!r.stopped) {
        get().pushLog('ℹ 当前没有正在执行的归档批次', 'warn');
        get().showToast('ℹ 没有正在执行的批次', '#f2b632');
        return;
      }
      get().pushLog('⏹ 已请求停止：不再开始新文件，正在处理的那几个会先完成…', 'warn');
      const busy = get().busy;
      if (busy) set({ busy: { ...busy, title: '正在停止归档…', current: '', stoppable: false } });
    } catch (err) {
      get().pushLog(`❌ 停止失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ 停止失败：${(err as Error).message}`, '#ef5566');
    }
  },

  undoBatch: async (batchId) => {
    const { serviceOnline, lastBatchId } = get();
    // 停止归档后页面可能是刷新回来的（lastBatchId 丢了），所以再退一步用执行状态里的批次号
    const target = batchId ?? lastBatchId ?? get().execProgress?.batchId ?? null;
    if (!serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    if (!target) { get().showToast('⚠️ 没有可撤销的批次', '#f2b632'); return; }
    try {
      set({ busy: { title: '正在撤销上一批次…', current: '', percent: 40 } });
      const r = await api.revert({ batchId: target });
      get().pushLog(`↩ 整批撤销完成：成功 ${r.success} / 失败 ${r.failed} / 跳过 ${r.skipped}`, 'warn');
      get().showToast(`↩ 已撤销：成功 ${r.success} 项`, '#f2b632');
      set({ doneSet: [], lastBatchId: null });
      await get().scan();
    } catch (err) {
      get().pushLog(`❌ 撤销失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
    } finally {
      set({ busy: null });
    }
  },

  resolveGroup: async (groupId, payload) => {
    const g = get().groups.find(x => x.groupId === groupId);
    // 默认同时应用到「同一部作品」的其它分组（同名 + 同季数），避免逐个手填
    const same = payload.applySameKey !== false && g
      ? get().groups.filter(x => x.rawKey === g.rawKey).map(x => x.groupId)
      : [groupId];
    await get().resolveGroups(Array.from(new Set([groupId, ...same])), payload);
  },

  resolveGroups: async (groupIds, payload) => {
    const idSet = new Set(groupIds);
    const deferred = payload.deferred === true;
    const targets = get().rawGroups.filter(g => idSet.has(g.groupId));

    // ① 写入方案记忆：重新扫描时自动恢复，不必重新确认
    mutateMemory(m => {
      const at = new Date().toISOString();
      targets.forEach(g => {
        m.groups[g.rawKey] = {
          ...(m.groups[g.rawKey] ?? { updatedAt: at }),
          zhName: payload.zhName,
          year: payload.year || null,
          month: payload.month || null,
          deferred,
          updatedAt: at
        };
      });
    });

    // ② 写回本地别名表
    if (payload.saveAlias && payload.zhName && !deferred) {
      const aliases = new Set<string>();
      // 只使用服务端给出的 aliasQuery（续作仅含带季数的键），
      // 避免把裸标题绑定到错误季数
      targets.forEach(g => {
        (g.aliasQuery ?? []).forEach(a => { if (a) aliases.add(a); });
      });
      if (!aliases.size) targets.forEach(g => g.rawNames.forEach(a => { if (a) aliases.add(a); }));
      try {
        await api.saveAlias({
          aliases: Array.from(aliases),
          zh: payload.zhName,
          year: payload.year || null,
          month: payload.month || null,
          save: true
        });
      } catch (err) {
        get().pushLog(`⚠ 写回别名表失败：${(err as Error).message}`, 'warn');
      }
    }

    // ③ 依据「原始扫描结果 + 方案记忆」重算界面分组与归档方案
    await get().refreshPlan();

    const decisions = { ...get().decisions };
    idSet.forEach(id => { decisions[id] = { execute: !deferred }; });
    set({ decisions, selected: get().selected.filter(id => !idSet.has(id)) });

    const n = targets.length;
    get().pushLog(
      deferred
        ? `⏸ 暂不处理：${n} 组 → _待确认/${payload.zhName || '未确认'}/`
        : `🔎 人工确认：${payload.zhName} → ${payload.year}\\${String(payload.month).padStart(2, '0')}\\${payload.zhName}` +
          `（${n} 组${payload.saveAlias ? '，已写回别名表' : ''}）`,
      'ok'
    );
    get().showToast(
      deferred
        ? `⏸ 已将 ${n} 组移入 _待确认/`
        : `✅ 已确认「${payload.zhName}」并应用到 ${n} 组`,
      deferred ? '#f2b632' : '#27c08a'
    );
  },

  animeDirs: async () => {
    if (!get().serviceOnline) return [];
    try {
      return await api.animeDirs(get().targetRoot || undefined);
    } catch {
      return [];
    }
  },

  toggleSelect: groupId => {
    const cur = get().selected;
    set({ selected: cur.includes(groupId) ? cur.filter(x => x !== groupId) : [...cur, groupId] });
  },

  setSelected: ids => set({ selected: ids }),

  clearSelected: () => set({ selected: [] }),

  selectAllVisible: ids => {
    const cur = new Set(get().selected);
    ids.forEach(id => cur.add(id));
    set({ selected: Array.from(cur) });
  },

  applyConflict: async (groupId, strategy) => {
    const raw = get().rawGroups.find(x => x.groupId === groupId);
    if (raw) {
      mutateMemory(m => {
        m.groups[raw.rawKey] = {
          ...(m.groups[raw.rawKey] ?? { updatedAt: '' }),
          conflictStrategy: strategy,
          updatedAt: new Date().toISOString()
        };
      });
    }
    await get().refreshPlan();
    set({ decisions: { ...get().decisions, [groupId]: { execute: strategy === 'rename', strategy } } });
    get().pushLog(
      strategy === 'skip'
        ? `⏭ 冲突处理（跳过）：该组文件保留在源目录`
        : `✅ 冲突处理（重命名）：将重命名为 xxx (1)`,
      strategy === 'skip' ? 'warn' : 'ok'
    );
    get().showToast(strategy === 'skip' ? '⏭ 已跳过' : '✅ 冲突已解决：自动重命名 (1)', strategy === 'skip' ? '#f2b632' : '#27c08a');
  },

  renameGroupFolder: async (groupId, newName) => {
    const shown = get().groups.find(x => x.groupId === groupId);
    const raw = get().rawGroups.find(x => x.groupId === groupId);
    const at = new Date().toISOString();

    if (raw) {
      // 普通分组：按 rawKey 记住新名字；年/月沿用已有记忆或当前显示值
      mutateMemory(m => {
        const prev = m.groups[raw.rawKey] ?? { updatedAt: at };
        m.groups[raw.rawKey] = {
          ...prev,
          zhName: newName,
          year: prev.year ?? shown?.year ?? null,
          month: prev.month ?? shown?.month ?? null,
          updatedAt: at
        };
      });
    } else if (shown && shown.rawKey.startsWith('__manual_item__')) {
      // 「单独调整」拆出来的分组：改名要落到条目覆盖记录上
      mutateMemory(m => {
        shown.items.forEach(it => {
          const ov = m.overrides[it.scanItem.path];
          if (ov) { ov.zhName = newName; ov.updatedAt = at; }
        });
      });
    }

    await get().refreshPlan();
    get().pushLog(`✏️ 重命名归档文件夹 → ${newName}（已记入方案记忆）`, 'ok');
    get().showToast('✏️ 已更新归档方案（重新执行归档后生效）', '#27c08a');
  },

  refreshPlan: async () => {
    const { rawGroups, sourceRoot, targetRoot, serviceOnline } = get();
    if (!rawGroups.length) {
      set({ groups: [], plan: null, restoredInfo: null, overriddenPaths: [] });
      return;
    }
    const d = decorateGroups(rawGroups);
    if (serviceOnline) {
      try {
        const plan = await api.rebuildPlan(d.groups, sourceRoot, targetRoot);
        set({
          plan,
          groups: Array.isArray(plan?.groups) && plan.groups.length ? plan.groups : d.groups,
          decisions: d.decisions,
          restoredInfo: d.restoredInfo,
          overriddenPaths: d.overriddenPaths
        });
        return;
      } catch (err) {
        get().pushLog(`⚠ 方案刷新失败：${(err as Error).message}`, 'warn');
      }
    }
    // 离线兜底：本地重算目标路径（不检测冲突）
    set({
      plan: localPlan(d.groups, sourceRoot, targetRoot),
      groups: d.groups,
      decisions: d.decisions,
      restoredInfo: d.restoredInfo,
      overriddenPaths: d.overriddenPaths
    });
  },

  rebuildPlan: async () => {
    await get().refreshPlan();
  },

  /**
   * 把条目单独归到另一部番剧（支持一次多个）。
   *
   * 统一实现：同一目标的条目用**相同的时间戳与目标**写入方案记忆，
   * `applyMemory()` 会自动把它们汇成**同一个分组**，因此无需在后端加批量接口。
   */
  moveItemsToAnime: async (fromPaths, payload) => {
    const paths = [...new Set(fromPaths.filter(Boolean))];
    if (!paths.length) return;
    const at = new Date().toISOString();
    mutateMemory(m => {
      paths.forEach(fromPath => {
        m.overrides[fromPath] = {
          fromPath,
          zhName: payload.zhName,
          year: payload.year,
          month: payload.month,
          subDir: payload.subDir ?? null,
          updatedAt: at
        };
      });
    });
    await get().refreshPlan();

    const target = `${payload.year}\\${String(payload.month).padStart(2, '0')}\\${payload.zhName}`;
    if (paths.length === 1) {
      get().pushLog(`↗ 单独调整：${paths[0]} → ${target}（已记入方案记忆）`, 'ok');
      get().showToast(`↗ 已单独归入「${payload.zhName}」`, '#27c08a');
    } else {
      get().pushLog(`↗ 批量调整 ${paths.length} 个条目 → ${target}（已记入方案记忆）`, 'ok');
      get().showToast(`↗ 已把 ${paths.length} 个条目一起归入「${payload.zhName}」`, '#27c08a');
    }
  },

  moveItemToAnime: async (fromPath, payload) => {
    await get().moveItemsToAnime([fromPath], payload);
  },

  removeItemsOverride: async (fromPaths) => {
    const paths = [...new Set(fromPaths.filter(Boolean))];
    if (!paths.length) return;
    mutateMemory(m => { paths.forEach(p => { delete m.overrides[p]; }); });
    await get().refreshPlan();
    const what = paths.length === 1 ? paths[0] : `${paths.length} 个条目`;
    get().pushLog(`↩ 已取消单独调整：${what}（回到原分组）`, 'warn');
    get().showToast(
      paths.length === 1 ? '↩ 已取消单独调整，该文件回到原分组' : `↩ 已取消 ${paths.length} 个条目的单独调整`,
      '#f2b632'
    );
  },

  removeItemOverride: async (fromPath) => {
    await get().removeItemsOverride([fromPath]);
  },

  clearPlanMemory: () => {
    const { sourceRoot, targetRoot } = get();
    clearMemory(memoryScope(sourceRoot, targetRoot));
    void get().refreshPlan();
    get().pushLog('🧹 已清除当前「源目录 / 归档根目录」下的全部方案记忆', 'warn');
    get().showToast('🧹 方案记忆已清除，需重新人工确认', '#f2b632');
  },

  saveSettings: async patch => {
    if (!get().serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    try {
      const cfg = await api.saveConfig(patch);
      set({ config: cfg });
      const parts: string[] = [];
      if (patch.useFileTime !== undefined) parts.push(`文件时间校验${patch.useFileTime ? '开' : '关'}`);
      if (patch.webSearchEnabled !== undefined) parts.push(`网页检索${patch.webSearchEnabled ? '开' : '关'}`);
      if (patch.bangumiEnabled !== undefined) parts.push(`Bangumi${patch.bangumiEnabled ? '开' : '关'}`);
      if (patch.googleApiKey !== undefined || patch.googleCx !== undefined) {
        parts.push(cfg.googleApiKey && cfg.googleCx ? 'Google 检索已配置' : 'Google 检索未配置');
      }
      if (patch.reviewThreshold !== undefined) parts.push(`阈值 ${cfg.reviewThreshold}/${cfg.autoThreshold}`);
      if (patch.scanConcurrency !== undefined) parts.push(`扫描并发 ${cfg.scanConcurrency}`);
      get().pushLog(`⚙ 设置已更新：${parts.join('、') || '已保存'}（下次扫描生效）`, 'ok');
      get().showToast('⚙ 设置已保存（下次扫描生效）', '#27c08a');
    } catch (err) {
      get().pushLog(`❌ 保存设置失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
    }
  },

  /* ================= 上次扫描快照 ================= */

  loadSnapshot: async () => {
    const { sourceRoot, targetRoot, serviceOnline } = get();
    const scope = memoryScope(sourceRoot, targetRoot);

    // ① 先用「浏览器本地备份」立刻渲染 —— 保证打开页面马上就有内容
    const local = loadLocalSnapshot(scope);
    const localOk = !!local && Array.isArray(local.groups) && local.groups.length > 0
      && normPath(local.sourceRoot) === normPath(sourceRoot)
      && normPath(local.targetRoot) === normPath(targetRoot);
    if (localOk && local) applySnapshot(local, 'cache');

    // ② 再向服务端要权威副本（服务端版本会在执行归档后被裁剪，更准）
    let snap: ScanSnapshot | null = null;
    if (serviceOnline) {
      try {
        snap = await api.lastScan();
      } catch {
        snap = null;
      }
    }

    const serverOk = !!snap && Array.isArray(snap.groups)
      && normPath(snap.sourceRoot) === normPath(sourceRoot)
      && normPath(snap.targetRoot) === normPath(targetRoot);

    if (serverOk && snap) {
      // 服务端副本已全部归档完成 → 清掉本地备份，避免下次又"载入"过期内容
      if (!snap.groups.length) {
        clearLocalSnapshot(scope);
        set({ snapshot: { savedAt: snap.savedAt, groups: 0, files: 0, stale: snap.stale === true } });
        get().pushLog(
          `📂 上次扫描结果里的文件已全部归档完成（${formatStamp(snap.lastBatchAt ?? snap.savedAt)}）。` +
          `有新文件时点「↻ 扫描并生成方案」`,
          'ok'
        );
        return true;
      }
      applySnapshot(snap, 'server');
      await refreshPlanSafely(get);
      get().pushLog(
        `📂 已载入上次扫描结果（${formatStamp(snap.savedAt)} · ${snap.groups.length} 组 / ` +
        `${snap.groups.reduce((a, g) => a + g.items.length, 0)} 个文件），未重新扫描。` +
        `需要最新文件列表时点「↻ 扫描并生成方案」`,
        'ok'
      );
      get().showToast('📂 已载入上次扫描结果', '#3ba9ff');
      return true;
    }

    if (localOk) {
      // 服务端没有 / 目录对不上 → 用本机备份，仍然免去重新扫描
      await refreshPlanSafely(get);
      get().pushLog(
        `📂 服务端没有可用的上次扫描结果，已改用**本机缓存**（${formatStamp(local!.savedAt)} · ` +
        `${local!.groups.length} 组）。需要最新文件列表时点「↻ 扫描并生成方案」`,
        'ok'
      );
      get().showToast('📂 已从本机缓存载入上次扫描结果', '#3ba9ff');
      return true;
    }

    if (snap && !serverOk) {
      get().pushLog(
        `ℹ 上次扫描结果是「${snap.sourceRoot} → ${snap.targetRoot}」，与当前目录不一致，已忽略（请点击扫描）`,
        'warn'
      );
    } else {
      get().pushLog('ℹ 本机还没有「上次扫描结果」，请点击扫描', 'warn');
    }
    return false;
  },

  /* ================= 归档执行进度（断点续传） ================= */

  loadExecProgress: async () => {
    if (!get().serviceOnline) return;
    let st: ExecuteState | null = null;
    try {
      st = await api.executeProgress();
    } catch {
      return;
    }
    set({ execProgress: st });
    if (!st?.running) return;

    // 服务端还在搬：轮询到结束为止（页面关掉也没关系，重开后会重新接上）
    const batchId = st.batchId;
    const timer = setInterval(async () => {
      try {
        const cur = await api.executeProgress();
        if (!get().execProgress || get().execProgress?.batchId !== batchId) return;
        set({ execProgress: cur });
        if (!cur?.running) {
          clearInterval(timer);
          const now = cur;
          get().pushLog(
            `🏁 后台归档结束：成功 ${now?.done ?? 0} / 失败 ${now?.failed ?? 0} / 跳过 ${now?.skipped ?? 0}`,
            'ok'
          );
          get().showToast('🏁 后台归档已结束', '#27c08a');
          await get().loadLibrary();
        }
      } catch { /* 网络抖动时忽略，下个周期再试 */ }
    }, 1500);
  },

  dismissExecProgress: async () => {
    set({ execProgress: null });
    if (!get().serviceOnline) return;
    try { await api.clearExecuteProgress(); } catch { /* ignore */ }
    await get().refreshPlan();
  },

  /* ================= 视图② ================= */

  loadLibrary: async () => {
    set({ libraryLoading: true });
    try {
      if (get().serviceOnline) {
        /*
         * 刷新失败必须**看得见**：以前失败只写一行日志，列表继续显示旧数据，
         * 用户会以为「刚才的移动没生效」→ 再点一次 → 重复操作。
         * 所以失败时重试一次，仍失败就把错误留到界面上（带「重试」按钮）。
         */
        let idx = await api.index().catch(() => null as LibraryIndex | null);
        if (!idx) {
          await new Promise(res => setTimeout(res, 800));
          idx = await api.index().catch(() => null as LibraryIndex | null);
        }
        if (idx) {
          set({ library: idx, libraryError: null });
        } else {
          const msg = '索引刷新失败（服务可能正忙）';
          set({ libraryError: msg });
          get().pushLog(`⚠ ${msg}：列表可能还是旧数据，请点「↻ 重建索引」或刷新页面`, 'warn');
        }
      } else if (window.__LIBRARY__) {
        set({ library: window.__LIBRARY__ ?? null, libraryError: null });
      }
    } catch (err) {
      set({ libraryError: `索引读取失败：${(err as Error).message}` });
      get().pushLog(`⚠ 索引读取失败：${(err as Error).message}`, 'warn');
    } finally {
      set({ libraryLoading: false });
    }
  },

  rebuildIndex: async () => {
    if (!get().serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    set({ libraryLoading: true });
    try {
      const idx = await api.rebuildIndex();
      set({ library: idx });
      get().pushLog(`✅ 索引已重建：${idx.stats.animeCount} 部 / ${idx.stats.fileCount} 个文件`, 'ok');
      get().showToast('✅ 索引已重建', '#27c08a');
    } catch (err) {
      get().pushLog(`❌ 重建索引失败：${(err as Error).message}`, 'err');
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
    } finally {
      set({ libraryLoading: false });
    }
  },

  setLibQuery: q => set({ libQuery: q }),
  setChartMode: m => set({ chartMode: m }),

  play: async (fullPath, name) => {
    if (!get().serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    try {
      await api.play(fullPath);
      get().pushLog(`▶ 已调用 Windows 默认播放器：${fullPath}`, '');
      get().showToast(`▶ 已调用默认播放器：${name}`, '#3ba9ff');
    } catch (err) {
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
      get().pushLog(`❌ 播放失败：${(err as Error).message}`, 'err');
    }
  },

  revertFile: async (fullPath, name) => {
    if (!get().serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    if (get().busy) return;                                        // 已有操作在跑，忽略重复点击
    /*
     * 用全局忙碌遮罩：撤回一个几百 MB 的文件在 NAS 上要好几秒，
     * 不给任何反馈用户就会反复点 —— 遮罩同时把按钮挡住了，从根上防重复。
     */
    set({ busy: { title: `正在撤回「${name}」…`, current: '', percent: 30, hint: '撤回会把文件搬回归档前的位置，请稍候' } });
    try {
      const r = await api.revert({ filePath: fullPath });
      get().pushLog(`↩ 已撤回 "${name}"（成功 ${r.success} / 失败 ${r.failed}）`, 'warn');
      get().showToast(`↩ 已撤回：${name}`, '#f2b632');
      set({ busy: null });
      await get().loadLibrary();
    } catch (err) {
      set({ busy: null });
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
      get().pushLog(`❌ 撤回失败：${(err as Error).message}`, 'err');
    }
  },

  renameLibraryAnime: async (relPath, newName) => {
    if (!get().serviceOnline) { get().showToast('⚠️ 请先启动本地服务', '#f2b632'); return; }
    if (get().busy) return;
    set({ busy: { title: `正在重命名「${newName}」…`, current: '', percent: 30, hint: '会在 NAS 上真实重命名番剧文件夹' } });
    try {
      const r = await api.rename(relPath, newName);
      get().pushLog(`✏️ 媒体库改名：${r.fromPath} → ${r.toPath}`, 'ok');
      get().showToast('✏️ 文件夹已重命名', '#27c08a');
      set({ busy: null });
      await get().loadLibrary();
    } catch (err) {
      set({ busy: null });
      get().showToast(`❌ ${(err as Error).message}`, '#ef5566');
      get().pushLog(`❌ 重命名失败：${(err as Error).message}`, 'err');
    }
  },

  shutdownService: async () => {
    if (!get().serviceOnline) { get().showToast('⚠️ 服务本就未启动', '#f2b632'); return; }
    try {
      await api.shutdown();
      set({ serviceOnline: false });
      get().pushLog('⏻ 本地服务已停止 → 仍可浏览与检索，写入类操作已置灰', 'warn');
      get().showToast('⏻ 本地服务已关闭', '#f2b632');
    } catch {
      set({ serviceOnline: false });
      get().showToast('⏻ 已发送关闭指令', '#f2b632');
    }
  },

  reconnect: async () => {
    const probe = await probeService(get().servicePort);
    set({ serviceOnline: probe.online, servicePort: probe.port, serviceVersion: probe.version ?? '' });
    if (!probe.online) {
      get().showToast('⚠️ 仍未检测到本地服务', '#f2b632');
      return;
    }
    setApiPort(probe.port);
    get().showToast('✅ 已连接到本地服务', '#27c08a');
    get().pushLog(`⏻ 本地服务已连接 · 127.0.0.1:${probe.port}`, 'ok');
    // ⚠ 必须走完整的「上线后」流程：只 loadLibrary 的话，用户先开了页面、后启动服务时
    // 就永远拿不到「上次扫描结果」，于是每次都得重新扫描一遍
    try {
      const cfg = await api.getConfig();
      set({
        config: cfg,
        sourceRoot: cfg.sourceRoot || get().sourceRoot,
        targetRoot: cfg.targetRoot || get().targetRoot,
        servicePort: cfg.port || probe.port
      });
      setApiPort(cfg.port || probe.port);
      await get().checkTargetRoot();
      await get().loadSnapshot();
      // 后台可能还在搬文件（页面关掉不等于任务停了）
      void get().loadExecProgress();
    } catch (err) {
      get().pushLog(`⚠ 读取配置失败：${(err as Error).message}`, 'warn');
    }
    await get().loadLibrary();
  }
}));

/** 路径比较用的归一化形式 */
function normPath(s: string): string {
  return (s || '').trim().replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase();
}

/** 把一份快照套用到界面（不触发网络） */
function applySnapshot(
  snap: { savedAt: string; scanInfo: ScanSnapshot['scanInfo']; groups: AnimeGroup[]; stale?: boolean },
  from: 'server' | 'cache'
): void {
  const files = snap.groups.reduce((a, g) => a + g.items.length, 0);
  const d = decorateGroups(snap.groups);
  useApp.setState({
    rawGroups: snap.groups,
    groups: d.groups,
    decisions: d.decisions,
    restoredInfo: d.restoredInfo,
    overriddenPaths: d.overriddenPaths,
    scanInfo: snap.scanInfo,
    snapshot: { savedAt: snap.savedAt, groups: snap.groups.length, files, stale: snap.stale === true, from },
    doneSet: []
  });
}

/** 重算归档方案，带超时保护（NAS 掉线时不能让启动无限期卡住） */
async function refreshPlanSafely(get: () => AppState): Promise<void> {
  let settled = false;
  await Promise.race([
    get().refreshPlan().then(() => { settled = true; }),
    new Promise<void>(resolve => {
      window.setTimeout(() => {
        if (!settled) {
          get().pushLog('⚠ 重新计算归档方案超时（NAS 可能未连接），已先显示上次结果；请点击扫描重试', 'warn');
        }
        resolve();
      }, 20000);
    })
  ]);
}

/* ---------------- 离线兜底：本地重算方案 ---------------- */

function localPlan(groups: AnimeGroup[], sourceRoot: string, targetRoot: string): ArchivePlan {
  const root = targetRoot.replace(/[\\/]+$/, '');
  const entries = groups.flatMap(g =>
    g.items.map((gi, idx) => {
      const rel = localRelDir(g);
      const parts = [root, rel, gi.parsed.subDir ?? '', gi.renameTo || gi.scanItem.name].filter(Boolean);
      // ⚠ 与后端 planner 同样的坑：不能把 UNC 开头的 `\\` 压成一个（否则会指向本机盘符）
      const toPath = joinWinPath(parts);
      return {
        entryId: `${g.groupId}-${idx}`,
        groupId: g.groupId,
        fromPath: gi.scanItem.path,
        toPath,
        name: gi.scanItem.name,
        targetName: gi.renameTo || gi.scanItem.name,
        isDir: gi.scanItem.isDir,
        size: gi.scanItem.size,
        action: 'move' as const,
        status: g.status,
        conflictType: 'none' as const,
        note: gi.note ?? null,
        subDir: gi.parsed.subDir,
        episode: gi.parsed.episode,
        mediaType: gi.parsed.mediaType,
        relTargetDir: rel
      };
    })
  );
  const stats = {
    total: entries.length,
    totalSize: entries.reduce((a, e) => a + e.size, 0),
    ready: entries.filter(e => e.status === 'ready').length,
    review: entries.filter(e => e.status === 'review').length,
    conflict: entries.filter(e => e.status === 'conflict').length,
    unrecognized: entries.filter(e => e.status === 'unrecognized').length,
    deferred: entries.filter(e => e.status === 'deferred').length,
    skipped: entries.filter(e => e.status === 'skipped').length
  };
  return {
    planId: `local-${Date.now()}`,
    createdAt: new Date().toISOString(),
    sourceRoot,
    targetRoot: root,
    groups,
    entries,
    stats
  };
}

function localRelDir(g: AnimeGroup): string {
  if (g.status === 'unrecognized') {
    const base = g.items[0]?.scanItem.name ?? 'unknown';
    return `_未识别\\${safeSeg(base.replace(/\.[^.]+$/, ''))}`;
  }
  if (g.status === 'deferred' || g.year === null || g.month === null) {
    return `_待确认\\${safeSeg(g.zhName || g.rawNames[0] || '未确认')}`;
  }
  return `${g.year}\\${String(g.month).padStart(2, '0')}\\${safeSeg(g.zhName)}`;
}

function safeSeg(name: string): string {
  const v = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/[. ]+$/, '');
  return v || '未命名';
}

/** 路径变更后防抖检测归档根目录 */
function scheduleTargetCheck(): void {
  if (targetCheckTimer) window.clearTimeout(targetCheckTimer);
  targetCheckTimer = window.setTimeout(() => {
    const { checkTargetRoot, sourceRoot, targetRoot, serviceOnline, config } = useApp.getState();
    void checkTargetRoot();
    // 顺手把路径写回服务端 config（下次打开 / start.vbs 都能记住上次输入的路径）
    if (
      serviceOnline &&
      (sourceRoot !== (config?.sourceRoot ?? '') || targetRoot !== (config?.targetRoot ?? ''))
    ) {
      void api.saveConfig({ sourceRoot, targetRoot })
        .then(cfg => useApp.setState({ config: cfg }))
        .catch(() => { /* 忽略：路径可以先只在本次会话内生效 */ });
    }
  }, 700);
}

/**
 * 动态加载站点目录下的 data/library.js（由服务端 indexer 产出）。
 * file:// 下 fetch 会被浏览器拦截，但 <script> 可以加载，因此用它做「未启动服务时的只读浏览」。
 */
async function loadInjectedLibrary(): Promise<LibraryIndex | null> {
  if (typeof window === 'undefined') return null;
  if (window.__LIBRARY__) return window.__LIBRARY__;
  try {
    await new Promise<void>((resolve, reject) => {
      const el = document.createElement('script');
      el.src = './data/library.js';
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('library.js 不存在'));
      document.head.appendChild(el);
    });
  } catch {
    return null;
  }
  return window.__LIBRARY__ ?? null;
}
