/**
 * 文件名解析（《需求与设计文档》第 3 章）
 *
 * 典型结构：
 *   [字幕组] 番剧名 - 集数 [来源][片源][分辨率][编码 音频][语言][容器].扩展名
 */
import { MediaType, ParsedName, SubDir } from '../types';
import { splitExt } from '../fsx/fsx';

const RESOLUTIONS = /^(?:480p|576p|720p|1080p|1440p|2160p|4k|8k|1920x1080|1280x720)$/i;
const SOURCES = /^(?:web-?dl|web-?rip|bdrip|bd-?rip|bluray|blu-?ray|hdtv|dvdrip|tvrip|tv|remux|hdtvrip)$/i;
const CODECS = /^(?:hevc|h\.?264|h\.?265|avc|avc1|x264|x265|10bit|8bit|hi10p|vp9|av1)$/i;
const LANGS = /^(?:chs|cht|jpn|jp|gb|big5|sc|tc|tc&sc|简|繁|日|简繁|简日|繁日|双语|简繁日|简日双语|繁日双语|内封|外挂|简中|繁中|多语)$/i;
const CONTAINERS = /^(?:mkv|mp4|avi|wmv|flv|mov|ts|m2ts|ass|srt|rmvb|webm)$/i;
/** 明显是「补充说明」而不是番剧名的方括号块 */
const TAG_NOISE = /字幕|内封|外挂|双语|简繁|合集|招募|发布|压制|重发|修正|特典|menus?|fonts?|scans?|cds?|pv|cm|preview/i;

/** 无法作为番剧名的占位符 */
const PLACEHOLDER = /^(?:unknown|none|null|na|n\/a|未识别|未知|其他|other|misc|合集|new|temp|\d+)$/i;

/** 是否为「纯集数」块：01 / 01v2 / EP01 / 第01话 / SP01 / NCOP */
const EPISODE_BLOCK = /^(?:(?:ep?|第)?\s*0*\d{1,4}(?:v\d)?\s*(?:话|話|集)?|sp\s*0*\d{1,3}(?:v\d)?|ncop|nced|nc(?:\d+)?)$/i;

/** 是否为「纯季数」块：S2 / SEASON 2 / 2nd Season / 第二季 / Part 2 */
const SEASON_BLOCK = /^(?:s\s*0*\d{1,2}|season\s*0*\d{1,2}|\d{1,2}(?:st|nd|rd|th)\s*season|第\s*[一二三四五六七八九十\d]+\s*[季期部]|part\s*\d{1,2})$/i;

const MEDIA_TYPE_PATTERNS: Array<{ re: RegExp; type: MediaType }> = [
  // 注意：`NC-Raws` 这类字幕组名不能被当成 NC（无字幕 OP/ED），
  // 故要求 NC 后面不能紧跟 `-` 或单词字符
  { re: /(?:^|[\s_\-.\]])(?:ncop|nced|nc)\s*\d*\b(?![-\w])/i, type: 'NC' },
  { re: /(?:^|[\s_\-.\]])(?:op|ed)\s*\d*(?:[\s_\-.\[]|$)/i, type: 'OP' },
  { re: /(?:劇場版|剧场版|the\s*movie|movie|映画)/i, type: 'MOVIE' },
  { re: /\b(?:oad)\s*\d*\b/i, type: 'OAD' },
  { re: /\b(?:ova)\s*\d*\b/i, type: 'OVA' },
  { re: /\b(?:sp|special|特典|特別篇|特别篇|番外)\s*\d*\b/i, type: 'SP' },
];

function subDirOf(t: MediaType): SubDir {
  if (t === 'SP' || t === 'OVA' || t === 'OAD') return 'SP';
  if (t === 'OP' || t === 'ED' || t === 'NC') return 'OP&ED';
  return null;
}

/** 提取集数
 *
 * 策略（对应「已知坑」#7：正则贪婪导致番剧名截断）：
 *  1. 先匹配**明确**的集数写法（SP / NC / 第N话 / EP N），这类不会歧义；
 *  2. 否则收集所有「独立数字」候选，取**最靠右**的那个作为集数——
 *     因为集数总是出现在番剧名之后（如 `Mob Psycho 100 - 01` 应取 01 而不是 100）。
 */
