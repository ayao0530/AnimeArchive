/**
 * 网页生命周期 → 本地服务联动：**关闭网页就自动关闭本地服务**
 *
 * 规则（与设置里的「关闭网页时自动关闭服务」开关联动，默认开）：
 *  - 没任务在跑 → 直接关：页面一关，服务端在宽限期（2.5s）后退出；
 *  - 有任务在跑 → 先用浏览器**原生二次确认**弹窗拦一下（「确定要离开吗」），
 *    取消 ⇒ 什么都不发生；确认 ⇒ 才注销会话、关页面，服务端会先让归档批次收尾再退出。
 *
 * 两个细节：
 *  1. **刷新不会误关**：会话 id 只属于「本次页面加载」，刷新等于新会话；
 *     服务端拿到关闭信令后会等宽限期，新页面在这段时间内登记就取消关闭。
 *  2. **多标签页**：每个标签页各自一个会话，只有**最后一个**页面关掉才会关服务。
 *
 * ⚠ 关闭信令必须走 `navigator.sendBeacon`：卸载阶段普通 fetch 会被浏览器取消。
 *   传字符串（Content-Type 变成 text/plain）可避免 CORS 预检，卸载期才真的发得出去。
 */
import { api, apiUrl } from './api/client';
import { useApp } from './store';

/** 本次页面加载的会话 id（刻意不持久化：刷新 = 新会话，多标签页 = 各自独立） */
const sessionId = newSessionId();

let installed = false;
let tracked = false;
let closeSent = false;

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

async function register(): Promise<void> {
  if (tracked) return;
  try {
    await api.pageOpen(sessionId);
    tracked = true;
  } catch {
    /* 服务没起来 / 暂时不可达：忽略，之后状态变化时会再登记 */
  }
}

function sendCloseSignal(): void {
  if (closeSent || !tracked || !autoCloseEnabled()) return;
  closeSent = true;
  const url = apiUrl('/api/page/close');
  const body = JSON.stringify({ sessionId });
  try {
    if (navigator.sendBeacon?.(url, body)) return;
  } catch {
    /* 落到下面的 fetch */
  }
  try {
    void fetch(url, { method: 'POST', body, keepalive: true, headers: { 'Content-Type': 'text/plain' } });
  } catch {
    /* 卸载阶段发不出去也没关系：服务端有 stop.bat / ⏻ 按钮兜底 */
  }
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
    // 进 bfcache 时也会触发 pagehide，但页面还会回来 → 不发信令
    if (e.persisted) return;
    sendCloseSignal();
  });
  window.addEventListener('unload', () => sendCloseSignal()); // 兜底（个别场景 pagehide 不触发）

  // 服务上线（首次连接 / 点「↻ 重新检测服务」）→ 登记；服务被手动关掉 → 下次上线重新登记
  useApp.subscribe(state => {
    if (state.serviceOnline) void register();
    else {
      tracked = false;
      closeSent = false;
    }
  });
  if (useApp.getState().serviceOnline) void register();
}
