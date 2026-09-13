/**
 * 文本预处理 + 相似度算法（对应《需求与设计文档》4.2 / 4.3）
 */
import { T2S_TABLE } from './t2s-data';

/* ============ 繁 → 简（完整字表，由 OpenCC TSCharacters.txt 生成） ============ */

/**
 * 繁体 → 简体。
 *
 * ⚠ 这里**必须**用完整字表：早期手工挑的「高频字表」缺了几百个常用字
 * （給 宮 僅 擇 擊 捲 搖 換 檔 剋 傳 迴 獨 滅 …均未收录），后果不只是「繁体名搜不到」，
 * 而是会**命中错误条目** —— 实测「孤獨搖滾」在 Bangumi 的首条是「透明的孤独」、
 * 「咒術迴戰」首条是 4D 电影版；换成「孤独摇滚」「咒术回战」才一次命中正确的 TV 条目。
 */
export function toSimplified(input: string): string {
  let out = '';
  for (const ch of input) out += T2S_TABLE[ch] ?? ch;
  return out;
}


/* ============ 预处理 ============ */

/** 发布信息标签（`[...]` 内的内容，命中即视为噪声） */
const JUNK_TAG = /^(?:[a-z0-9\-_.]+|1080p|720p|2160p|4k|bdrip|web-?dl|web-?rip|bluray|bd|tv|hevc|avc|h\.?26[45]|x26[45]|aac|flac|ac3|opus|mp3|chs|cht|jpn|gb|big5|简|繁|日|简繁|简繁日|简日|繁日|双语|字幕|内封|外挂|mkv|mp4|avi|ass|mkv|mp4|v2|v3)$/i;

/** 需要剥离的发布后缀词 */
const JUNK_WORDS = [
  'bdrip', 'bd-rip', 'webrip', 'web-rip', 'webdl', 'web-dl', 'bluray', 'blu-ray', 'hdtv', 'dvdrip',
  '1080p', '720p', '480p', '2160p', '4k', '8bit', '10bit', 'hi10p',
  'hevc', 'avc', 'avc1', 'x264', 'x265', 'h264', 'h265', 'aac', 'flac', 'ac3', 'eac3', 'opus', 'mp3', 'dts',
  'chs', 'cht', 'jpn', 'jp', 'gb', 'big5', 'sc', 'tc', 'tc&sc',
  '简繁日', '简日双语', '简繁', '简日', '繁日', '双语', '简中', '繁中', '内封', '外挂', '字幕',
  'mkv', 'mp4', 'avi', 'wmv', 'flv', 'mov', 'ts', 'm2ts', 'ass', 'srt',
  'repack', 'proper', 'uncensored', 'censored'
];

/** 装饰性符号 */
const DECOR = /[!！?？★☆♪♥♡～~・·•●○◆◇■□▲△▼▽※∴∵]/g;

/** 长音符还原 */
const MACRON: Record<string, string> = {
  'ā': 'aa', 'ī': 'ii', 'ū': 'uu', 'ē': 'ee', 'ō': 'ou',
  'Ā': 'Aa', 'Ī': 'Ii', 'Ū': 'Uu', 'Ē': 'Ee', 'Ō': 'Ou'
};

/**
 * 名称归一化预处理（文档 4.2 的 10 个步骤）
 * 输入：任意写法（可能含标签、集数、后缀）
 * 输出：用于比对/检索的规范化字符串
 */
export function preprocess(raw: string): string {
  let s = String(raw ?? '');

  // 1. 去 `[...]` `(...)` `【...】` 标签
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/【[^】]*】/g, ' ')
    .replace(/「[^」]*」/g, ' ').replace(/『[^』]*』/g, ' ');

  // 2. 去集数段（注意：**先保护季数标记**，否则 `Season 2` / `第2季` 的数字会被当集数删掉）
  // 2a. 季数写法「粘合」成不会被误删的形态
  s = s
    .replace(/\b(?:season|s)\s*0*(\d{1,2})\b/gi, ' Season$1 ')
    .replace(/\b0*(\d{1,2})(?:st|nd|rd|th)\s*season\b/gi, ' Season$1 ')
    .replace(/第\s*0*(\d{1,3})\s*([季期部])/g, ' 第$1$2 ')
    .replace(/\bpart\s*0*(\d{1,2})\b/gi, ' Part$1 ');

  // 2b. 明确的集数写法（第01话 / EP01 / 01话）
  s = s.replace(
    /(?:第\s*0*\d{1,4}\s*[话話集話數]|\b(?:ep|episode)\s*0*\d{1,4}(?:v\d)?\b|\b0*\d{1,4}(?:v\d)?\s*[话話集]\b)/gi,
    ' '
  );

  // 2c. 独立数字：**前面必须是分隔符或行首**，避免误删「第2季」「Season2」里的数字
  s = s.replace(/(^|[\s_\-.[()\[\]【（])(?:0*\d{1,4})(?:v\d)?(?=[\s_\-.\])】\]]|$)/g, '$1 ');

  // 2d. 特殊集数 / 特典标记
  s = s
    .replace(/\bSP\s*0*\d{1,3}(?:v\d)?\b/gi, ' ')
    .replace(/(?:^|[\s_\-.])NCOP\d*(?=[\s_\-.]|$)/gi, ' ')
    .replace(/(?:^|[\s_\-.])NCED\d*(?=[\s_\-.]|$)/gi, ' ')
    .replace(/\b(?:OP|ED)\s*0*\d{1,3}\b/gi, ' ')
    .replace(/\b(?:OVA|OAD|NC)\s*0*\d{1,3}\b/gi, ' ');

  // 3. 去发布后缀词
  for (const w of JUNK_WORDS) {
    s = s.replace(new RegExp(`(^|[^a-z0-9])${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z0-9]|$)`, 'gi'), '$1 ');
  }

  // 4. 统一大小写
  s = s.toLowerCase();

  // 5. 全角 → 半角 + 中文标点转英文标点
  s = s.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[：，。、；！？（）【】《》“”‘’·－—―]/g, ' ');

  // 6. 去分隔符噪声
  s = s.replace(/[._\-\u30FB\uFF65\s/\\:|]+/g, ' ');

  // 7. 长音符还原
  for (const [k, v] of Object.entries(MACRON)) s = s.split(k).join(v);

  // 8. 日文假名 → 罗马音（简化处理：平假名/片假名保留但转小写；真正匹配依赖 Bangumi 搜索）
  //    此处仅做片假名 → 平假名以统一形态
  s = s.replace(/[\u30A1-\u30F6]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60));

  // 9. 繁 → 简
  s = toSimplified(s);

  // 10. 去装饰性符号
  s = s.replace(DECOR, '');

  return s.replace(/\s+/g, ' ').trim();
}

