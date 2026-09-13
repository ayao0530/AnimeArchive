/**
 * 网页连接登记 —— 「还有页面连着吗？」
 *
 * 用途：**关掉最后一个网页 → 自动关闭本地服务**（配置 `shutdownOnPageClose`）。
 *
 * ## 为什么用「长连接」而不是前端 sendBeacon 上报
 *
 * 早前的实现是：页面加载时 `POST /api/page/open` 登记，关闭时 `sendBeacon('/api/page/close')` 注销。
 * 它有一个致命缺陷 —— **页面被「强制销毁」时浏览器根本不会发 unload 事件**：
 * 关掉整个浏览器 / 关掉 VS Code 窗口 / 预览被回收 / 标签页崩溃……
 * 这些情况下信令发不出去，那个会话就**永远留在登记表里**，
 * 于是「最后一个页面关掉了」永远不成立 ⇒ **关页自动关服务从此永久失效**（用户实测踩到）。
 *
 * 长连接（SSE）没有这个问题：页面一没，TCP 连接被系统关掉，服务端立刻知道；
 * 页面还在但断了线（罕见）时，浏览器按服务端下发的 `retry:` 自动重连，
 * 而下面的**宽限期**正好盖住这零点几秒的空窗。
 *
 * ## 三条规则
 *  1. **同一个 id 可以有多条连接**（刷新时新旧连接短暂并存；dev 下 React 双挂载也会）⇒ 按引用计数。
 *  2. 计数归零**不立即**退出，先等 `graceMs`（默认 2.5s）；期间有新连接进来（= 刷新回来了）就取消。
 *  3. 配置里关掉该功能时（`shutdownOnPageClose: false`）只登记、绝不退出。
 */

export interface PageSessions {
  /**
   * 一个页面建立长连接；**返回值是「断开」函数**（连接关闭时必须调用一次）。
   * 同一个 id 重复调用会累加计数，对应地调用同样次数的断开函数即可。
   */
  attach: (id: string) => () => void;
  /** 当前连着的页面数（按 id 计，诊断用） */
  count: () => number;
  /** 是否有挂起的自动关闭（诊断 / 测试用） */
  pending: () => boolean;
  /** 清空所有连接与挂起的定时器（关服务前收尾 / 测试用） */
  reset: () => void;
}

export interface PageSessionsOptions {
  /**
   * 最后一个页面断开后等多久再真正关闭服务。
   * 这一段就是「给刷新留的时间」：新页面会在几百毫秒内重新连上。
   */
  graceMs?: number;
  /** 是否启用自动关闭（`shutdownOnPageClose === false` 时只登记、不关闭） */
  enabled?: () => boolean;
  /** 宽限期结束且仍然没有页面 → 由调用方去真正关闭服务 */
  onCloseService: () => void;
  /** 日志（服务端控制台） */
  log?: (msg: string) => void;
}

/** 2.5 秒：够刷新页面重新连上，又不至于让用户觉得「关了网页服务还赖着」 */
export const DEFAULT_PAGE_CLOSE_GRACE_MS = 2500;

export function createPageSessions(opts: PageSessionsOptions): PageSessions {
  const graceMs = opts.graceMs ?? DEFAULT_PAGE_CLOSE_GRACE_MS;
  const enabled = opts.enabled ?? ((): boolean => true);
  const log = opts.log ?? ((): void => undefined);

  /** id → 连接数（同一页面可能短暂并存多条连接） */
  const pages = new Map<string, number>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (why: string): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    log(`↩ 已取消自动关闭服务（${why}）`);
  };

  const schedule = (): void => {
    if (timer) return;
    if (!enabled()) {
      log('ℹ 最后一个页面已断开，但设置里已关闭「关闭网页时自动关闭服务」→ 服务继续运行');
      return;
    }
    const label = graceMs >= 1000 ? `${graceMs / 1000} 秒` : `${graceMs} 毫秒`;
    log(`ℹ 最后一个页面已断开 → ${label}后自动关闭服务（期间重新打开页面可取消）`);
    timer = setTimeout(() => {
      timer = null;
      opts.onCloseService();
    }, graceMs);
  };

  return {
    attach: id => {
      const key = id || '(anonymous)';
      pages.set(key, (pages.get(key) ?? 0) + 1);
      cancel('页面重新连上');
      let detached = false;
      return () => {
        if (detached) return;              // close/error 都会触发，防重复断开
        detached = true;
        const left = (pages.get(key) ?? 0) - 1;
        if (left > 0) pages.set(key, left);
        else {
          pages.delete(key);
          if (pages.size === 0) schedule();
        }
      };
    },

    count: () => pages.size,
    pending: () => timer !== null,
    reset: () => {
      cancel('reset');
      pages.clear();
    }
  };
}
