/**
 * 本地服务 API 客户端
 *
 * 说明：
 *  - 页面由本地服务托管时（http://127.0.0.1:9999）使用同源相对路径；
 *  - 由 Vite dev server 托管时（:5173）通过代理访问；
 *  - 由 file:// 双击打开时使用绝对地址 http://127.0.0.1:9999（服务端已开 CORS）。
 */
import type {
  AppConfig, ArchivePlan, ApiResult, EntryDecision, ExecuteState, LibraryIndex,
  LibraryStats, ScanSnapshot, StreamEvent
} from '../types';

/** Bangumi 手动检索结果项 */
export interface BangumiHit {
  id: number;
  name: string;
  nameCn: string;
  date: string | null;
  year: number | null;
  month: number | null;
  /** bgm.tv 条目链接，便于想进一步核对时点开 */
  url: string;
}

export interface BangumiSearchResult {
  query: string;
  /** 实际检索过的关键词（含繁→简转换后的形式） */
  tried: string[];
  /** 是否联网成功（false = 访问不了 Bangumi，只可能返回缓存结果） */
  online: boolean;
  /** 结果是否来自本地缓存 */
  fromCache: boolean;
  results: BangumiHit[];
}

const IS_FILE = typeof location !== 'undefined' && location.protocol === 'file:';
const DEFAULT_PORT = 9999;

let apiBase = IS_FILE ? `http://127.0.0.1:${DEFAULT_PORT}` : '';

export function setApiPort(port: number): void {
  if (IS_FILE) apiBase = `http://127.0.0.1:${port}`;
}

export function getApiBase(): string {
  return apiBase || '(同源)';
}

export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

/**
 * 服务可用性探测。
 *
 * 会**多次重试**：`start.vbs` 启动 Node 后只等 1.5 秒就打开浏览器，
 * 而冷启动（Node 起来 + 读取 data 目录 + 加载 Bangumi 缓存）可能更久，
 * 若一次探测失败就进入「离线只读」模式，用户会以为「没有服务」而手动去点启动，
 * 顺带也就丢掉了「自动载入上次扫描结果」这条路径。
 */
export async function probeService(
  port = DEFAULT_PORT,
  opts: { attempts?: number; intervalMs?: number } = {}
): Promise<{ online: boolean; port: number; version?: string }> {
  const attempts = opts.attempts ?? 6;
  const intervalMs = opts.intervalMs ?? 700;
  for (let i = 0; i < attempts; i++) {
    const r = await probeOnce(port);
    if (r.online) return r;
    if (i < attempts - 1) await new Promise(res => setTimeout(res, intervalMs));
  }
  return { online: false, port };
}

async function probeOnce(port: number): Promise<{ online: boolean; port: number; version?: string }> {
  const bases = IS_FILE
    ? [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port + 1}`, `http://127.0.0.1:${port + 2}`]
    : [''];

  for (const base of bases) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${base}/api/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) continue;
      const json = (await res.json()) as ApiResult<{ version: string; port: number }>;
      if (json.ok) {
        if (IS_FILE) apiBase = base;
        return { online: true, port: json.data.port, version: json.data.version };
      }
    } catch {
      /* 继续尝试下一个端口 */
    }
  }
  return { online: false, port };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
  });
  const json = (await res.json()) as ApiResult<T>;
  if (!json.ok) throw new Error(json.error || `请求失败：${res.status}`);
  return json.data;
}