function extractEpisode(work: string): { episode: string | null; rest: string } {
  const cut = (start: number, end: number, ep: string): { episode: string; rest: string } => ({
    episode: ep,
    rest: (work.slice(0, start) + ' ' + work.slice(end)).replace(/\s{2,}/g, ' ').trim()
  });

  // 1) 明确写法（不会歧义）
  const explicit: Array<{ re: RegExp; make: (m: RegExpMatchArray) => string }> = [
    { re: /[\s_\-.]SP\s*0*(\d{1,3})(?:v\d)?(?=[\s_\-.\]]|$)/i, make: m => `SP${m[1].padStart(2, '0')}` },
    { re: /[\s_\-.]NCOP(?=[\s_\-.\]]|$)/i, make: () => 'NC' },
    { re: /[\s_\-.]NCED(?=[\s_\-.\]]|$)/i, make: () => 'NC' },
    { re: /第\s*0*(\d{1,4})\s*[话話集]/i, make: m => m[1].padStart(2, '0') },
    { re: /[\s_\-.]EP?\s*0*(\d{1,4})(?:v(\d))?(?=[\s_\-.\]]|$)/i, make: m => m[1].padStart(2, '0') + (m[2] ? `v${m[2]}` : '') }
  ];
  for (const { re, make } of explicit) {
    const m = work.match(re);
    if (m) return cut(m.index!, m.index! + m[0].length, make(m));
  }

  // 2) 收集所有「独立数字」候选 → 取最靠右的一个（集数总在番剧名之后）
  const looseRe = /(?:^|[\s_\-.[\u3010])(0*\d{1,4})(?:v(\d))?(?=[\s_\-.\]\u3011]|$)/g;
  let mm: RegExpExecArray | null;
  let best: { start: number; end: number; ep: string } | null = null;
  while ((mm = looseRe.exec(work))) {
    const digitsAt = mm.index + mm[0].indexOf(mm[1]);
    const ep = mm[1].padStart(2, '0') + (mm[2] ? `v${mm[2]}` : '');
    best = {
      start: digitsAt,
      end: digitsAt + mm[1].length + (mm[2] ? 1 + mm[2].length : 0),
      ep
    };
    if (looseRe.lastIndex <= mm.index) looseRe.lastIndex = mm.index + 1;
  }
  if (best) return cut(best.start, best.end, best.ep);
  return { episode: null, rest: work };
}

/** 提取季数提示 */
function extractSeason(work: string): { seasonHint: string | null; rest: string } {
  const patterns: Array<{ re: RegExp; label: (m: RegExpMatchArray) => string }> = [
    { re: /\bS(\d{1,2})\b/i, label: m => `S${m[1].padStart(2, '0')}` },
    { re: /\b(\d{1,2})(?:st|nd|rd|th)\s*season\b/i, label: m => `S${m[1].padStart(2, '0')}` },
    { re: /第\s*([一二三四五六七八九十\d]+)\s*[季期部]/i, label: m => `第${m[1]}季` },
    { re: /\bseason\s*(\d{1,2})\b/i, label: m => `S${m[1].padStart(2, '0')}` },
    { re: /\bpart\s*(\d{1,2})\b/i, label: m => `Part${m[1]}` },
    { re: /\b(?:final\s*season)\b/i, label: () => 'Final Season' },
    { re: /(?:劇場版|剧场版)/, label: () => '劇場版' }
  ];
  for (const { re, label } of patterns) {
    const m = work.match(re);
    if (m) {
      const rest = (work.slice(0, m.index!) + ' ' + work.slice(m.index! + m[0].length)).trim();
      return { seasonHint: label(m), rest };
    }
  }
  return { seasonHint: null, rest: work };
}

/** 季数写法归一：S2 → S02 */
export function normalizeSeasonLabel(label: string | null): string | null {
  if (!label) return null;
  const m = label.match(/^S(\d{1,2})$/i);
  if (m) return `S${m[1].padStart(2, '0')}`;
  return label;
}

/** 从季数标签解析出序号（S02 / 第2季 / 2nd Season / Season 2 → 2；Part 2 → 2；无法解析 → null） */
export function seasonNumber(label: string | null): number | null {
  if (!label) return null;
  const s = label.trim();
  let m = s.match(/^S\s*0*(\d{1,2})$/i);
  if (m) return Number(m[1]);
  m = s.match(/^season\s*0*(\d{1,2})$/i);
  if (m) return Number(m[1]);
  m = s.match(/^0*(\d{1,2})(?:st|nd|rd|th)\s*season$/i);
  if (m) return Number(m[1]);
  m = s.match(/^part\s*0*(\d{1,2})$/i);
  if (m) return Number(m[1]);
  m = s.match(/^第\s*([一二三四五六七八九十\d]+)\s*[季期部]$/);
  if (m) {
    const cn = '一二三四五六七八九十';
    const idx = cn.indexOf(m[1]);
    if (idx >= 0) return idx + 1;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  }
  if (/剧场版|劇場版/.test(s)) return null;
  return null;
}

/** 该字符串是否可以作为番剧名使用 */
function isUsableTitle(s: string): boolean {
  const v = String(s ?? '').trim();
  if (v.length < 2) return false;
  if (PLACEHOLDER.test(v)) return false;
  if (/^[\s\-_.·・\d]+$/.test(v)) return false;
  if (!/[A-Za-z\u3040-\u30ff\u4e00-\u9fff]/.test(v)) return false;
  return true;
}

