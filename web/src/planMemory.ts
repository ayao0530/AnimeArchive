/**
 * 归档方案记忆（localStorage）
 *
 * 目的：重新扫描后**自动恢复**你之前的人工确认结果，
 *       不必每次修完又从头点一遍。
 *
 * 记两类：
 *  1. groups  —— 按分组的 `rawKey`（原始名 + 季数）记住：中文名 / 首播年月 / 暂不处理 / 是否参与归档 / 冲突策略
 *  2. overrides —— 按**源文件绝对路径**记住：把某个文件/文件夹单独改归到另一部番剧
 *
 * 路径是最稳定的键：重新扫描、改名、换字幕组都不影响它。
 */
import type { AnimeGroup, GroupItem } from './types';

export interface ItemOverride {
  fromPath: string;
  zhName: string;
  year: number;
  month: number;
  /** 是否进入 SP / OP&ED 子目录（留空则按原解析结果） */
  subDir?: 'SP' | 'OP&ED' | null;
  updatedAt: string;
}

export interface GroupMemory {
  zhName?: string;
  year?: number | null;
  month?: number | null;
  /** 用户选择「暂不处理 → _待确认/」 */
  deferred?: boolean;
  /** 是否参与本次归档 */
  include?: boolean;
  /** 冲突处理策略 */
  conflictStrategy?: 'rename' | 'skip';
  updatedAt: string;
}

export interface PlanMemory {
  version: 1;
  groups: Record<string, GroupMemory>;
  overrides: Record<string, ItemOverride>;
}

const STORAGE_KEY = 'anime-archive:plan-memory:v1';
const SNAP_KEY = 'anime-archive:last-scan:v1';

type Store = Record<string, PlanMemory>;
type SnapStore = Record<string, LocalSnapshot>;

/**
 * 浏览器本地的「上次扫描结果」备份。
 *
 * 服务端 `server\data\last-scan.json` 是权威副本；这里再存一份是为了**打开就能看到东西**：
 * 万一服务端副本被删/路径判定不一致/读取失败，页面仍能立刻渲染上次的结果，
 * 而不是让用户再等一整轮扫描。
 */
export interface LocalSnapshot {
  savedAt: string;
  sourceRoot: string;
  targetRoot: string;
  scanInfo: { files: number; dirs: number; skippedNonVideo: number; excluded: number };
  groups: AnimeGroup[];
  lastBatchAt?: string;
  stale?: boolean;
}

export function loadLocalSnapshot(scope: string): LocalSnapshot | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as SnapStore;
    const s = all?.[scope];
    if (!s || !Array.isArray(s.groups)) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveLocalSnapshot(scope: string, snap: LocalSnapshot): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    const all: SnapStore = raw ? (JSON.parse(raw) as SnapStore) : {};
    all[scope] = snap;
    localStorage.setItem(SNAP_KEY, JSON.stringify(all));
  } catch {
    /* 容量超限（文件特别多时）静默忽略：服务端副本仍然可用 */
  }
}

export function clearLocalSnapshot(scope: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (!raw) return;
    const all = JSON.parse(raw) as SnapStore;
    delete all[scope];
    localStorage.setItem(SNAP_KEY, JSON.stringify(all));
  } catch {
    /* 忽略 */
  }
}

function emptyMemory(): PlanMemory {
  return { version: 1, groups: {}, overrides: {} };
}

function readAll(): Store {
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Store;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(all: Store): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* 容量超限等情况下静默忽略 */
  }
}

export function loadMemory(scope: string): PlanMemory {
  const all = readAll();
  const m = all[scope];
  if (!m || m.version !== 1) return emptyMemory();
  return {
    version: 1,
    groups: m.groups ?? {},
    overrides: m.overrides ?? {}
  };
}

export function saveMemory(scope: string, memory: PlanMemory): void {
  const all = readAll();
  all[scope] = memory;
  writeAll(all);
}

export function clearMemory(scope: string): void {
  const all = readAll();
  delete all[scope];
  writeAll(all);
}

/* =========================================================
   应用到扫描结果
   ========================================================= */

export interface AppliedMemory {
  groups: AnimeGroup[];
  /** groupId → 是否参与归档 */
  include: Record<string, boolean>;
  /** 本次实际命中记忆的分组数 / 条目数 */
  restoredGroups: number;
  restoredItems: number;
  /** 被单独调整过的条目路径 */
  overriddenPaths: Set<string>;
}

/**
 * 把记忆套用到刚扫描出的分组上：
 *  ① 组级记忆（中文名 / 年月 / 暂不处理 / 冲突策略）
 *  ② 条目级覆盖：把指定文件从原组**拆出来**，单独成为一个分组
 */