export const api = {
  health: () => request<{ version: string; port: number; pid: number; uptimeMs: number; pages?: number; shutdownOnPageClose?: boolean }>('/api/health'),
  getConfig: () => request<AppConfig>('/api/config'),
  saveConfig: (patch: Partial<AppConfig>) =>
    request<AppConfig>('/api/config', { method: 'POST', body: JSON.stringify(patch) }),
  shutdown: () => request<{ message: string }>('/api/shutdown', { method: 'POST' }),

  /*
   * 网页会话不再用「POST 登记 / sendBeacon 注销」，而是由 pageLifecycle.ts 开一条
   * `GET /api/page/watch?sessionId=…` 的 SSE 长连接：**连接断开就等于页面没了**，
   * 这样页面被强制销毁（关浏览器 / 关 VS Code 窗口 / 崩溃）时也不会留下幽灵会话。
   */

  checkPath: (path: string) =>
    request<{ exists: boolean; readable: boolean; writable: boolean }>(
      `/api/fs/check?path=${encodeURIComponent(path)}`
    ),
  /** 源目录中是否存在归档根目录之外的待归档视频（用于选择启动页签） */
  sourcePending: () => request<{
    sourceRoot: string;
    targetRoot: string;
    readable: boolean;
    hasPending: boolean;
  }>('/api/fs/source-pending'),
  /** 显式创建目录（归档根目录不存在时） */
  ensureDir: (path: string) =>
    request<{ created: boolean; path: string; writable: boolean }>('/api/fs/ensure', {
      method: 'POST',
      body: JSON.stringify({ path })
    }),
  /** 已归档的番剧文件夹列表（供人工确认弹窗选择） */
  animeDirs: (root?: string) =>
    request<Array<{ name: string; year: number | null; month: number | null; relPath: string }>>(
      `/api/fs/anime-dirs${root ? `?root=${encodeURIComponent(root)}` : ''}`
    ),
  /**
   * 在 Windows 文件资源管理器中打开。
   * `select=true` → 打开所在文件夹**并选中**该文件；`false` → 直接打开该文件夹。
   */
  reveal: (path: string, select = false) =>
    request<{ opened: string }>('/api/fs/reveal', { method: 'POST', body: JSON.stringify({ path, select }) }),

  /** 上次扫描快照（null = 无快照，需扫描） */
  lastScan: () => request<ScanSnapshot | null>('/api/scan/last'),

  /** 手动检索 Bangumi（「分开归档 / 确认名称」弹窗里直接搜番剧，不用另开网页） */
  bangumiSearch: (q: string, limit = 8) =>
    request<BangumiSearchResult>(`/api/bangumi/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  /** 归档执行进度（断点续传：页面关掉后服务端仍在搬，重新打开可接上） */
  executeProgress: () => request<ExecuteState | null>('/api/execute/progress'),
  clearExecuteProgress: () => request<null>('/api/execute/progress', { method: 'DELETE' }),
  /**
   * 停止正在执行的归档。
   * 语义：不再开始新的文件，**已经在搬的那几个会先完成**（半途硬断会在 NAS 上留下半个文件）。
   */
  executeStop: () => request<{ stopped: boolean; batchId: string | null }>('/api/execute/stop', { method: 'POST' }),

  index: () => request<LibraryIndex | null>('/api/index'),  rebuildIndex: () => request<LibraryIndex>('/api/index/rebuild', { method: 'POST' }),
  play: (fullPath: string) =>
    request<{ played: string }>('/api/play', { method: 'POST', body: JSON.stringify({ path: fullPath }) }),
  revert: (payload: { batchId?: string; filePath?: string }) =>
    request<{ success: number; failed: number; skipped: number }>('/api/revert', {
      method: 'POST',
      body: JSON.stringify(payload)
    }),
  rename: (relPath: string, newName: string) =>
    request<{ fromPath: string; toPath: string; relPath: string }>('/api/rename', {
      method: 'POST',
      body: JSON.stringify({ relPath, newName })
    }),
  /** 媒体库内二次移动：把已归档的文件移到另一部番剧（真实移动 + 重建索引） */
  libraryMove: (payload: {
    fromPath: string; zhName: string; year: number; month: number;
    subDir?: 'SP' | 'OP&ED' | null; newName?: string;
  }) =>
    request<{ fromPath: string; toPath: string; relTargetDir: string; renamed: boolean; cleanedDirs: string[] }>(
      '/api/library/move', { method: 'POST', body: JSON.stringify(payload) }
    ),
  /**
   * 媒体库内**批量**二次移动（整部番剧一起搬）。
   * 与单文件接口的区别：**只在结束时重建一次索引** —— 逐条调单文件接口的话，
   * 100 集就是 100 次全量索引重建。
   */
  libraryMoveBatch: (payload: {
    fromPaths: string[]; zhName: string; year: number; month: number; subDir?: 'SP' | 'OP&ED' | null;
  }) =>
    request<{
      moved: number;
      unchanged: number;
      failed: Array<{ fromPath: string; error: string }>;
      relTargetDir: string;
      /** 因为这次移动而变空、被顺手删掉的目录 */
      cleanedDirs: string[];
      results: Array<{ fromPath: string; toPath: string; relTargetDir: string; renamed: boolean; cleanedDirs: string[] }>;
    }>('/api/library/move-batch', { method: 'POST', body: JSON.stringify(payload) }),
  saveAlias: (payload: { aliases: string[]; zh: string; year: number | null; month: number | null; save: boolean }) =>
    request<{ saved: boolean }>('/api/alias', { method: 'POST', body: JSON.stringify(payload) }),
  rebuildPlan: (groups: unknown, sourceRoot: string, targetRoot: string) =>
    request<ArchivePlan>('/api/plan', {
      method: 'POST',
      body: JSON.stringify({ groups, sourceRoot, targetRoot })
    })
};

/**
 * POST + SSE 流式读取（用于扫描与执行归档的实时进度）。
 */
export async function streamPost(
  path: string,
  body: unknown,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok && res.headers.get('content-type')?.includes('application/json')) {
    const json = (await res.json()) as ApiResult<unknown>;
    throw new Error(!json.ok ? json.error : `请求失败：${res.status}`);
  }
  if (!res.body) throw new Error('服务未返回数据流');
  if (!res.headers.get('content-type')?.includes('text/event-stream')) {
    const json = (await res.json()) as ApiResult<unknown>;
    if (json.ok) { onEvent({ type: 'done' }); return; }
    throw new Error(json.error);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          onEvent(JSON.parse(payload) as StreamEvent);
        } catch {
          /* 忽略无法解析的行 */
        }
      }
    }
  }
}

export function scanStream(
  payload: { sourceRoot: string; targetRoot: string; online: boolean },
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return streamPost('/api/scan', payload, onEvent, signal);
}

export function executeStream(
  plan: ArchivePlan,
  decisions: Record<string, EntryDecision>,
  onEvent: (ev: StreamEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  return streamPost('/api/execute', { plan, decisions }, onEvent, signal);
}

export type { LibraryStats };
