/**
 * 本地持久化：config.json / aliases.json / logs\*.json / library.json
 */
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import {
  AliasEntry,
  AliasTable,
  AppConfig,
  BatchLog,
  ExecuteState,
  LibraryIndex,
  OperationLog,
  RenameLog,
  RevertLog,
  ScanSnapshot
} from '../types';
import { aliasKey, similarityKeyed } from '../util/text';
import { BUILTIN_ALIASES } from './builtin-aliases';
import { ensureDir } from '../fsx/fsx';

export class Store {
  readonly root: string;
  readonly dataDir: string;
  readonly logsDir: string;
  readonly configPath: string;
  readonly aliasesPath: string;
  readonly memoryPath: string;
  readonly snapshotPath: string;
  readonly executeStatePath: string;

  private config: AppConfig;
  private aliases: AliasTable;
  private aliasIndex = new Map<string, AliasEntry>();
  /**
   * 预计算好的「别名 → 归一化键」列表（L3 模糊匹配用）。
   *
   * 为什么必须预计算：`aliasKey()` 是 20 多个正则的预处理，单次约 40µs；
   * 而 L3 要对「每一部番剧 × 每一条别名」算相似度（实测 743 × 2862 ≈ 210 万次），
   * 现场算要烧掉一分多钟。这里只在别名表变化时重算一次。
   *
   * `key2` = `aliasKey(aliasKey(alias))`，即 `similarity()` 内部实际用的那个键，
   * 预存下来可以保证与旧逻辑**完全等价**。
   */
  private aliasItems = new Map<string, AliasItem>();
  /**
   * 官方名（`zh`）→ 预计算键。供「更具体者胜」复核使用。
   *
   * 为什么另建一张表：别名表有 3600+ 条**键**，但官方名只有 700~800 个
   * （一条番剧有多个别名键、却只有一个官方名）。复核要遍历「所有可能更具体的名字」，
   * 按官方名去重能把循环次数从 3600 降到 800；键也预先算好，
   * 不再每条现场跑 `aliasKey`（那是 10 步、二十多个正则的 `preprocess()`，约 40µs）。
   */
  private zhIndex = new Map<string, ZhItem>();
  /** Bangumi / 网页检索缓存：常驻内存，变更后合并写盘（不再每次读改写整个文件） */
  private cache: Record<string, unknown> | null = null;
  private cacheLoading: Promise<Record<string, unknown>> | null = null;
  private aliasDirty = false;
  private cacheDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: string) {
    this.root = root;
    this.dataDir = path.join(root, 'data');
    this.logsDir = path.join(this.dataDir, 'logs');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.aliasesPath = path.join(this.dataDir, 'aliases.json');
    this.memoryPath = path.join(this.dataDir, 'bangumi-cache.json');
    this.snapshotPath = path.join(this.dataDir, 'last-scan.json');
    this.executeStatePath = path.join(this.dataDir, 'execute-state.json');
    this.config = defaultConfig(root);
    this.aliases = { version: 1, updatedAt: new Date().toISOString(), entries: {} };
  }

  /* ---------------- 初始化 ---------------- */

  async init(): Promise<void> {
    await ensureDir(this.dataDir);
    await ensureDir(this.logsDir);
    await this.loadConfig();
    await this.loadAliases();
  }

  /* ---------------- 配置 ---------------- */

  getConfig(): AppConfig {
    return { ...this.config };
  }

  async saveConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
    this.config = { ...this.config, ...patch };
    await writeJson(this.configPath, this.config);
    return this.getConfig();
  }

  private async loadConfig(): Promise<void> {
    try {
      const raw = await fsp.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(stripBom(raw)) as Partial<AppConfig>;
      this.config = { ...defaultConfig(this.root), ...parsed };
    } catch {
      this.config = defaultConfig(this.root);
      await writeJson(this.configPath, this.config);
    }
  }

  /* ---------------- 别名表 ---------------- */

  getAliasesRaw(): AliasTable {
    return this.aliases;
  }

  /** L1：按别名精确命中（先查内存索引） */
  lookup(rawName: string): AliasEntry | null {
    if (!rawName) return null;
    const direct = this.aliasIndex.get(rawName.trim().toLowerCase());
    if (direct) return direct;
    const key = aliasKey(rawName);
    if (!key) return null;
    return this.aliasIndex.get(key) ?? null;
  }

  /** 列出全部别名（用于 L3 模糊匹配；已预计算归一化键） */
  listAliases(): AliasItem[] {
    return Array.from(this.aliasItems.values());
  }

  /** 「更具体者胜」复核的候选集（按官方名去重；直接遍历 Map，不复制数组） */
  getZhIndex(): ReadonlyMap<string, ZhItem> {
    return this.zhIndex;
  }

  /** 写入一条别名（多个别名指向同一条目） */
  async upsertAlias(
    aliases: string[],
    zh: string,
    year: number | null,
    month: number | null,
    src: AliasEntry['src'],
    bangumiId?: number | null
  ): Promise<void> {
    if (!zh) return;
    const now = new Date().toISOString();
    const zhKey = aliasKey(zh);
    /*
     * 护栏：**不要把「更具体的名字」收成「更宽泛名字」的别名**。
     *
     * 踩过的坑：确认第一季时，整组的 rawName（含第四季的「領主的養女」）被一起写成了别名，
     * 于是第四季文件被原始键命中第一季条目（src=manual、置信度 1.0），整季归到第一季文件夹，
     * 而且后面的 L2 / L3 **完全没机会纠正**（实测就是这么错的）。
     *
     * 判据：归一化键**更长**、且与当前名字的键相似度 ≥ 0.8
     * ⇒ 那多半是「同一个名字多挂了个后缀」的另一季，不该当成本条目的别名。
     *
     * 为什么不用「字面包含」：繁简与装饰符会让包含关系失效 ——
     * `…不擇手段！領主的養女` 与 `…〜而不择手段〜` 差着 `〜` 和 `而`，
     * 键里根本不含对方，护栏会漏（实测漏过）。相似度则照旧能识别为同一串。
     */
    const usable = aliases.filter(a => {
      const k = aliasKey(a);
      if (!k) return false;
      if (!zhKey || k.length <= zhKey.length) return true;
      return similarityKeyed(k, zhKey) < 0.8;
    });
    const keys = new Set<string>();
    usable.forEach(a => {
      const k = aliasKey(a);
      if (k) keys.add(k);
      if (a && a.length <= 80) keys.add(a.trim().toLowerCase());
    });
    if (zhKey) keys.add(zhKey);
    keys.add(zh.trim().toLowerCase());

    const touched: string[] = [];
    for (const k of keys) {
      const prev = this.aliases.entries[k];
      if (prev && prev.src === 'manual' && src !== 'manual') continue; // 人工确认优先
      this.aliases.entries[k] = {
        zh,
        year: year ?? prev?.year ?? null,
        month: month ?? prev?.month ?? null,
        src,
        bangumiId: bangumiId ?? prev?.bangumiId ?? null,
        aliases: Array.from(new Set([...(prev?.aliases ?? []), ...usable])).slice(0, 12)
      };
      touched.push(k);
    }
    this.aliases.updatedAt = now;

    // 只增量更新被改动的键（全量重建索引 + 预计算键会很慢，而扫描期间会调用几百次）
    const touchedZh = new Map<string, AliasEntry>();
    for (const k of touched) {
      const entry = this.aliases.entries[k];
      this.aliasIndex.set(k, entry);
      this.aliasIndex.set(k.replace(/\s+/g, ''), entry);
      this.aliasItems.set(k, makeAliasItem(k, entry));
      touchedZh.set(entry.zh, entry);
    }
    touchedZh.forEach((entry, zh) => this.zhIndex.set(zh, makeZhItem(zh, entry)));
    this.markDirty(true, false);
  }

  private async loadAliases(): Promise<void> {
    let table: AliasTable | null = null;
    try {
      const raw = await fsp.readFile(this.aliasesPath, 'utf8');
      const parsed = JSON.parse(stripBom(raw)) as AliasTable;
      if (parsed && parsed.entries) table = parsed;
    } catch { /* 首次运行 */ }

    if (!table) {
      table = { version: 1, updatedAt: new Date().toISOString(), entries: {} };
      BUILTIN_ALIASES.forEach(b => {
        const keys = new Set<string>([...b.aliases.map(aliasKey), aliasKey(b.zh)]);
        keys.forEach(k => {
          if (!k) return;
          table!.entries[k] = {
            zh: b.zh,
            year: b.year,
            month: b.month,
            src: 'builtin',
            bangumiId: b.bangumiId ?? null,
            aliases: b.aliases
          };
        });
      });
      this.aliases = table;
      await writeJson(this.aliasesPath, this.aliases);
    } else {
      // 合并新增的内置条目（不覆盖已有的人工条目）
      let changed = false;
      BUILTIN_ALIASES.forEach(b => {
        const k = aliasKey(b.zh);
        if (k && !table!.entries[k]) {
          const keys = new Set<string>([...b.aliases.map(aliasKey), k]);
          keys.forEach(kk => {
            if (!kk || table!.entries[kk]) return;
            table!.entries[kk] = {
              zh: b.zh,
              year: b.year,
              month: b.month,
              src: 'builtin',
              bangumiId: b.bangumiId ?? null,
              aliases: b.aliases
            };
          });
          changed = true;
        }
      });
      this.aliases = table;
      if (changed) await writeJson(this.aliasesPath, this.aliases);
    }
    this.rebuildIndex();
  }

  private rebuildIndex(): void {
    this.aliasIndex.clear();
    this.aliasItems.clear();
    this.zhIndex.clear();
    for (const [k, v] of Object.entries(this.aliases.entries)) {
      this.aliasIndex.set(k, v);
      this.aliasIndex.set(k.replace(/\s+/g, ''), v);
      this.aliasItems.set(k, makeAliasItem(k, v));
      // 按官方名去重：同名只算一次键（700~800 次 aliasKey，而不是 3600 次）
      if (!this.zhIndex.has(v.zh)) this.zhIndex.set(v.zh, makeZhItem(v.zh, v));
    }
  }

  /* ---------------- Bangumi 查询缓存 ---------------- */

  /**
   * 读缓存。
   *
   * 首次调用时把整个文件读进内存（`bangumi-cache.json` 现在有 2MB 多），
   * 之后都走内存 —— 以前每次 `getCached/setCached` 都「读整个文件 + parse（+ 写回）」，
   * 一次扫描要重复上千次，只是解析 JSON 就要十几秒。
   */
  private async readCache(): Promise<Record<string, unknown>> {
    if (this.cache) return this.cache;
    if (!this.cacheLoading) {
      this.cacheLoading = (async (): Promise<Record<string, unknown>> => {
        try {
          const raw = await fsp.readFile(this.memoryPath, 'utf8');
          this.cache = JSON.parse(stripBom(raw)) as Record<string, unknown>;
        } catch {
          this.cache = {};
        }
        return this.cache;
      })();
    }
    return this.cacheLoading;
  }

  async getCached<T>(key: string): Promise<T | null> {
    const cache = await this.readCache();
    return (cache[key] as T) ?? null;
  }

  /**
   * 标记需要落盘，并合并成一次延迟写入。
   *
   * 归一化对**每一部**番剧都会读/写这两个文件（别名表 1MB+ / 查询缓存 2MB+），
   * 而两者都是「整文件读—改—写」。逐个写会让一次扫描产生上千次 MB 级 I/O，
   * 直接拖慢整个扫描；合并成一次即可，中途崩溃最多丢几百毫秒的结果（下次重新联网而已）。
   */
  private markDirty(alias?: boolean, cache?: boolean): void {
    if (alias) this.aliasDirty = true;
    if (cache) this.cacheDirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { void this.flush(); }, FLUSH_DELAY_MS);
    // 服务常驻，不要因为这个定时器把进程吊住
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /** 立即把内存中的别名表与查询缓存落盘（扫描 / 批量操作结束后调用一次） */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.aliasDirty) {
      this.aliasDirty = false;
      await writeJson(this.aliasesPath, this.aliases);
    }
    if (this.cacheDirty) {
      this.cacheDirty = false;
      await writeJson(this.memoryPath, this.cache ?? {});
    }
  }

  /**
   * 写缓存（只改内存，落盘交给 `markDirty` 合并写入）。
   *
   * 归一化是**并发**跑的；单线程下对同一个内存对象的改写在事件循环层面是原子的，
   * 不再需要「读文件 → 改键 → 写回」的串行链，也就不会互相覆盖。
   */
  async setCached(key: string, value: unknown): Promise<void> {
    const cache = await this.readCache();
    cache[key] = value;
    this.markDirty(false, true);
  }

  /* ---------------- 上次扫描快照 ----------------
   *  目的：下次打开页面时直接载入上次的扫描结果，不必每次重新扫描。
   *  仅在「点击扫描并成功生成方案」时写入；执行归档 / 撤回后失效（源目录已变化）。
   */

  async saveScanSnapshot(snapshot: ScanSnapshot): Promise<void> {
    await writeJson(this.snapshotPath, snapshot);
  }

  async readScanSnapshot(): Promise<ScanSnapshot | null> {
    try {
      const raw = await fsp.readFile(this.snapshotPath, 'utf8');
      const parsed = JSON.parse(stripBom(raw)) as ScanSnapshot;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.groups)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async clearScanSnapshot(): Promise<void> {
    await fsp.rm(this.snapshotPath, { force: true });
  }

  /**
   * 归档执行完成后**裁剪**快照：把已移动成功的条目从列表里去掉，保留剩下的。
   *
   * 为什么不直接删除快照：多数情况下一次只归档了一部分（还有待确认 / 未识别的项目），
   * 下次打开理应直接看到「剩下的待处理项」，而不是被迫重新扫描一遍整个 NAS。
   */
  async pruneScanSnapshot(movedPaths: string[]): Promise<void> {
    const snap = await this.readScanSnapshot();
    if (!snap) return;
    const key = (s: string): string => String(s ?? '').replace(/[\\/]+$/, '').toLowerCase();
    const moved = new Set(movedPaths.map(key));
    const groups = snap.groups
      .map(g => {
        const items = g.items.filter(it => !moved.has(key(it.scanItem.path)));
        if (items.length === g.items.length) return g;
        return {
          ...g,
          items,
          totalSize: items.reduce((a, it) => a + it.scanItem.size, 0),
          episodes: items.map(it => it.parsed.episode).filter((e): e is string => Boolean(e))
        };
      })
      .filter(g => g.items.length > 0);
    await writeJson(this.snapshotPath, {
      ...snap,
      savedAt: new Date().toISOString(),
      lastBatchAt: new Date().toISOString(),
      groups
    });
  }

  /** 撤回后源目录又变回来了 → 快照仍然可用但已不完整，标记为「建议重新扫描」 */
  async markScanSnapshotStale(): Promise<void> {
    const snap = await this.readScanSnapshot();
    if (!snap) return;
    await writeJson(this.snapshotPath, { ...snap, stale: true });
  }

  /* ---------------- 归档执行状态（断点续传） ---------------- */

  /**
   * 归档执行进度。
   *
   * 为什么要落盘：用户可能关掉浏览器、甚至刷新页面，而服务端还在继续搬文件。
   * 把进度写下来，重新打开页面就能看到「上次归档已完成 N / 共 M，可继续」。
   */
  async saveExecuteState(state: ExecuteState): Promise<void> {
    await writeJson(this.executeStatePath, state);
  }

  async readExecuteState(): Promise<ExecuteState | null> {
    try {
      const raw = await fsp.readFile(this.executeStatePath, 'utf8');
      return JSON.parse(stripBom(raw)) as ExecuteState;
    } catch {
      return null;
    }
  }

  async clearExecuteState(): Promise<void> {
    await fsp.rm(this.executeStatePath, { force: true }).catch(() => undefined);
  }

  /* ---------------- 日志 ---------------- */
  async writeBatchLog(log: BatchLog): Promise<void> {
    await writeJson(path.join(this.logsDir, `batch-${log.batchId}.json`), log);
    // 批次结束时把逐条日志删掉（已经汇总进 .json 了）
    await fsp.rm(this.journalPath(log.batchId), { force: true }).catch(() => undefined);
  }

  /** 逐条日志文件（`.jsonl`）：归档过程中实时追加，中途被关页面/杀进程也不会丢 */
  journalPath(batchId: string): string {
    return path.join(this.logsDir, `batch-${batchId}.jsonl`);
  }

  /** 归档每完成一条就追加一行（崩溃/中断后仍能撒回已归档的部分） */
  async appendBatchJournal(batchId: string, log: OperationLog): Promise<void> {
    await appendJsonLine(this.journalPath(batchId), log);
  }

  /**
   * 列出批次日志。
   *
   * 包含两类：
   *  - `batch-*.json`：正常结束的完整批次
   *  - `batch-*.jsonl`：**尚未结束**（被关页面 / 杀进程 / 还在跑）的批次，由逐条日志汇总而来
   */
  async listBatchLogs(): Promise<BatchLog[]> {
    const files = await fsp.readdir(this.logsDir).catch(() => [] as string[]);
    const out: BatchLog[] = [];
    for (const f of files.filter(x => x.startsWith('batch-') && x.endsWith('.json'))) {
      try {
        const raw = await fsp.readFile(path.join(this.logsDir, f), 'utf8');
        out.push(JSON.parse(stripBom(raw)) as BatchLog);
      } catch { /* 忽略损坏的日志 */ }
    }
    const done = new Set(out.map(b => b.batchId));
    for (const f of files.filter(x => x.startsWith('batch-') && x.endsWith('.jsonl'))) {
      const batchId = f.replace(/^batch-/, '').replace(/\.jsonl$/, '');
      if (done.has(batchId)) continue;
      try {
        const entries = await readJsonLines<OperationLog>(path.join(this.logsDir, f));
        if (!entries.length) continue;
        const first = entries[0];
        out.push({
          batchId,
          createdAt: first.timestamp,
          sourceRoot: '',
          targetRoot: '',
          entries
        });
      } catch { /* 忽略损坏的日志 */ }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async appendRevertLog(log: RevertLog): Promise<void> {
    await appendJsonLine(path.join(this.logsDir, 'revert.jsonl'), log);
  }

  async listRevertLogs(): Promise<RevertLog[]> {
    return readJsonLines<RevertLog>(path.join(this.logsDir, 'revert.jsonl'));
  }

  async appendRenameLog(log: RenameLog): Promise<void> {
    await appendJsonLine(path.join(this.logsDir, 'rename.jsonl'), log);
  }

  async listRenameLogs(): Promise<RenameLog[]> {
    return readJsonLines<RenameLog>(path.join(this.logsDir, 'rename.jsonl'));
  }

  /**
   * 全部成功归档记录（含 originPath），供索引「可撤回」判定。
   *  - 撤回成功的记录会从映射中移除；
   *  - 媒体库中「重命名番剧文件夹」后，会按重命名日志把键同步到新路径。
   */
  async allMoveLogs(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const batches = await this.listBatchLogs();
    for (const b of batches.slice().reverse()) {
      for (const e of b.entries) {
        if (e.result === 'success' && e.opType === 'move') {
          map.set(e.toPath.toLowerCase(), e.originPath);
        }
      }
    }

    const reverts = await this.listRevertLogs();
    for (const r of reverts) {
      if (r.result === 'success') map.delete(r.filePath.toLowerCase());
    }

    // 重命名番剧文件夹 → 把已归档记录的键迁移到新路径
    const renames = await this.listRenameLogs();
    for (const r of renames) {
      if (r.result !== 'success') continue;
      const from = r.fromPath.toLowerCase();
      const to = r.toPath.toLowerCase();
      for (const [k, v] of Array.from(map.entries())) {
        if (k === from) {
          map.delete(k);
          map.set(to, v);
        } else if (k.startsWith(from + '\\')) {
          map.delete(k);
          map.set(to + k.slice(from.length), v);
        }
      }
    }

    return map;
  }

  /**
   * 解析某个文件的「归档前原路径」。
   * 若文件本身没有记录（例如它随整个文件夹一起被移动），则回溯最近的祖先目录记录。
   */
  static resolveOrigin(map: Map<string, string>, fullPath: string): string | null {
    const key = fullPath.toLowerCase();
    const exact = map.get(key);
    if (exact) return exact;

    let cur = fullPath;
    const parts: string[] = [];
    for (let i = 0; i < 8; i++) {
      const parent = path.dirname(cur);
      if (!parent || parent === cur) break;
      parts.unshift(path.basename(cur));
      const hit = map.get(parent.toLowerCase());
      if (hit) return path.join(hit, ...parts);
      cur = parent;
    }
    return null;
  }

  /* ---------------- 媒体库索引 ---------------- */

  async writeLibraryIndex(idx: LibraryIndex, siteDirs: string[]): Promise<string[]> {
    const written: string[] = [];
    for (const dir of siteDirs) {
      const j = path.join(dir, 'library.json');
      const js = path.join(dir, 'library.js');
      await ensureDir(dir);
      await writeJson(j, idx);
      // 同时产出 library.js：便于以 file:// 双击打开时用 <script> 读取（浏览器禁止 file:// 下 fetch）
      await fsp.writeFile(
        js,
        `window.__LIBRARY__ = ${JSON.stringify(idx)};\nwindow.__LIBRARY_GENERATED_AT__ = ${JSON.stringify(idx.generatedAt)};\n`,
        'utf8'
      );
      written.push(j, js);
    }
    return written;
  }

  async readLibraryIndex(siteDir: string): Promise<LibraryIndex | null> {
    try {
      const raw = await fsp.readFile(path.join(siteDir, 'library.json'), 'utf8');
      return JSON.parse(stripBom(raw)) as LibraryIndex;
    } catch {
      return null;
    }
  }
}

/* ---------------- 工具 ---------------- */

function defaultConfig(root: string): AppConfig {
  return {
    port: 9999,
    nodePath: '',
    sourceRoot: '',
    targetRoot: '',
    theme: 'system',
    reviewThreshold: 0.7,
    autoThreshold: 0.9,
    bangumiEnabled: true,
    siteDir: path.resolve(root, '..', 'web', 'data'),
    webSearchEnabled: true,
    useFileTime: true,
    googleApiKey: '',
    googleCx: '',
    scanConcurrency: 10,
    // 关掉最后一个网页 → 自动关闭本地服务（免去手动点「⏻ 关闭服务」）
    shutdownOnPageClose: true
  };
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function appendJsonLine(file: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, JSON.stringify(data) + '\n', 'utf8');
}

async function readJsonLines<T>(file: string): Promise<T[]> {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return stripBom(raw)
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l) as T);
  } catch {
    return [];
  }
}

/* ================= 别名预计算项 ================= */

/** L3 模糊匹配用的别名项：把昂贵的 `aliasKey` 结果预先算好 */
export interface AliasItem {
  /** 原始别名键（别名表里的键） */
  alias: string;
  /** `aliasKey(alias)` */
  key: string;
  /** `aliasKey(aliasKey(alias))` —— 与 `similarity()` 内部实际使用的键一致 */
  key2: string;
  entry: AliasEntry;
}

function makeAliasItem(alias: string, entry: AliasEntry): AliasItem {
  const key = aliasKey(alias);
  return { alias, key, key2: aliasKey(key), entry };
}

/** 「更具体者胜」复核用的官方名项：键必须按 `zh`（官方名）预先算好 */
export interface ZhItem {
  /** `aliasKey(aliasKey(zh))` —— 与 `similarity()` 内部实际使用的键一致 */
  key2: string;
  year: number | null;
  month: number | null;
}

function makeZhItem(zh: string, v: { year?: number | null; month?: number | null }): ZhItem {
  return { key2: aliasKey(aliasKey(zh)), year: v.year ?? null, month: v.month ?? null };
}

/** 别名表 / 查询缓存合并写盘的延迟（毫秒） */
const FLUSH_DELAY_MS = 800;
