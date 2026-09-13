/**
 * Bangumi API 客户端（《需求与设计文档》4.1 L2 / 13.1.1）
 *
 *  - 权威来源：官方中文名（`name_cn`）+ 首播日期（`date`）
 *  - 必须带自定义 User-Agent（Bangumi 会拒绝默认 UA）
 *  - 限流 3 QPS + 失败重试 + 本地缓存（缓存由 Store 负责）
 */
import { RateLimiter, httpRequest as request, sleep, USER_AGENT } from '../net/http';

export { USER_AGENT };

export interface BangumiSubject {
  id: number;
  name: string;
  nameCn: string;
  date: string | null;
  year: number | null;
  month: number | null;
  aliases: string[];
  score: number;
  type: number;
}

/** 令牌桶：保证 ≥ 340ms 间隔（约 3 QPS） */
const limiter = new RateLimiter(340);

function parseDate(date: string | null | undefined): { year: number | null; month: number | null } {
  if (!date) return { year: null, month: null };
  const m = String(date).match(/^(\d{4})-(\d{1,2})/);
  if (!m) return { year: null, month: null };
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** 将 Bangumi date 中的季度占位（1/4/7/10 的 1 日）保留原样：以实际首播月为准 */
function fromLegacySubject(s: any, score = 0.7): BangumiSubject {
  const { year, month } = parseDate(s.air_date ?? null);
  const nameCn = String(s.name_cn ?? '').trim();
  const infobox = Array.isArray(s.infobox) ? s.infobox : [];
  const aliases: string[] = [];
  infobox.forEach((box: any) => {
    if (!box || typeof box.key !== 'string') return;
    if (/别名|別名|中文名|英文名|日文名|罗马字|羅馬字/.test(box.key)) {
      const v = box.value;
      if (Array.isArray(v)) v.forEach((x: any) => { if (x?.v) aliases.push(String(x.v)); });
      else if (v) aliases.push(String(v));
    }
  });
  return {
    id: Number(s.id),
    name: String(s.name ?? ''),
    nameCn,
    date: s.air_date ?? null,
    year,
    month,
    aliases,
    score,
    type: Number(s.type ?? 2)
  };
}

/** 联网搜索条目（type=2 即动画）；旧接口无结果时回退到 v0 搜索接口 */
export async function searchSubjects(keyword: string, retries = 2): Promise<BangumiSubject[]> {
  const legacy = await searchLegacy(keyword, retries);
  if (legacy.length) return legacy;
  const v0 = await searchV0(keyword, retries);
  if (v0.length) return v0;
  // 再退一步：去掉标点后再试旧接口（如 `Bocchi the Rock!` 的 `!` 会干扰检索）
  const stripped = keyword.replace(/[!！?？★☆♪♥♡～~・·•●○◆◇■□▲△▼▽※∴∵:：,，.。/\\]+/g, ' ').trim();
  if (stripped && stripped !== keyword) return searchLegacy(stripped, 1);
  return [];
}

async function searchLegacy(kw: string, retries: number): Promise<BangumiSubject[]> {
  if (!kw) return [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.take();
    try {
      const url =
        `https://api.bgm.tv/search/subject/${encodeURIComponent(kw)}` +
        `?type=2&responseGroup=large&max_results=8&start=0`;
      const res = await request(url);
      if (res.status === 200) {
        const json = JSON.parse(res.body) as any;
        const list: any[] = Array.isArray(json?.list) ? json.list : [];
        return list.map(x => fromLegacySubject(x));
      }
      if (res.status === 404) return [];
      if (res.status === 429 || res.status >= 500) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      return [];
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return [];
}

async function searchV0(kw: string, retries: number): Promise<BangumiSubject[]> {
  if (!kw) return [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.take();
    try {
      const body = JSON.stringify({ keyword: kw, filter: { type: [2] } });
      const res = await request('https://api.bgm.tv/v0/search/subjects?limit=8&offset=0', {
        method: 'POST',
        body
      });
      if (res.status === 200) {
        const json = JSON.parse(res.body) as any;
        const list: any[] = Array.isArray(json?.data) ? json.data : [];
        return list.map(s => {
          const { year, month } = parseDate(s.date ?? null);
          return {
            id: Number(s.id),
            name: String(s.name ?? ''),
            nameCn: String(s.name_cn ?? '').trim(),
            date: s.date ?? null,
            year,
            month,
            aliases: [],
            score: 0.7,
            type: Number(s.type ?? 2)
          } as BangumiSubject;
        });
      }
      if (res.status === 429 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue; }
      return [];
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return [];
}

/** 查询条目详情（拿 name_cn + 别名 + 首播日期） */
export async function getSubject(id: number, retries = 1): Promise<BangumiSubject | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    await limiter.take();
    try {
      const res = await request(`https://api.bgm.tv/v0/subjects/${id}`);
      if (res.status === 200) {
        const s = JSON.parse(res.body) as any;
        if (!s?.id) return null;
        const { year, month } = parseDate(s.date ?? null);
        const aliases: string[] = [];
        if (Array.isArray(s.infobox)) {
          s.infobox.forEach((box: any) => {
            if (!box || typeof box.key !== 'string') return;
            if (/别名|別名|中文名|英文名|日文名|罗马字|羅馬字/.test(box.key)) {
              const v = box.value;
              if (Array.isArray(v)) v.forEach((x: any) => { if (x?.v) aliases.push(String(x.v)); });
              else if (v) aliases.push(String(v));
            }
          });
        }
        return {
          id: Number(s.id),
          name: String(s.name ?? ''),
          nameCn: String(s.name_cn ?? '').trim(),
          date: s.date ?? null,
          year,
          month,
          aliases,
          score: 0.8,
          type: Number(s.type ?? 2)
        };
      }
      if (res.status === 429 || res.status >= 500) { await sleep(600 * (attempt + 1)); continue; }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

/** 探测网络是否可用（快速失败，避免断网时长时间卡住） */
export async function probe(): Promise<boolean> {
  try {
    await limiter.take();
    const res = await request('https://api.bgm.tv/v0/subjects/8', { timeoutMs: 4000 });
    return res.status > 0;
  } catch {
    return false;
  }
}
