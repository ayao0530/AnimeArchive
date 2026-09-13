/**
 * 前端类型定义 —— 与 server/src/types.ts 保持一致
 */

export type MediaType = 'TV' | 'SP' | 'OVA' | 'OAD' | 'OP' | 'ED' | 'NC' | 'MOVIE';
export type SubDir = 'SP' | 'OP&ED' | null;
export type MatchLevel = 'L1' | 'L2' | 'L3' | 'manual';
export type DataSource = 'local' | 'builtin' | 'bangumi' | 'web' | 'anilist' | 'manual' | 'fallback';
/** 文件修改时间与候选首播时间的吻合程度 */
export type TimeRelation = 'same' | 'near' | 'stock' | 'old' | 'future' | 'unknown';
export type GroupStatus =
  | 'ready' | 'review' | 'conflict' | 'deferred' | 'unrecognized' | 'skipped' | 'done' | 'failed';
export type EntryStatus = GroupStatus;
export type ConflictType = 'none' | 'sameName' | 'exists';
export type EntryAction = 'move' | 'copy' | 'skip' | 'manual';

export interface ScanItem {
  id: string;
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  childCount: number;
  /** 修改时间（文件自身的时间，通常是该集发布时间） */
  mtime: string;
  /** 创建时间（文件生成 / 拷入当前位置的时间）。旧快照里可能没有 */
  btime?: string;
}

export interface ParsedName {
  rawName: string;
  animeRawName: string;
  episode: string | null;
  mediaType: MediaType;
  seasonHint: string | null;
  releaseGroup: string | null;
  source: string | null;
  resolution: string | null;
  codec: string | null;
  lang: string | null;
  parseConfidence: number;
  recognized: boolean;
  subDir: SubDir;
}

export interface Candidate {
  name: string;
  score: number;
  source: string;
  year?: number | null;
  month?: number | null;
  bangumiId?: number | null;
  /** Bangumi 返回的相关度排序（0 起） */
  rank?: number;
  /** 分数来自「排序先验」而非字符串相似度 */
  fromPrior?: boolean;
  /** 由「网页检索还原标题」精确命中 */
  webMatched?: boolean;
  /** 与查询词严格键完全一致（保留 `!` 数字 等后缀） */
  strictExact?: boolean;
  /** 「去标点后一致」（比严格键弱，可能是同系列多季） */
  looseMatch?: boolean;
  /** 条目名 = 查询名 + 季数后缀（如 `五等分の花嫁∬` / `はたらく細胞!!`） */
  seasonSuffix?: boolean;
  /** 与文件修改时间的吻合程度 */
  timeRelation?: TimeRelation;
}

export interface Resolution {
  officialZhName: string;
  alternateNames: string[];
  year: number | null;
  month: number | null;
  matchLevel: MatchLevel;
  dataSource: DataSource;
  confidence: number;
  candidates: Candidate[];
  needReview: boolean;
  bangumiId?: number | null;
  /** 命中方式的可读说明（如「网页检索还原名 → Bangumi 精确命中」） */
  note?: string;
  /** 文件修改时间线索的可读说明 */
  timeNote?: string;
}

export interface GroupItem {
  scanItem: ScanItem;
  parsed: ParsedName;
  renameTo?: string | null;
  note?: string | null;
}

export interface AnimeGroup {
  groupId: string;
  rawNames: string[];
  zhName: string;
  /** 原始名（+季数）归一化键，用于「批量确认」时匹配同名组 */
  rawKey: string;
  /** 人工确认时写回别名表的原始名称（续作优先带季数） */
  aliasQuery: string[];
  year: number | null;
  month: number | null;
  items: GroupItem[];
  episodes: string[];
  totalSize: number;
  releaseGroup: string | null;
  resolution: Resolution | null;
  status: GroupStatus;
  note: string | null;
  resolved?: boolean;
  saveAlias?: boolean;
}

export interface PlanEntry {
  entryId: string;
  groupId: string;
  fromPath: string;
  toPath: string;
  name: string;
  targetName: string;
  isDir: boolean;
  size: number;
  action: EntryAction;
  status: EntryStatus;
  conflictType: ConflictType;
  note: string | null;
  subDir: SubDir;
  episode: string | null;
  mediaType: MediaType;
  relTargetDir: string;
}

export interface PlanStats {
  total: number;
  totalSize: number;
  ready: number;
  review: number;
  conflict: number;
  unrecognized: number;
  deferred: number;
  skipped: number;
}

export interface ArchivePlan {
  planId: string;
  createdAt: string;
  sourceRoot: string;
  targetRoot: string;
  groups: AnimeGroup[];
  entries: PlanEntry[];
  stats: PlanStats;
}

/** 上次扫描快照（服务端 last-scan.json）—— 打开页面时直接载入，避免每次重扫 */
export interface ScanSnapshot {
  version: 1;
  savedAt: string;
  sourceRoot: string;
  targetRoot: string;
  scanInfo: {
    files: number;
    dirs: number;
    skippedNonVideo: number;
    excluded: number;
  };
  /** 未经「方案记忆」修饰的原始分组 */
  groups: AnimeGroup[];
  /** 该快照之后发生过撤回 → 建议重新扫描 */
  stale?: boolean;
  /** 最近一次从本快照中归档成功的时间 */
  lastBatchAt?: string;
  /** 是否与当前 config 的源/归档根目录一致（由服务端计算） */
  matchesConfig?: boolean;
}