/** 该方括号块是否为「元数据块」（分辨率 / 片源 / 编码 / 语言 / 容器 / 说明性文字） */
function isMetadataBlock(block: string): boolean {
  const b = block.trim();
  if (!b) return true;
  if (RESOLUTIONS.test(b) || SOURCES.test(b) || CODECS.test(b) || LANGS.test(b) || CONTAINERS.test(b)) return true;
  if (TAG_NOISE.test(b)) return true;
  // 多段元数据：`Baha WEB-DL`、`AAC AVC`、`1080P Baha` 等
  const parts = b.split(/[\s+/&、,，]+/).filter(Boolean);
  if (parts.length && parts.every(p =>
    RESOLUTIONS.test(p) || SOURCES.test(p) || CODECS.test(p) || LANGS.test(p) || CONTAINERS.test(p)
  )) return true;
  return false;
}

/**
 * 顺序方括号命名：`[字幕组][番剧名][集数][分辨率][语言]`
 * 用于「番剧名本身也在方括号里」的情况（去掉所有方括号后主体为空）。
 */
function parseBracketSequential(
  blocks: string[]
): { animeRawName: string; episode: string | null; seasonHint: string | null } | null {
  if (blocks.length < 2) return null;

  let episode: string | null = null;
  let seasonHint: string | null = null;
  const titleCandidates: string[] = [];

  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i].trim();
    if (!b) continue;

    if (!episode && EPISODE_BLOCK.test(b)) {
      const sp = b.match(/^sp\s*0*(\d{1,3})(?:v\d)?$/i);
      if (sp) episode = `SP${sp[1].padStart(2, '0')}`;
      else if (/^nc(?:op|ed|)$/i.test(b)) episode = 'NC';
      else {
        const n = b.match(/0*(\d{1,4})(?:v(\d))?/);
        episode = n ? n[1].padStart(2, '0') + (n[2] ? `v${n[2]}` : '') : null;
      }
      continue;
    }

    if (!seasonHint && SEASON_BLOCK.test(b)) {
      seasonHint = normalizeSeasonLabel(b.replace(/\s+/g, ' '));
      continue;
    }

    if (isMetadataBlock(b)) continue;

    titleCandidates.push(b);
  }

  if (!titleCandidates.length) return null;

  // 取最长的候选作为番剧名（`[Baha]` 这类站点标签通常比真正标题短）
  const picked = titleCandidates.slice().sort((a, b) => b.length - a.length)[0];
  const { seasonHint: fromTitle, rest } = extractSeason(picked);

  return {
    animeRawName: rest.trim() || picked,
    episode,
    seasonHint: seasonHint ?? fromTitle
  };
}

/**
 * 解析单个文件/文件夹名。
 */