/** 生成用于比对的紧凑键（去空格） */
export function aliasKey(raw: string): string {
  return preprocess(raw).replace(/\s+/g, '');
}

/**
 * 「严格键」：与 aliasKey 不同，**只去掉空白与纯分隔符**，其余字符（`!` `?` `∬` `∽` `＊` `-` 数字……）全部保留。
 *
 * 为什么需要它：`はたらく細胞` 与 `はたらく細胞!!`（第 2 季）、
 * `五等分の花嫁` 与 `五等分の花嫁∬`（第 2 季）经 aliasKey 处理后完全相同，
 * 导致续作与第一季无法区分。严格键能把它们分开，用于「网页检索还原标题 → Bangumi 条目」的精确比对。
 *
 * ⚠ 不要在这里删标点：`∬` / `∽` / `2` / `II` 这类后缀恰恰是区分季数的关键信息。
 */
export function strictKey(raw: string): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[\s\u3000_・･·]+/g, '');
}

/* ============ 相似度算法 ============ */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[b.length];
}

export function levenshteinRatio(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - levenshtein(a, b) / max;
}

export function jaro(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatch = new Array<boolean>(a.length).fill(false);
  const bMatch = new Array<boolean>(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchDist);
    const hi = Math.min(i + matchDist + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true; bMatch[j] = true; matches++;
      break;
    }
  }
  if (!matches) return 0;

  let t = 0, k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  return (matches / a.length + matches / b.length + (matches - t) / matches) / 3;
}

export function jaroWinkler(a: string, b: string, p = 0.1): number {
  const j = jaro(a, b);
  if (j <= 0.7) return j;
  let l = 0;
  const max = Math.min(4, Math.min(a.length, b.length));
  while (l < max && a[l] === b[l]) l++;
  return j + l * p * (1 - j);
}

/** 分词：拉丁文按词切，CJK 按字符 bigram */
export function tokenize(s: string): string[] {
  const tokens: string[] = [];
  const latin = s.match(/[a-z0-9]+/gi) ?? [];
  tokens.push(...latin.map(x => x.toLowerCase()));
  const cjk = s.replace(/[a-z0-9\s]+/gi, '');
  for (let i = 0; i < cjk.length; i++) {
    tokens.push(cjk[i]);
    if (i + 1 < cjk.length) tokens.push(cjk.slice(i, i + 2));
  }
  return tokens;
}

/** Token Set Ratio（词序无关、容忍多余词） */
export function tokenSetRatio(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size && !sb.size) return 1;
  let inter = 0;
  sa.forEach(t => { if (sb.has(t)) inter++; });
  const precision = sa.size ? inter / sa.size : 0;
  const recall = sb.size ? inter / sb.size : 0;
  if (!precision && !recall) return 0;
  return (2 * precision * recall) / (precision + recall);
}

/** 包含关系判定 */
export function containsRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) {
    const short = Math.min(a.length, b.length);
    const long = Math.max(a.length, b.length);
    return 0.75 + 0.25 * (short / long);
  }
  return 0;
}

/**
 * 综合相似度（文档 4.3）：
 * score = 0.5×TokenSet + 0.3×JaroWinkler + 0.2×编辑距离归一
 * 再与包含关系取较大值（`Full Dive RPG` vs `Full Dive` 靠此项兜住）
 */
export function similarity(a: string, b: string): number {
  return similarityKeyed(aliasKey(a), aliasKey(b));
}

/**
 * 已归一化键之间的相似度（内部复用）。
 *
 * ⚠ 性能：`aliasKey` 内部是 10 步、二十多个正则的 `preprocess()`，单次约 **40µs**。
 * L3 模糊匹配要对「每一部番剧 × 别名表每一条」算一次相似度
 * （实测 743 × 2862 ≈ 210 万次），如果每次都现算 aliasKey 会白烧掉一分多钟。
 * 调用方若已持有 aliasKey 结果，就必须走这个入口，不要再传原始名。
 */
export function similarityKeyed(x: string, y: string): number {
  if (!x || !y) return 0;
  if (x === y) return 1;
  const base =
    0.5 * tokenSetRatio(x, y) +
    0.3 * jaroWinkler(x, y) +
    0.2 * levenshteinRatio(x, y);
  const cont = containsRatio(x, y) * 0.95;
  return Math.max(0, Math.min(1, Math.max(base, cont)));
}

/* ============ 其它小工具 ============ */

export function pad2(n: number | string | null | undefined): string {
  const v = String(n ?? '');
  if (!/^\d+$/.test(v)) return v;
  return v.padStart(2, '0');
}

export function sanitizeFileName(name: string): string {
  return String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