/**
 * 归档执行进度（服务端 `data/execute-state.json`）。
 *
 * 关掉/刷新页面时服务端其实还在继续搬文件，靠这份状态才能在重新打开后
 * 显示「已完成 N / 共 M」并提供「继续归档」（已搬完的条目会被自动跳过）。
 */
export interface ExecuteState {
  batchId: string;
  startedAt: string;
  updatedAt: string;
  /** 服务端是否还在执行 */
  running: boolean;
  total: number;
  done: number;
  failed: number;
  skipped: number;
  sourceRoot: string;
  targetRoot: string;
  lastItem: string | null;
  /** 被中断（既没在跑、也没跑完） */
  interrupted?: boolean;
  /** 用户主动点了「停止归档」而提前收尾 */
  stopped?: boolean;
  /** 方案里的条目是否已全部处理完 */
  finished?: boolean;
  /** 迁移失败项（已用尽自动重试），需要在界面上标明供后续人工处理 */
  failedItems?: FailedMove[];
}

/** 迁移失败项（自动重试 3 次仍失败） */
export interface FailedMove {
  fromPath: string;
  toPath: string;
  error: string;
  /** 实际尝试次数（含首次） */
  attempts: number;
  timestamp: string;
}

export interface LibraryFile {
  uid: string;
  name: string;
  fullPath: string;
  size: number;
  type: 'video' | 'other';
  episode: string | null;
  originPath: string | null;
  revertable: boolean;
  mtime: string;
}

export interface LibrarySubDir {
  dir: string;
  files: LibraryFile[];
  /** 子目录本身的完整路径（旧索引可能没有，界面要兜底） */
  fullPath?: string;
  /** 归档前原位置（无归档记录则为 null） */
  originPath?: string | null;
  /** 能否整体撤回（旧索引可能没有） */
  revertable?: boolean;
  totalSize?: number;
}

export interface LibraryAnime {
  id: string;
  zhName: string;
  aliases: string[];
  year: number | null;
  month: number | null;
  bangumiId: number | null;
  cover: string;
  relPath: string;
  totalSize: number;
  fileCount: number;
  files: LibraryFile[];
  subDirs: LibrarySubDir[];
  special: boolean;
}

export interface YearStat {
  year: number;
  animeCount: number;
  fileCount: number;
  totalSize: number;
}

export interface LibraryStats {
  animeCount: number;
  fileCount: number;
  totalSize: number;
  revertableCount: number;
  specialCount: number;
  years: YearStat[];
}

export interface LibraryIndex {
  generatedAt: string;
  libraryRoot: string;
  years: Array<{ year: number; months: Array<{ month: number; animeIds: string[] }> }>;
  anime: LibraryAnime[];
  stats: LibraryStats;
}

export interface AppConfig {
  port: number;
  nodePath: string;
  sourceRoot: string;
  targetRoot: string;
  theme: 'system' | 'dark' | 'light';
  reviewThreshold: number;
  autoThreshold: number;
  bangumiEnabled: boolean;
  siteDir: string;
  /** 前置网页检索（罗马音/英文 → 还原日文原名后回查 Bangumi） */
  webSearchEnabled: boolean;
  /** 使用文件修改时间作为置信度参考 */
  useFileTime: boolean;
  /** Google Programmable Search：API Key（可选，留空则用免费的 AniList / Jikan） */
  googleApiKey: string;
  /** Google Programmable Search：搜索引擎 ID（cx） */
  googleCx: string;
  /** 扫描/索引的并发度（NAS 建议 8~16，本地磁盘 4~8） */
  scanConcurrency: number;
}

export interface EntryDecision {
  execute: boolean;
  strategy?: 'rename' | 'skip';
  targetName?: string;
}

export interface ApiOk<T> { ok: true; data: T }
export interface ApiErr { ok: false; error: string }
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** SSE 事件（扫描 / 执行） */
export type StreamEvent =
  | { type: 'phase'; phase: string; message: string }
  | { type: 'target'; targetRoot: string; exists: boolean; writable: boolean }
  | { type: 'progress'; phase: string; scanned?: number; total?: number; current?: string }
  | { type: 'scanDone'; files: number; dirs: number; skippedNonVideo: number; excluded: number; items: number }
  | { type: 'plan'; plan: ArchivePlan }
  | { type: 'log'; message: string }
  | { type: 'start'; batchId: string; total: number }
  | { type: 'entry'; entryId: string; index: number; total: number; status: 'done' | 'failed' | 'skipped'; fromPath: string; toPath: string; error?: string | null; note?: string | null; attempts?: number }
  | { type: 'indexDone'; generatedAt: string; stats: LibraryStats }
  | { type: 'done'; batchId?: string; success?: number; failed?: number; skipped?: number; stopped?: boolean }
  | { type: 'error'; message: string };
