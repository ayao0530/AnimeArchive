/**
 * 全部数据结构定义 —— 严格对应《需求与设计文档》第 7 章。
 */

/* ================= 7.1 扫描项 ScanItem ================= */

export interface ScanItem {
  id: string;
  /** 绝对路径（原始形态，未加长路径前缀） */
  path: string;
  name: string;
  isDir: boolean;
  /** 文件夹为内部合计大小 */
  size: number;
  /** 文件夹内文件数量 */
  childCount: number;
  /** 修改时间 ISO 字符串（文件自身的时间，通常是该集的发布时间；参与置信度加权） */
  mtime: string;
  /** 创建时间 ISO 字符串（文件生成 / 拷入当前位置的时间；仅展示用） */
  btime: string;
}

/* ================= 7.2 解析结果 ParsedName ================= */

export type MediaType = 'TV' | 'SP' | 'OVA' | 'OAD' | 'OP' | 'ED' | 'NC' | 'MOVIE';

/** 归档子目录：SP / OP&ED，null 表示正片 */
export type SubDir = 'SP' | 'OP&ED' | null;

export interface ParsedName {
  rawName: string;
  /** 提取出的番剧名（可能是罗马音 / 日文 / 中文 / 英文） */
  animeRawName: string;
  /** 集数：'04' / 'SP01' / 'NC' / null */
  episode: string | null;
  mediaType: MediaType;
  seasonHint: string | null;
  releaseGroup: string | null;
  source: string | null;
  resolution: string | null;
  codec: string | null;
  lang: string | null;
  parseConfidence: number;
  /** 是否成功提取到可用的番剧名 */
  recognized: boolean;
  /** 目标子目录 */
  subDir: SubDir;
}

/* ================= 7.4 归一化结果 Resolution ================= */

export type MatchLevel = 'L1' | 'L2' | 'L3' | 'manual';
export type DataSource = 'local' | 'builtin' | 'bangumi' | 'web' | 'anilist' | 'manual' | 'fallback';

/** 文件修改时间与候选首播时间的吻合程度（用于展示与置信度加权） */
export type TimeRelation = 'same' | 'near' | 'stock' | 'old' | 'future' | 'unknown';

export interface Candidate {
  name: string;
  score: number;
  source: string;
  year?: number | null;
  month?: number | null;
  bangumiId?: number | null;
  /** Bangumi 返回的相关度排序（0 起）；仅用于展示 */
  rank?: number;
  /** 分数是否来自「排序先验」而非字符串相似度 */
  fromPrior?: boolean;
  /** 是否由「网页检索还原标题」精确命中 */
  webMatched?: boolean;
  /** 是否与查询词严格键完全一致（保留 `!` 数字 等后缀） */
  strictExact?: boolean;
  /** 是否「去标点后一致」（比严格键弱，可能是同系列多季） */
  looseMatch?: boolean;  /** 条目名 = 查询名 + 季数后缀（如 `五等分の花嫁∬` / `はたらく細胞!!`） */
  seasonSuffix?: boolean;  /** 与文件修改时间的吻合程度 */
  timeRelation?: TimeRelation;
}

export interface Resolution {
  /** 官方简体中文名（归档目录名） */
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
  /** 文件修改时间线索的可读说明（如「文件时间 2021-02，与首播 2021-01 吻合」） */
  timeNote?: string;
}

/* ================= 7.3 组 AnimeGroup ================= */

export type GroupStatus =
  | 'ready'
  | 'review'
  | 'conflict'
  | 'deferred'
  | 'unrecognized'
  | 'skipped'
  | 'done'
  | 'failed';

export interface GroupItem {
  scanItem: ScanItem;
  parsed: ParsedName;
  /** 冲突处理后可能的新文件名 */
  renameTo?: string | null;
  note?: string | null;
}

export interface AnimeGroup {
  groupId: string;
  rawNames: string[];
  /** 归一化后的官方中文名（未识别时为空） */
  zhName: string;
  /**
   * 原始名（+ 季数）的归一化键，用于界面「批量确认」时匹配同名组。
   * 例：`yurucamp|s02`
   */
  rawKey: string;
  /** 人工确认时需要写回别名表的原始名称（续作优先带季数，如 `Yuru Camp S02`） */
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
  /** 人工确认过 */
  resolved?: boolean;
  /** 人工确认时是否写回别名表 */
  saveAlias?: boolean;
}

