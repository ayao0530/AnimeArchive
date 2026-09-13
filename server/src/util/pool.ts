/**
 * 并发控制小工具
 *
 * Node 是单线程的，但对**网络文件系统（NAS / SMB）**来说瓶颈是往返延迟，
 * 而不是 CPU：一次 `stat` 要等 NAS 回一个包，串行做 1000 次就是 1000 个来回。
 * 因此这里用「受限并发」把等待重叠起来 —— 这才是扫描提速的关键。
 */

/** 信号量：限制同时进行的异步操作数量 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>(resolve => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

/**
 * 受限并发地映射数组。结果顺序与输入一致。
 * @param onDone 每完成一项回调一次（用于进度显示）
 */
export async function mapLimit<T, R>(
  list: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onDone?: (done: number, total: number) => void
): Promise<R[]> {
  const out = new Array<R>(list.length);
  if (!list.length) return out;
  const sem = new Semaphore(Math.max(1, limit));
  let done = 0;
  await Promise.all(
    list.map((item, i) =>
      sem.run(async () => {
        out[i] = await worker(item, i);
        done++;
        onDone?.(done, list.length);
      })
    )
  );
  return out;
}
