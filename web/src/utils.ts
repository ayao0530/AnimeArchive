/**
 * 前端通用工具：格式化、检索语法、匹配、高亮
 */
import type { AnimeGroup, GroupStatus, LibraryAnime } from './types';

export const pad = (n: number | string | null | undefined): string => String(n ?? '').padStart(2, '0');

export function padEpisode(ep: string | null | undefined): string {
  if (!ep) return '';
  const m = String(ep).match(/^(\d+)(.*)$/);
  return m ? m[1].padStart(2, '0') + m[2] : ep;
}

/** 自然序：数字段按数值比（`02` < `10`），其余按字典序 */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

/** 集数字符串 → [数字, 后缀]（`24v2` → [24, 'v2']；解析不出数字时返回 null） */
function episodeKey(ep: string | null | undefined): [number, string] | null {
  const m = /^(\d+)(.*)$/.exec(String(ep ?? '').trim());
  return m ? [Number(m[1]), m[2].trim().toLowerCase()] : null;
}

/**
 * 媒体库文件排序：**按集数的数字顺序**，而不是按文件名字符串。
 *
 * 为什么不能按文件名整串排：同一部番剧常混着多个字幕组
 * （`[BeanSub&FZSD]…` / `[Nekomoe kissaten]…`），整串排会把它俩各自排成一堆 ——
 * 01 后面直接跟 14，而 02 要翻到另一段才出现（实测就是这个现象）。
 *
 * 规则：
 *  1. 解析得出集数的在前，按数值排（`24` 在 `25` 前，`2` 在 `10` 前）；
 *  2. 同集数按后缀排（`24` 在 `24v2` 前）；
 *  3. 都解析不出集数的（NCOP / 特典 / 未识别）放最后，按文件名自然序。
 */
export function compareByEpisode(
  a: { episode?: string | null; name: string },
  b: { episode?: string | null; name: string }
): number {
  const ea = episodeKey(a.episode);
  const eb = episodeKey(b.episode);
  if (ea && eb) {
    if (ea[0] !== eb[0]) return ea[0] - eb[0];
    if (ea[1] !== eb[1]) return ea[1] < eb[1] ? -1 : 1;
    return naturalCompare(a.name, b.name);
  }
  if (ea) return -1;   // 有集数的排前面
  if (eb) return 1;
  return naturalCompare(a.name, b.name);
}

/**
 * 用 `\` 拼接路径片段，**并保住 UNC 前缀**。
 *
 * ⚠ 不要写成 `parts.join('\\').replace(/\\+/g, '\\')`：
 * 那会把 `\\NAS\share\…` 压成 `\NAS\share\…`，Windows 会把它解析成「当前盘符根目录」，
 * 于是归档目标静默变成本机磁盘上的路径。后端 `fsx.joinWinPath()` 是同一套实现。
 */
export function joinWinPath(parts: Array<string | null | undefined>): string {
  const joined = parts.filter((p): p is string => Boolean(p)).join('\\');
  if (!joined) return '';
  const lead = joined.startsWith('\\\\') ? '\\\\' : '';
  return lead + joined.slice(lead.length).replace(/\\+/g, '\\').replace(/\\+$/, '');
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return iso;
  }
}

/**
 * ISO 时间 → 固定宽度的「2021-11-14 16:06」（不含秒，便于列表对齐）。
 *
 * 不用 `toLocaleString`：不同区域设置会输出 `2021/11/14 下午4:06` 之类的不定长字符串，
 * 在一列文件里无法对齐。
 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function nowTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** ISO 时间 → 紧凑可读「09-12 01:50」（用于「上次扫描时间」提示） */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ---------------- 交互 ---------------- */

/**
 * 「整行可点 = 勾选」的行点击守卫：正在拖选文本时不算「点击这一行」。
 *
 * 文件名经常要拖选一段去检索，若把拖选也当成点击，就会顺手把这一行勾上。
 */
export function isTextSelecting(): boolean {
  return !!window.getSelection()?.toString();
}

/* ---------------- 状态 ---------------- */

/** 数据来源的友好标签 */
export function sourceLabel(src: string | undefined | null): string {
  switch (src) {
    case 'builtin': return '内置别名表';
    case 'local': return '本地别名表';
    case 'bangumi': return 'Bangumi';
    case 'web': return '网页检索 + Bangumi';
    case 'anilist': return 'AniList';
    case 'manual': return '人工确认';
    case 'fallback': return '兜底规则';
    default: return src || '—';
  }
}

export const STATUS_TEXT: Record<GroupStatus, string> = {
  ready: '可归档',
  review: '待确认',
  conflict: '冲突',
  unrecognized: '未识别',
  deferred: '待处理',
  skipped: '已跳过',
  done: '已完成',
  failed: '失败'
};

export const STATUS_CLASS: Record<GroupStatus, string> = {
  ready: 'ok',
  review: 'warn',
  conflict: 'conf',
  unrecognized: 'err',
  deferred: 'src',
  skipped: 'src',
  done: 'src',
  failed: 'err'
};

export const STATUS_COLOR: Record<GroupStatus, string> = {
  ready: '#27c08a',
  review: '#f2b632',
  conflict: '#f2802b',
  unrecognized: '#ef5566',
  deferred: '#697691',
  skipped: '#697691',
  done: '#3ba9ff',
  failed: '#ef5566'
};