export function parseName(rawName: string, isDir = false): ParsedName {
  const { base } = isDir ? { base: rawName } : splitExt(rawName);
  const original = base;

  // 1. 字幕组：开头的 [xxx]
  let releaseGroup: string | null = null;
  const gm = base.match(/^\s*[\[【]\s*([^\]】]+?)\s*[\]】]/);
  if (gm && gm[1].length <= 40) {
    releaseGroup = gm[1].trim();
  }

  // 2. 收集方括号/圆括号内的标签 → 识别来源/分辨率/编码/语言
  const tags: string[] = [];
  const tagRe = /[\[【(（]\s*([^\]】)）]+?)\s*[\]】)）]/g;
  let tm: RegExpExecArray | null;
  while ((tm = tagRe.exec(base))) tags.push(tm[1].trim());

  let source: string | null = null;
  let resolution: string | null = null;
  let codec: string | null = null;
  let lang: string | null = null;

  tags.forEach(tag => {
    tag.split(/[\s+/&、,，]+/).forEach(tok => {
      if (!tok) return;
      if (RESOLUTIONS.test(tok)) { resolution = tok; return; }
      if (SOURCES.test(tok) && !source) { source = tok; return; }
      if (CODECS.test(tok)) { codec = codec ? `${codec} ${tok}` : tok; return; }
      if (LANGS.test(tok) && !lang) { lang = tok; }
    });
  });

  // 3. 去掉所有标签 → 得到主体
  //    下划线统一视作分隔符：`5Hanayome_S2` 若保留 `_`，
  //    `\bS(\d{1,2})\b` 会因为 `_` 属于「单词字符」而找不到词边界，导致季数识别失败
  let work = base.replace(tagRe, ' ').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

  // 4. 类型判定（在去标签后的主体上判断；也参考标签）
  //    首个方括号通常是字幕组（如 `NC-Raws` / `Lilith-Raws`），
  //    其中的 `NC` / `OP` 等字样会导致误判，故从探针中排除
  const probeTags = releaseGroup && tags[0] === releaseGroup ? tags.slice(1) : tags;
  const typeProbe = `${probeTags.join(' ')} ${work}`;
  let mediaType: MediaType = 'TV';
  for (const { re, type } of MEDIA_TYPE_PATTERNS) {
    if (re.test(typeProbe)) { mediaType = type; break; }
  }

  // 5. 集数 + 季数 + 番剧名
  //    风格 A：`[字幕组] 番剧名 - 01 [1080p]`  → 去标签后仍有主体文本
  //    风格 B：`[字幕组][番剧名][01][1080p]`   → 去标签后主体为空（番剧名本身在方括号里）
  const eA = extractEpisode(work);
  const sA = extractSeason(eA.rest);
  let episode = eA.episode;
  let seasonHint = sA.seasonHint;
  let animeRawName = sA.rest;

  if (!isUsableTitle(animeRawName) && tags.length >= 2) {
    const seq = parseBracketSequential(tags);
    if (seq && isUsableTitle(seq.animeRawName)) {
      animeRawName = seq.animeRawName;
      episode = seq.episode ?? episode;
      seasonHint = seq.seasonHint ?? seasonHint;
    }
  }

  // 6. 去掉断尾的分隔符 / 尾部噪声词
  animeRawName = animeRawName
    .replace(/[-–—_·・]+\s*$/, '')
    .replace(/^\s*[-–—_·・]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 7. 去掉残留的发布后缀词（无括号包裹的情况）
  animeRawName = animeRawName
    .replace(/\b(?:bdrip|bd|web-?dl|web-?rip|bluray|hevc|avc|x26[45]|aac|flac|1080p|720p|2160p|mkv|mp4)\b/gi, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 8. 季数写法归一（S2 → S02）
  seasonHint = normalizeSeasonLabel(seasonHint);

  // 9. 可用性判定
  let recognized = true;
  if (!animeRawName || animeRawName.length < 2) recognized = false;
  if (PLACEHOLDER.test(animeRawName)) recognized = false;
  if (/^[\s\-_.·・]*$/.test(animeRawName)) recognized = false;
  if (/^(?:\[|\()/.test(animeRawName)) recognized = false;

  // 解析置信度
  let parseConfidence = 0.5;
  if (recognized) parseConfidence = 0.85;
  if (recognized && releaseGroup) parseConfidence += 0.05;
  if (recognized && episode) parseConfidence += 0.08;
  if (recognized && resolution) parseConfidence += 0.02;
  if (!recognized) parseConfidence = 0.2;
  parseConfidence = Math.min(1, parseConfidence);

  return {
    rawName: original,
    animeRawName: recognized ? animeRawName : '',
    episode,
    mediaType,
    seasonHint,
    releaseGroup,
    source,
    resolution,
    codec,
    lang,
    parseConfidence: Number(parseConfidence.toFixed(2)),
    recognized,
    subDir: subDirOf(mediaType)
  };
}

/**
 * 媒体库文件排序：**按集数的数字顺序**，而不是按文件名字符串。
 *
 * 为什么：同一部番剧常混着多个字幕组（`[BeanSub&FZSD]…` / `[Nekomoe kissaten]…`），
 * 而 `readdir` 返回的是名字序 —— 两组各自排成一堆，于是 01 后面直接跟 14、02 要翻到另一段。
 *
 * 规则：
 *  ① 能解析出集数的在前，按数值排（`24` 在 `25` 前）；
 *  ② 同集数按后缀排（`24` 在 `24v2` 前）；
 *  ③ 都解析不出集数的（NCOP / 特典 / 未识别）放最后，按文件名自然序。
 *
 * 前端 `web/src/utils.ts` 的 `compareByEpisode` 是同一套规则（两边都改，别只改一边）。
 */
export function compareByEpisode(
  a: { episode?: string | null; name: string },
  b: { episode?: string | null; name: string }
): number {
  const key = (ep?: string | null): [number, string] | null => {
    const m = /^(\d+)(.*)$/.exec(String(ep ?? '').trim());
    return m ? [Number(m[1]), m[2].trim().toLowerCase()] : null;
  };
  const natural = (x: string, y: string): number =>
    x.localeCompare(y, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  const ea = key(a.episode);
  const eb = key(b.episode);
  if (ea && eb) {
    if (ea[0] !== eb[0]) return ea[0] - eb[0];
    if (ea[1] !== eb[1]) return ea[1] < eb[1] ? -1 : 1;
    return natural(a.name, b.name);
  }
  if (ea) return -1;
  if (eb) return 1;
  return natural(a.name, b.name);
}