export function applyMemory(groups: AnimeGroup[], memory: PlanMemory): AppliedMemory {
  let restoredGroups = 0;
  const include: Record<string, boolean> = {};
  const overriddenPaths = new Set<string>();

  /* ---------- ① 组级记忆 ---------- */
  const withGroupMemory: AnimeGroup[] = groups.map(g => {
    const m = memory.groups[g.rawKey];
    if (!m) return g;
    const hasName = Boolean(m.zhName);
    const next: AnimeGroup = { ...g };

    if (hasName) {
      next.zhName = m.zhName as string;
      next.year = m.year ?? null;
      next.month = m.month ?? null;
      next.resolved = !m.deferred;
      next.saveAlias = false;
      next.note = m.deferred
        ? '已选择「暂不处理」，将移入 _待确认/（来自方案记忆）'
        : '已从方案记忆恢复该确认结果';
      next.resolution = {
        officialZhName: m.zhName as string,
        alternateNames: g.resolution?.alternateNames?.length ? g.resolution.alternateNames : g.rawNames,
        year: m.year ?? null,
        month: m.month ?? null,
        matchLevel: 'manual',
        dataSource: 'manual',
        confidence: 1,
        candidates: g.resolution?.candidates ?? [],
        needReview: false,
        bangumiId: g.resolution?.bangumiId ?? null
      };
      next.status = m.deferred ? 'deferred' : 'ready';
      restoredGroups++;
    } else if (m.deferred) {
      next.status = 'deferred';
      next.note = '已选择「暂不处理」，将移入 _待确认/（来自方案记忆）';
      restoredGroups++;
    }

    // 冲突策略
    if (m.conflictStrategy) {
      if (m.conflictStrategy === 'skip') {
        next.status = 'skipped';
        next.note = '已选择「跳过」：源文件保留，不归档（来自方案记忆）';
      } else if (next.status === 'conflict' || g.status === 'conflict') {
        next.status = 'ready';
        next.note = '已选择「自动重命名 (1)」（来自方案记忆）';
        next.items = next.items.map(it => ({
          ...it,
          renameTo: it.renameTo || it.scanItem.name.replace(/(\.[^.]+)$/, ' (1)$1')
        }));
      }
      restoredGroups++;
    }

    if (m.include !== undefined) include[g.groupId] = m.include;
    return next;
  });

  /* ---------- ② 条目级覆盖：拆组 ---------- */
  const out: AnimeGroup[] = [];
  let seq = 0;
  let restoredItems = 0;

  withGroupMemory.forEach(g => {
    // 已经是「单独调整」产物、或没有覆盖记录 → 原样保留（避免重复拆组）
    const alreadySplit = g.rawKey.startsWith('__manual_item__');
    const stay: GroupItem[] = [];
    const moved = new Map<string, { items: GroupItem[]; ov: ItemOverride }>();

    if (!alreadySplit) {
      g.items.forEach(it => {
        const ov = memory.overrides[it.scanItem.path];
        if (!ov) { stay.push(it); return; }
        overriddenPaths.add(it.scanItem.path);
        const key = `${ov.zhName}|${ov.year}|${ov.month}|${ov.subDir ?? ''}`;
        if (!moved.has(key)) moved.set(key, { items: [], ov });
        moved.get(key)!.items.push(it);
      });
    } else {
      stay.push(...g.items);
    }

    if (!moved.size) { out.push(g); return; }

    // 原组保留未被覆盖的条目
    if (stay.length) {
      out.push({
        ...g,
        items: stay,
        totalSize: stay.reduce((a, it) => a + it.scanItem.size, 0),
        episodes: stay.map(it => it.parsed.episode).filter((e): e is string => Boolean(e))
      });
    }

    moved.forEach(({ items, ov }, idx) => {
      restoredItems += items.length;
      out.push({
        ...g,
        groupId: `${g.groupId}~m${++seq}`,
        rawKey: `__manual_item__|${ov.zhName.toLowerCase()}|${ov.year}|${ov.month}|${idx}`,
        rawNames: items.map(it => it.parsed.animeRawName || it.scanItem.name),
        zhName: ov.zhName,
        year: ov.year,
        month: ov.month,
        items: items.map(it => (ov.subDir !== undefined ? { ...it, parsed: { ...it.parsed, subDir: ov.subDir ?? null } } : it)),
        totalSize: items.reduce((a, it) => a + it.scanItem.size, 0),
        episodes: items.map(it => it.parsed.episode).filter((e): e is string => Boolean(e)),
        status: 'ready',
        resolved: true,
        saveAlias: false,
        aliasQuery: [],
        note: `↗ 已单独调整到「${ov.zhName}」，原属于「${g.zhName || g.rawNames.join('/') || '未识别'}」`,
        resolution: {
          officialZhName: ov.zhName,
          alternateNames: [],
          year: ov.year,
          month: ov.month,
          matchLevel: 'manual',
          dataSource: 'manual',
          confidence: 1,
          candidates: [],
          needReview: false,
          bangumiId: null
        }
      });
    });
  });

  return { groups: out, include, restoredGroups, restoredItems, overriddenPaths };
}