/* ---------------- 检索语法 ---------------- */

export interface ParsedQuery {
  terms: string[];
  filters: Record<string, string>;
}

const FILTER_KEYS = ['year', 'month', 'ep', 'group', 'status', 'type', 'lang', 'src'];

export function parseQuery(q: string): ParsedQuery {
  const terms: string[] = [];
  const filters: Record<string, string> = {};
  q.trim().split(/\s+/).filter(Boolean).forEach(tok => {
    const m = tok.match(/^([a-z]+):(.+)$/i);
    if (m && FILTER_KEYS.includes(m[1].toLowerCase())) filters[m[1].toLowerCase()] = m[2].toLowerCase();
    else terms.push(tok.toLowerCase());
  });
  return { terms, filters };
}

/** 组的目标相对目录（与后端 planner.relativeTargetDir 保持一致） */
export function groupTargetDir(g: AnimeGroup): string {
  if (g.status === 'unrecognized') {
    const base = g.items[0]?.scanItem.name ?? 'unknown';
    const stem = base.replace(/\.[^.]+$/, '');
    return `_未识别\\${safeSegment(stem)}`;
  }
  if (g.status === 'deferred' || g.year === null || g.month === null) {
    return `_待确认\\${safeSegment(g.zhName || g.rawNames[0] || '未确认')}`;
  }
  return `${g.year}\\${pad(g.month)}\\${safeSegment(g.zhName)}`;
}

export function safeSegment(name: string): string {
  const v = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return v || '未命名';
}

/** 条目在右侧树中的显示名（冲突重命名后为最终名称） */
export function entryTargetName(g: AnimeGroup, index: number): string {
  const it = g.items[index];
  return it?.renameTo || it?.scanItem.name || '';
}

export function groupHaystack(g: AnimeGroup): string {
  return [
    ...g.rawNames,
    g.zhName,
    g.year,
    g.month,
    g.releaseGroup,
    g.note,
    g.resolution?.matchLevel,
    g.resolution?.dataSource,
    g.resolution?.candidates.map(c => c.name).join(' '),
    g.resolution?.alternateNames.join(' '),
    g.items.map(i => i.scanItem.name).join(' '),
    g.items.map(i => i.parsed.mediaType).join(' '),
    g.items.map(i => i.parsed.subDir).join(' '),
    groupTargetDir(g)
  ].filter(Boolean).join(' ').toLowerCase();
}

export function matchGroup(g: AnimeGroup, pq: ParsedQuery, filter: string, doneSet: Set<string>): boolean {
  const st: GroupStatus = doneSet.has(g.groupId) ? 'done' : g.status;
  if (filter !== 'all' && st !== filter && !(filter === 'ready' && st === 'done')) return false;

  const hay = groupHaystack(g);
  for (const t of pq.terms) if (!hay.includes(t)) return false;

  const f = pq.filters;
  if (f.year && String(g.year ?? '') !== f.year) return false;
  if (f.month && pad(g.month ?? '') !== pad(f.month)) return false;
  if (f.group && !(g.releaseGroup ?? '').toLowerCase().includes(f.group)) return false;
  if (f.status && st !== f.status) return false;
  if (f.ep && !g.items.some(i => padEpisode(i.parsed.episode).toLowerCase().startsWith(f.ep))) return false;
  if (f.type && !g.items.some(i => i.parsed.mediaType.toLowerCase() === f.type)) return false;
  return true;
}

/* ---------------- 媒体库检索 ---------------- */

export function allLibraryFiles(a: LibraryAnime) {
  return [...a.files, ...(a.subDirs ?? []).flatMap(s => s.files)];
}

export function libraryHaystack(a: LibraryAnime): string {
  return [
    a.zhName,
    ...(a.aliases ?? []),
    a.year,
    a.month,
    a.relPath,
    allLibraryFiles(a).map(f => f.name).join(' ')
  ].filter(Boolean).join(' ').toLowerCase();
}

export function matchAnime(a: LibraryAnime, pq: ParsedQuery): boolean {
  const hay = libraryHaystack(a);
  for (const t of pq.terms) if (!hay.includes(t)) return false;
  const f = pq.filters;
  if (f.year && String(a.year ?? '') !== f.year) return false;
  if (f.month && String(a.month ?? '') !== pad(f.month)) {
    if (pad(a.month ?? '') !== pad(f.month)) return false;
  }
  if (f.ep && !allLibraryFiles(a).some(x => padEpisode(x.episode).toLowerCase().startsWith(f.ep))) return false;
  if (f.type === 'sp' && !(a.subDirs ?? []).some(s => s.dir.toUpperCase().includes('SP'))) return false;
  return true;
}

/* ---------------- 高亮 ---------------- */

function escapeHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 关键词高亮（返回 HTML 字符串，输入已被转义） */
export function highlight(text: string, terms: string[]): string {
  let out = escapeHtml(text);
  if (!terms?.length) return out;
  terms.forEach(t => {
    if (!t) return;
    out = out.replace(new RegExp(`(${escapeRegExp(escapeHtml(t))})`, 'gi'), '<mark>$1</mark>');
  });
  return out;
}
