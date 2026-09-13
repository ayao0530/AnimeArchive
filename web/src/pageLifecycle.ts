/**
 * 网页生命周期 → 本地服务联动：**关闭网页就自动关闭本地服务**
 *
 * 规则（与设置里的「关闭网页时自动关闭服务」开关联动，默认开）：
 *  - 没任务在跑 → 直接关：页面一关，服务端在宽限期（2.5s）后退出；
 *  - 有任务在跑 → 先用浏览器**原生二次确认**弹窗拦一下（「确定要离开吗」），
 *    取消 ⇒ 什么都不发生；确认 ⇒ 才关页面，服务端会先让归档批次收尾再退出。
 *
 * ## 登记方式是「长连接」，不是「关页时发请求」
 *
 * 页面加载时开一条 SSE：`GET /api/page/watch?sessionId=…`。
 * **连接断开 = 页面没了**，服务端立刻知道 —— 这样即使页面是被强制销毁的
 * （关掉整个浏览器 / 关掉 VS Code 窗口 / 预览被回收 / 崩溃，这些场景浏览器**不会**发 unload），
 * 也不会留下「幽灵会话」把「关掉最后一个页面就关服务」永久堵死。
 *
 * 两个细节：
 *  1. **刷新不会误关**：sessionId 只属于「本次页面加载」，刷新 = 新 id 新连接；
 *     服务端拿到「最后一个连接断开」后会等宽限期，新连接在这段时间内连上就取消。
 *  2. **多标签页**：每个标签页各自一条连接，只有**最后一个**页面关掉才会关服务。
 *
 * ⚠ 服务端下发了 `retry: 1000`：万一连接抖动，浏览器 1 秒后就重连，不会超过宽限期。
 */
import { apiUrl } from './api/client';
import { useApp } from './store';

/** 本次页面加载的连接 id（刻意不持久化：刷新 = 新 id，多标签页 = 各自独立） */
const sessionId = newSessionId();

let installed = false;
let es: EventSource | null = null;

function newSessionId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `page-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 设置里是否开启了自动关闭（服务端也有一道同样的判断，双保险） */
function autoCloseEnabled(): boolean {
  return useApp.getState().config?.shutdownOnPageClose !== false;
}

/** 是否有任务在跑：界面在忙（扫描/归档/撤回/移动…）或服务端后台还有归档批次 */
export function isTaskRunning(): boolean {
  const st = useApp.getState();
  return st.busy !== null || st.execProgress?.running === true;
}

/** 开长连接（服务在线时调用；重复调用无副作用） */
function startWatch(): void {
  if (es || !autoCloseEnabled()) return;
  if (typeof EventSource === 'undefined') return;   // 极老的浏览器：退化为「只能手动关服务」
  try {
    es = new EventSource(apiUrl(`/api/page/watch?sessionId=${encodeURIComponent(sessionId)}`));
    // 断线（服务重启 / 网络抖动）时浏览器会按 retry: 1000 自动重连，这里无需处理 onerror
    es.onerror = () => { /* 交给浏览器自动重连；事件源在 404 等致命错误下会自行停止重试 */ };
  } catch {
    es = null;
  }
}

/** 主动断开长连接（服务被手动关掉 / 页面真的要走了） */
function stopWatch(): void {
  try { es?.close(); } catch { /* ignore */ }
  es = null;
}

export function installPageLifecycle(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('beforeunload', (e: BeforeUnloadEvent) => {
    // 有任务在跑才拦：让浏览器弹原生的二次确认（这段文案由浏览器决定，JS 改不了）
    if (!autoCloseEnabled() || !isTaskRunning()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  window.addEventListener('pagehide', (e: PageTransitionEvent) => {
    // 主动断掉，服务端立刻知道（浏览器稍后也会断，这样更快）；
    // 进 bfcache 时 pagehide 也会触发，但页面还会回来 → 交给下面的 pageshow 重新连上
    if (e.persisted) return;
    stopWatch();
  });
  window.addEventListener('unload', () => stopWatch());          // 兜底
  window.addEventListener('pageshow', e => {
    // bfcache 恢复 / 前进后退回来：重新连上（服务端此时可能已经在宽限期里了）
    if (e.persisted) startWatch();
  });

  // 服务上线（首次连接 / 点「↻ 重新检测服务」）→ 开连接；服务被手动关掉 → 断开
  useApp.subscribe(state => {
    if (state.serviceOnline) startWatch();
    else stopWatch();
  });
  if (useApp.getState().serviceOnline) startWatch();
}
