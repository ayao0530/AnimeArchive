/**
 * 网页会话登记 —— 「还有页面开着吗？」
 *
 * 用途：**关掉最后一个网页 → 自动关闭本地服务**（配置 `shutdownOnPageClose`）。
 *
 * 为什么不直接在浏览器 beforeunload 里调一次 `/api/shutdown` 就完事？
 *  1. **刷新页面（F5 / Ctrl+R）同样会触发卸载** —— 卸载即关闭的话，用户一刷新服务就没了。
 *     做法：最后一个会话注销后先等 `graceMs`（宽限期）；期间只要有新页面登记（= 刷新回来了）
 *     就取消关闭。
 *  2. **多标签页**：只要还有任何一个页面开着就不能停服务（关掉其中一个标签页不该停服务）。
 *     做法：会话按「页面」登记，只有登记表清空才考虑关闭。
 *  3. **误伤**：只认「登记过的会话 id」。没登记过的 id 一律忽略，避免其它工具（或残留的旧页面）
 *     随手发一个请求就把服务关掉。
 *
 * 已知取舍：如果服务是**在页面开着的时候**被重启过（登记表被清空），那个页面再关闭时
 * 服务不会自动跟着退出（因为 id 认不出来）—— 此时用网页上的「⏻ 关闭服务」或 `stop.bat` 即可。
 */

export interface PageSessions {
  /** 页面打开（或刷新后重新登记）：会取消挂起的自动关闭 */
  open: (id: string) => void;
  /** 页面关闭；返回 true = 已受理（该会话确实登记过），false = 未知会话（忽略） */
  close: (id: string) => boolean;
  /** 当前还开着的页面数（诊断用） */
  count: () => number;
  /** 是否有挂起的自动关闭（诊断 / 测试用） */
  pending: () => boolean;
  /** 清空会话与挂起的定时器（关服务前收尾 / 测试用） */
  reset: () => void;
}

export interface PageSessionsOptions {
  /**
   * 最后一个页面关闭后等多久再真正关闭服务。
   * 这一段就是「给刷新留的时间」：刷新时新页面会在几百毫秒内重新登记。
   */
  graceMs?: number;
  /** 是否启用自动关闭（`shutdownOnPageClose === false` 时只登记、不关闭） */
  enabled?: () => boolean;
  /** 宽限期结束且仍然没有页面 → 由调用方去真正关闭服务 */
  onCloseService: () => void;
  /** 日志（服务端控制台） */
  log?: (msg: string) => void;
}

/** 2.5 秒：够刷新页面重新登记，又不至于让用户觉得「关了网页服务还在」 */
export const DEFAULT_PAGE_CLOSE_GRACE_MS = 2500;

export function createPageSessions(opts: PageSessionsOptions): PageSessions {
  const graceMs = opts.graceMs ?? DEFAULT_PAGE_CLOSE_GRACE_MS;
  const enabled = opts.enabled ?? ((): boolean => true);
  const log = opts.log ?? ((): void => undefined);

  const pages = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (why: string): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    log(`↩ 已取消自动关闭服务（${why}）`);
  };

  return {
    open: id => {
      if (!id) return;
      const isNew = !pages.has(id);
      pages.add(id);
      if (isNew) cancel('页面重新打开 / 刷新');
    },

    close: id => {
      // 未登记过的会话：忽略（防止别的工具一个请求就把服务关掉）
      if (!pages.delete(id)) return false;
      if (pages.size > 0) return true;            // 还有别的页面开着 → 不关
      if (timer) return true;                     // 已经在倒计时 → 不重复计时
      if (!enabled()) {
        log('ℹ 最后一个页面已关闭，但设置里已关闭「关闭网页时自动关闭服务」→ 服务继续运行');
        return true;
      }
      log(`ℹ 最后一个页面已关闭 → ${graceMs >= 1000 ? `${graceMs / 1000} 秒` : `${graceMs} 毫秒`}后自动关闭服务（期间重新打开页面可取消）`);
      timer = setTimeout(() => {
        timer = null;
        opts.onCloseService();
      }, graceMs);
      return true;
    },

    count: () => pages.size,
    pending: () => timer !== null,
    reset: () => {
      cancel('reset');
      pages.clear();
    }
  };
}