/* ================= 7.6 方案条目 PlanEntry ================= */

export type EntryStatus =
  | 'ready'
  | 'review'
  | 'conflict'
  | 'deferred'
  | 'unrecognized'
  | 'skipped'
  | 'done'
  | 'failed';

export type EntryAction = 'move' | 'copy' | 'skip' | 'manual';
export type ConflictType = 'none' | 'sameName' | 'exists';

export interface PlanEntry {
  entryId: string;
  groupId: string;
  fromPath: string;
  /** 目标完整路径（含文件名；冲突重命名后为最终名称） */
  toPath: string;
  /** 原始名称 */
  name: string;
  /** 归档后名称（默认与 name 相同，冲突时可能为 xxx (1).mp4） */
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
  /** 归档前的番剧目录相对路径（如 2021\04\xxx） */
  relTargetDir: string;
}

/* ================= 7.5 归档方案 ArchivePlan ================= */

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

/* ================= 7.8 上次扫描快照（秒开，避免每次启动都重扫） ================= */

export interface ScanSnapshot {
  version: 1;
  /** 本次扫描完成时间 */
  savedAt: string;
  sourceRoot: string;
  targetRoot: string;
  /** 扫描统计 */
  scanInfo: {
    files: number;
    dirs: number;
    skippedNonVideo: number;
    excluded: number;
  };
  /** **未经前端「方案记忆」修饰**的原始分组 */
  groups: AnimeGroup[];
  /** 该快照之后发生过撤回（源目录又变回来了）→ 建议重新扫描 */
  stale?: boolean;
  /** 最近一次从本快照中归档成功的时间 */
  lastBatchAt?: string;
}

/* ================= 7.7 执行日志 OperationLog ================= */

export type OpType = 'move' | 'revert' | 'restore' | 'rename';

export interface OperationLog {
  logId: string;
  batchId: string;
  fromPath: string;
  toPath: string;
  result: 'success' | 'failed';
  error: string | null;
  timestamp: string;
  reversible: boolean;
  /** 归档前的原始完整路径（单文件撤回时使用） */
  originPath: string;
  opType: OpType;
  size?: number;
  isDir?: boolean;
  /** 实际尝试次数（1 = 一次成功；>1 = 自动重试过） */
  attempts?: number;
}

export interface BatchLog {
  batchId: string;
  createdAt: string;
  sourceRoot: string;
  targetRoot: string;
  entries: OperationLog[];
}

/* ================= 归档执行进度（断点续传） ================= */

/**
 * 归档执行的实时进度，落在 `data/execute-state.json`。
 *
 * 为什么要落盘：关掉浏览器 / 刷新页面时，**服务端其实还在继续搬文件**。
 * 把进度写下来，重新打开页面就能看到「上次归档已完成 N / 共 M」，
 * 直接点「继续归档」即可接着跑（已经搬完的条目会被自动跳过）。
 */
/**
 * 迁移失败项（已用尽自动重试）。
 *
 * 为什么要落盘：用户希望「失败的文件记下来，我后续再处理」。
 * 只写在日志里会淹掉，所以单独存一份，界面上可以一直标着。
 */
export interface FailedMove {
  fromPath: string;
  toPath: string;
  error: string;
  /** 实际尝试次数（含首次） */
  attempts: number;
  timestamp: string;
}

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
  /** 最近完成的一条（UI 显示「正在处理 xxx」） */
  lastItem: string | null;
  /** 是否是被中断的（既没 running、也没跑完） */
  interrupted?: boolean;
  /** 用户主动点了「停止归档」而提前收尾 */
  stopped?: boolean;
  /** 方案里的条目是否已全部处理完 */
  finished?: boolean;
  /** 迁移失败项（最多保留 200 条，完整记录见批次日志） */
  failedItems?: FailedMove[];
}

