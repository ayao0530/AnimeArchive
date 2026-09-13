/**
 * 极简 HTTPS 客户端（零依赖）
 *
 * 被 bangumi / websearch 两个数据源共用：
 *  - 统一 User-Agent（Bangumi 会拒绝默认 UA）
 *  - 可配置的最小请求间隔（令牌桶式限流）
 *  - 超时 + 重试
 */
import * as https from 'node:https';
import { URL } from 'node:url';

export const USER_AGENT =
  'anime-archive-tool/1.0.0 (https://github.com/local/anime-archive-tool; local-single-user)';

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** 简易令牌桶：保证两次请求之间至少间隔 minIntervalMs */
export class RateLimiter {
  private last = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly minIntervalMs: number) {}

  async take(): Promise<void> {
    const run = async (): Promise<void> => {
      const now = Date.now();
      const wait = Math.max(0, this.minIntervalMs - (now - this.last));
      if (wait > 0) await sleep(wait);
      this.last = Date.now();
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

export interface HttpTextResult {
  status: number;
  body: string;
}

export function httpRequest(
  url: string,
  options: {
    method?: 'GET' | 'POST';
    body?: string;
    timeoutMs?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<HttpTextResult> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method ?? 'GET',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          ...(options.body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(options.body) }
            : {}),
          ...options.headers
        },
        timeout: options.timeoutMs ?? 12000
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', c => chunks.push(Buffer.from(c)));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('timeout', () => { req.destroy(new Error(`请求超时：${u.hostname}`)); });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * 带限流 + 重试的 JSON 请求。
 * 返回 null 表示「没有结果」（4xx 或解析失败）——不抛异常，调用方按空结果处理。
 */
export async function httpJson<T>(
  url: string,
  limiter: RateLimiter,
  options: {
    method?: 'GET' | 'POST';
    body?: string;
    retries?: number;
    /** 视为「确实没有结果」的状态码（不重试） */
    missStatus?: number[];
  } = {}
): Promise<T | null> {
  const retries = options.retries ?? 1;
  const miss = new Set(options.missStatus ?? [400, 404]);
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.take();
    try {
      const res = await httpRequest(url, { method: options.method, body: options.body });
      if (res.status === 200) {
        try {
          return JSON.parse(res.body) as T;
        } catch {
          return null;
        }
      }
      if (miss.has(res.status)) return null;
      if (res.status === 429 || res.status >= 500) {
        await sleep(700 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}