/* ================= 7.11 撤回记录 RevertLog ================= */

export interface RevertLog {
  revertId: string;
  batchId: string | null;
  filePath: string;
  targetPath: string;
  result: 'success' | 'failed';
  error: string | null;
  timestamp: string;
  note: string | null;
}

/* ================= 重命名记录 RenameLog ================= */

export interface RenameLog {
  renameId: string;
  fromPath: string;
  toPath: string;
  result: 'success' | 'failed';
  error: string | null;
  timestamp: string;
}

/* ================= 7.8 媒体库索引 LibraryIndex ================= */

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
  /** 子目录本身的完整路径（子目录可以整体撤回 / 移动，所以单独给一份） */
  fullPath: string;
  /** 移回归档前原位置的依据（无归档记录则为 null，界面会置灰撤回按钮） */
  originPath: string | null;
  revertable: boolean;
  /** 子目录内文件总大小 */
  totalSize: number;
}

export interface LibraryAnime {
  id: string;
  zhName: string;
  aliases: string[];
  year: number | null;
  month: number | null;
  bangumiId: number | null;
  cover: string;
  /** 相对于媒体库根目录的路径 */
  relPath: string;
  totalSize: number;
  fileCount: number;
  files: LibraryFile[];
  subDirs: LibrarySubDir[];
  /** 特殊目录（_未识别 / _待确认） */
  special: boolean;
}

export interface YearStat {
  year: number;
  animeCount: number;
  fileCount: number;
  totalSize: number;
}

/** 按「年 + 月」聚合的统计（图表「按月份」模式用；month = 0 表示只有年份、没有月份的兜底桶） */
export interface MonthStat {
  year: number;
  month: number;
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
  /** 按月份聚合（年降序 → 月降序）；旧索引没有这个字段时前端会现算 */
  months: MonthStat[];
}

export interface LibraryIndex {
  generatedAt: string;
  libraryRoot: string;
  years: Array<{ year: number; months: Array<{ month: number; animeIds: string[] }> }>;
  anime: LibraryAnime[];
  stats: LibraryStats;
}

/* ================= 别名表 ================= */

export interface AliasEntry {
  /** 官方中文名 */
  zh: string;
  /** 首播年 */
  year: number | null;
  /** 首播月 */
  month: number | null;
  /** 来源：builtin / bangumi / manual */
  src: 'builtin' | 'bangumi' | 'manual' | (string & {});
  bangumiId?: number | null;
  /** 其余别名（可省略，键本身就是别名） */
  aliases?: string[];
}

export interface AliasTable {
  version: number;
  updatedAt: string;
  /** 归一化后的键 → 条目 */
  entries: Record<string, AliasEntry>;
}

/* ================= 配置 ================= */

export interface AppConfig {
  port: number;
  nodePath: string;
  sourceRoot: string;
  targetRoot: string;
  /** 主题：system / dark / light */
  theme: 'system' | 'dark' | 'light';
  /** 置信度阈值 */
  reviewThreshold: number;
  autoThreshold: number;
  bangumiEnabled: boolean;
  /** 媒体库索引输出目录（网站目录） */
  siteDir: string;
  /** 前置网页检索（把罗马音/英文标题还原成日文原名后再查 Bangumi） */
  webSearchEnabled: boolean;
  /** 使用文件修改时间作为置信度参考（首播时间不会晚于下载时间） */
  useFileTime: boolean;
  /** Google Programmable Search：API Key（留空则只用免费的 AniList / Jikan） */
  googleApiKey: string;
  /** Google Programmable Search：搜索引擎 ID（cx） */
  googleCx: string;
  /** 扫描/归一化的并发度（NAS 上单次操作是一个网络往返，并发才是提速关键） */
  scanConcurrency: number;
  /**
   * 关闭网页时自动关闭本地服务（默认开）。
   * 有任务在运行时浏览器会先弹「确定要离开吗」二次确认；刷新页面不会误关（服务端有宽限期）。
   */
  shutdownOnPageClose: boolean;
}

/* ================= 通用 ================= */

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: string;
}

export type ApiResult<T> = ApiOk<T> | ApiErr;
