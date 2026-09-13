/**
 * 本地轻量服务（仅监听 127.0.0.1）
 *
 * 职责：扫描 / 生成方案 / 执行剪切 / 撤回 / 重命名 / 索引 / 播放 / 关闭服务，
 *       并托管静态网站（web/dist 或 web/）。
 */
import * as http from 'node:http';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { URL } from 'node:url';
import { ArchivePlan, AppConfig } from '../types';
import { Store } from '../core/store';
import { scanSource } from '../core/scanner';
import { groupItems } from '../core/grouper';
import { buildPlan } from '../core/planner';
import { executePlan, requestExecuteStop, EntryDecision, revert } from '../core/executor';
import { buildLibraryIndex } from '../core/indexer';
import { renameAnimeFolder } from '../core/renamer';
import { moveInLibrary, moveManyInLibrary } from '../core/libraryMove';
import { playFile } from '../core/player';
import { revealInExplorer } from '../core/explorer';
import { clearNormalizeCache, buildBangumiQueries } from '../core/normalizer';
import { BangumiSubject, searchSubjects } from '../bangumi/client';
import { aliasKey } from '../util/text';
import { isReadableDir, isWritableDir, normalizePath, toLongPath, ensureDir } from '../fsx/fsx';
import type { PageSessions } from '../core/pageSessions';

export const VERSION = '1.0.0';

export interface ServerContext {
  store: Store;
  /** 网站静态目录（web/dist 或 web/） */
  siteDir: string;
  /** 索引输出目录（站点 data 目录） */
  dataDir: string;
  /** 索引需要额外写出的目录（如源码目录 web/data） */
  indexDirs: string[];
  startedAt: number;
  /**
   * 网页会话登记：关掉最后一个页面 → 服务自动关闭（实现见 index.ts）。
   * 由前端在页面加载时 `/api/page/open`、关闭时 `/api/page/close`（sendBeacon）。
   */
  pageSessions: PageSessions;
  onShutdown: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

export function createServer(ctx: ServerContext): http.Server {
  return http.createServer((req, res) => {
    handle(req, res, ctx).catch(err => {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: (err as Error).message });
      else res.end();
    });
  });
}

/* =========================================================
   路由
   ========================================================= */

async function handle(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServerContext): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);
  const method = (req.method ?? 'GET').toUpperCase();

  // 允许 file:// 打开页面时也能调用本地服务（仅监听 127.0.0.1，风险可控）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname.startsWith('/api/')) {
    await handleApi(req, res, ctx, pathname, method, url);
    return;
  }

  await serveStatic(res, ctx, pathname);
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServerContext,
  pathname: string,
  method: string,
  url: URL
): Promise<void> {
  switch (pathname) {
    /* ---------- 健康检查 / 配置 ---------- */
    case '/api/health': {
      return sendJson(res, 200, {
        ok: true,
        data: {
          version: VERSION,
          pid: process.pid,
          port: ctx.store.getConfig().port,
          uptimeMs: Date.now() - ctx.startedAt,
          startedAt: new Date(ctx.startedAt).toISOString(),
          /** 还开着的网页数（关掉最后一个页面 → 服务自动关闭） */
          pages: ctx.pageSessions.count(),
          shutdownOnPageClose: ctx.store.getConfig().shutdownOnPageClose !== false
        }
      });
    }

    case '/api/config': {
      if (method === 'POST') {
        const body = await readJson<Partial<AppConfig>>(req);
        const cfg = await ctx.store.saveConfig(body ?? {});
        return sendJson(res, 200, { ok: true, data: cfg });
      }
      return sendJson(res, 200, { ok: true, data: ctx.store.getConfig() });
    }

    /* ---------- 网页会话：关掉最后一个页面 → 自动关闭服务 ----------
     * 前端在页面加载时登记（open）、关闭时注销（close，走 sendBeacon 所以卸载阶段也发得出去）。
     * 最后一个会话注销后不会立即退出：服务端会等一小段宽限期，期间有新页面登记（= 刷新）即取消。
     * 没登记过的 sessionId 一律忽略 —— 避免别的工具随手一个请求就把服务关掉。
     */
    case '/api/page/open': {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
      const body = await readJson<{ sessionId?: string }>(req);
      const id = (body?.sessionId ?? '').trim();
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
      ctx.pageSessions.open(id);
      return sendJson(res, 200, {
        ok: true,
        data: {
          tracked: true,
          pages: ctx.pageSessions.count(),
          shutdownOnPageClose: ctx.store.getConfig().shutdownOnPageClose !== false
        }
      });
    }

    case '/api/page/close': {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
      const body = await readJson<{ sessionId?: string }>(req);
      const id = (body?.sessionId ?? '').trim();
      if (!id) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' });
      const accepted = ctx.pageSessions.close(id);
      return sendJson(res, 200, {
        ok: true,
        data: {
          accepted,
          pages: ctx.pageSessions.count(),
          /** 是否已进入「即将关闭」倒计时（关掉最后一个页面且开启了自动关闭） */
          closing: ctx.pageSessions.pending(),
          shutdownOnPageClose: ctx.store.getConfig().shutdownOnPageClose !== false
        }
      });
    }

    /* ---------- 一键关闭服务 ---------- */
    case '/api/shutdown': {
      sendJson(res, 200, { ok: true, data: { message: '服务正在关闭…' } });
      // 关服务前把内存里的别名表 / 查询缓存落盘，避免刚扫完的结果丢掉
      void ctx.store.flush().catch(() => undefined).then(() => {
        try { ctx.onShutdown(); } catch { /* ignore */ }
        process.exit(0);
      });
      return;
    }

    /* ---------- 目录探测 ---------- */
    case '/api/fs/check': {
      const target = url.searchParams.get('path') ?? '';
      const kind = url.searchParams.get('kind') ?? 'source';
      if (!target) return sendJson(res, 200, { ok: true, data: { exists: false, readable: false, writable: false } });
      const readable = await isReadableDir(target);
      const writable = await isWritableDir(target);
      return sendJson(res, 200, { ok: true, data: { exists: readable || writable, readable, writable, kind } });
    }

    /**
     * 创建目录（用于「归档根目录尚未创建」的场景）。
     * 执行归档时不会静默创建根目录（安全约束 A9），
     * 而是由用户在界面上显式确认后调用本接口创建。
     */
    case '/api/fs/ensure': {
      const body = await readJson<{ path?: string }>(req);
      const target = normalizePath(body?.path ?? '');
      if (!target) return sendJson(res, 400, { ok: false, error: '路径不能为空' });
      const existed = await isReadableDir(target);
      try {
        await ensureDir(target);
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: `创建目录失败：「${target}」—— ${(err as Error).message}（请确认 NAS 已连接且路径可写）`
        });
      }
      const writable = await isWritableDir(target);
      if (!writable) {
        return sendJson(res, 400, { ok: false, error: `目录已创建但不可写：「${target}」` });
      }
      return sendJson(res, 200, { ok: true, data: { created: !existed, path: target, writable: true } });
    }

    /**
     * 列出媒体库中已存在的番剧文件夹（`{年}\{月}\{番剧名}`），
     * 供人工确认弹窗「从已归档文件夹中选择」，避免每次重复输入译名。
     */
    case '/api/fs/anime-dirs': {
      const cfgDir = ctx.store.getConfig().targetRoot;
      const root = normalizePath(url.searchParams.get('root') || cfgDir || '');
      if (!root) return sendJson(res, 200, { ok: true, data: [] });
      if (!(await isReadableDir(root))) return sendJson(res, 200, { ok: true, data: [] });

      const out: Array<{ name: string; year: number | null; month: number | null; relPath: string }> = [];
      const listYears = await fsp.readdir(toLongPath(root), { withFileTypes: true }).catch(() => []);

      for (const y of listYears) {
        if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
        const yearDir = path.join(root, y.name);
        const listMonths = await fsp.readdir(toLongPath(yearDir), { withFileTypes: true }).catch(() => []);
        for (const m of listMonths) {
          if (!m.isDirectory()) continue;
          const monthDir = path.join(yearDir, m.name);
          const listAnime = await fsp.readdir(toLongPath(monthDir), { withFileTypes: true }).catch(() => []);
          for (const a of listAnime) {
            if (!a.isDirectory()) continue;
            out.push({
              name: a.name,
              year: Number(y.name),
              month: /^\d{1,2}$/.test(m.name) ? Number(m.name) : null,
              relPath: [y.name, m.name, a.name].join('\\')
            });
          }
        }
      }

      out.sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || (b.month ?? 0) - (a.month ?? 0) || a.name.localeCompare(b.name, 'zh-CN'));
      return sendJson(res, 200, { ok: true, data: out });
    }

    case '/api/fs/dirs': {
      const target = normalizePath(url.searchParams.get('path') ?? '');
      if (!target) return sendJson(res, 200, { ok: true, data: [] });
      const list = await fsp.readdir(toLongPath(target), { withFileTypes: true }).catch(() => []);
      return sendJson(res, 200, {
        ok: true,
        data: list
          .filter(e => e.isDirectory())
          .map(e => ({ name: e.name, path: path.join(target, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
      });
    }

    /* ---------- 在文件资源管理器中打开（打开文件夹 / 选中文件） ---------- */
    case '/api/fs/reveal': {
      const body = await readJson<{ path?: string; select?: boolean }>(req);
      try {
        const opened = await revealInExplorer(body?.path ?? '', body?.select === true);
        return sendJson(res, 200, { ok: true, data: { opened } });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
    }

    /* ---------- 扫描 + 生成方案（SSE 推进度） ---------- */
    case '/api/scan': {
      const body = await readJson<{ sourceRoot?: string; targetRoot?: string; online?: boolean; skipBangumi?: boolean }>(req);
      const cfg = ctx.store.getConfig();
      const sourceRoot = normalizePath(body?.sourceRoot || cfg.sourceRoot || '');
      const targetRoot = normalizePath(body?.targetRoot || cfg.targetRoot || '');
      if (!sourceRoot) return sendJson(res, 400, { ok: false, error: '请先填写源目录' });
      if (!targetRoot) return sendJson(res, 400, { ok: false, error: '请先填写归档根目录' });
      if (sourceRoot.toLowerCase() === targetRoot.toLowerCase()) {
        return sendJson(res, 400, { ok: false, error: '源目录与归档根目录不能相同' });
      }
      if (!(await isReadableDir(sourceRoot))) {
        return sendJson(res, 400, { ok: false, error: `源目录不存在或不可读：「${sourceRoot}」` });
      }
      // 记住上次输入的路径
      await ctx.store.saveConfig({ sourceRoot, targetRoot });

      const sse = openSse(res);
      try {
        // 先回报归档根目录状态，便于界面提前提示「目录不存在，是否创建」
        sse.send({
          type: 'target',
          targetRoot,
          exists: await isReadableDir(targetRoot),
          writable: await isWritableDir(targetRoot)
        });
        sse.send({ type: 'phase', phase: 'scan', message: '正在扫描源目录…' });
        const scan = await scanSource({
          sourceRoot,
          excludeRoot: targetRoot,
          concurrency: cfg.scanConcurrency ?? 10,
          onProgress: info => sse.send({ type: 'progress', phase: 'scan', scanned: info.scanned, current: info.current })
        });
        sse.send({
          type: 'scanDone',
          files: scan.files,
          dirs: scan.dirs,
          skippedNonVideo: scan.skippedNonVideo,
          excluded: scan.excluded,
          items: scan.items.length
        });

        sse.send({ type: 'phase', phase: 'normalize', message: '正在解析与归一化名称…' });
        clearNormalizeCache();
        // 归档区里**已经存在**的番剧文件夹 → 用于「更具体者胜」复核。
        // 多季作品最容易归错：别名表若捎把「第 N 季」的名字挂到第一季上，
        // 就会整季被自动归到第一季文件夹。用户已经建好的那一季文件夹是最可靠的依据。
        // 索引可能只存在于某个副本（例如 `vite build` 清空过 web/dist），逐个站点目录找
        let libIdx = await ctx.store.readLibraryIndex(ctx.dataDir).catch(() => null);
        for (const d of ctx.indexDirs) {
          if (libIdx?.anime?.length) break;
          libIdx = await ctx.store.readLibraryIndex(d).catch(() => null);
        }
        const archiveFolders = libIdx?.anime?.map(a => ({ zh: a.zhName, year: a.year, month: a.month })) ?? [];
        if (archiveFolders.length) {
          sse.send({ type: 'log', message: `ℹ 已载入 ${archiveFolders.length} 个已归档番剧文件夹，多季作品会优先匹配已有文件夹` });
        }
        const groups = await groupItems(scan.items, ctx.store, {
          reviewThreshold: cfg.reviewThreshold,
          autoThreshold: cfg.autoThreshold,
          bangumiEnabled: cfg.bangumiEnabled && body?.skipBangumi !== true,
          online: body?.online !== false,
          persistCache: true,
          webSearchEnabled: cfg.webSearchEnabled !== false,
          useFileTime: cfg.useFileTime !== false,
          googleApiKey: cfg.googleApiKey,
          googleCx: cfg.googleCx,
          archiveFolders,
          normalizeConcurrency: Math.max(2, Math.floor((cfg.scanConcurrency ?? 10) * 0.6)),
          onProgress: p => sse.send({ type: 'progress', phase: 'normalize', scanned: p.done, total: p.total, current: p.current }),
          onLog: msg => sse.send({ type: 'log', message: msg })
        });

        sse.send({ type: 'phase', phase: 'plan', message: '正在生成归档方案（dry-run）…' });
        const plan = await buildPlan(groups, { sourceRoot, targetRoot, detectConflicts: true });
        // 保存「上次扫描快照」：下次打开页面直接载入，无需重新扫描
        await ctx.store.saveScanSnapshot({
          version: 1,
          savedAt: new Date().toISOString(),
          sourceRoot,
          targetRoot,
          scanInfo: {
            files: scan.files,
            dirs: scan.dirs,
            skippedNonVideo: scan.skippedNonVideo,
            excluded: scan.excluded
          },
          groups
        });
        sse.send({ type: 'plan', plan });
        await ctx.store.flush();   // 归一化期间累积的别名表 / 查询缓存一次性落盘
        sse.send({ type: 'done' });
      } catch (err) {
        sse.send({ type: 'error', message: (err as Error).message });
      } finally {
        sse.close();
      }
      return;
    }

    /* ---------- 上次扫描快照（秒开：直接载入上次结果，不重新扫描） ---------- */
    case '/api/scan/last': {
      const snap = await ctx.store.readScanSnapshot();
      if (!snap) return sendJson(res, 200, { ok: true, data: null });
      const cfg = ctx.store.getConfig();
      const same = (a: string, b: string): boolean =>
        normalizePath(a || '').toLowerCase() === normalizePath(b || '').toLowerCase();
      return sendJson(res, 200, {
        ok: true,
        data: {
          ...snap,
          matchesConfig: same(snap.sourceRoot, cfg.sourceRoot) && same(snap.targetRoot, cfg.targetRoot)
        }
      });
    }

    /* ---------- 手动检索 Bangumi（「分开归档 / 确认名称」弹窗里直接搜番剧） ---------- */
    case '/api/bangumi/search': {
      const q = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit') ?? 8) || 8));
      if (!q) return sendJson(res, 400, { ok: false, error: '缺少检索词 q' });
      const cfg = ctx.store.getConfig();
      if (cfg.bangumiEnabled === false) {
        return sendJson(res, 200, { ok: true, data: { query: q, tried: [], results: [] } });
      }
      // 繁体先转简体再检索（直接用繁体不仅搜不到，还会命中错误条目）
      const tried = buildBangumiQueries(q, null);
      const seen = new Map<number, BangumiSubject>();
      let online = true;
      /** 是否直接用了本地缓存（没联网） */
      let fromCache = false;
      for (const k of tried) {
        const ck = `bgm:${aliasKey(k)}`;
        const cached = await ctx.store.getCached<BangumiSubject[]>(ck);
        let list: BangumiSubject[] = Array.isArray(cached) ? cached : [];
        if (list.length) {
          fromCache = true;
        } else {
          try {
            list = await searchSubjects(k);
            if (list.length) await ctx.store.setCached(ck, list);
          } catch {
            online = false;
            continue;
          }
        }
        list.forEach(s => { if (s && Number.isFinite(s.id) && !seen.has(s.id)) seen.set(s.id, s); });
        // 命中即止：再拿备选词（如繁体原文）去搜只会混进一堆不相干的条目
        if (seen.size) break;
      }
      await ctx.store.flush();
      const results = Array.from(seen.values())
        .slice(0, limit)
        .map(s => ({
          id: s.id,
          name: s.name,
          nameCn: s.nameCn,
          date: s.date,
          year: s.year,
          month: s.month,
          /** 官网链接，便于想进一步核对时点开（不是必须步骤） */
          url: `https://bgm.tv/subject/${s.id}`
        }));
      return sendJson(res, 200, {
        ok: true,
        data: { query: q, tried, online, fromCache: fromCache && !!results.length, results }
      });
    }

    /* ---------- 重新生成方案（不重新扫描） ---------- */
    case '/api/plan': {      const body = await readJson<{ groups?: unknown; sourceRoot?: string; targetRoot?: string }>(req);
      if (!body?.groups) return sendJson(res, 400, { ok: false, error: '缺少 groups' });
      const cfg = ctx.store.getConfig();
      const plan = await buildPlan(body.groups as never, {
        sourceRoot: normalizePath(body.sourceRoot || cfg.sourceRoot),
        targetRoot: normalizePath(body.targetRoot || cfg.targetRoot),
        detectConflicts: true
      });
      return sendJson(res, 200, { ok: true, data: plan });
    }

    /* ---------- 归档执行进度（断点续传） ---------- */
    case '/api/execute/progress': {
      if (method === 'DELETE') {
        await ctx.store.clearExecuteState();
        return sendJson(res, 200, { ok: true, data: null });
      }
      const st = await ctx.store.readExecuteState();
      return sendJson(res, 200, { ok: true, data: st ?? null });
    }

    /* ---------- 停止执行归档 ----------
     * 用户点「停止」后：立即不再取新条目，已在飞的那几条会先跑完
     * （半途硬断会在 NAS 上留下复制到一半的文件）。
     * 停止后 execute-state.json 会写 stopped:true，界面可以「继续归档」接着跑，
     * 也可以直接用本批次日志「撤销整批」。
     */
    case '/api/execute/stop': {
      if (method !== 'POST') return sendJson(res, 405, { ok: false, error: '仅支持 POST' });
      return sendJson(res, 200, { ok: true, data: requestExecuteStop() });
    }

    /* ---------- 执行归档（SSE） ---------- */
    case '/api/execute': {
      const body = await readJson<{ plan?: ArchivePlan; decisions?: Record<string, EntryDecision> }>(req);
      const plan = body?.plan;
      if (!plan || !Array.isArray(plan.entries)) return sendJson(res, 400, { ok: false, error: '缺少归档方案' });

      const sse = openSse(res);
      try {
        const cfg = ctx.store.getConfig();
        const movedFrom: string[] = [];
        const result = await executePlan(ctx.store, {
          plan,
          decisions: body?.decisions ?? {},
          // 并发搬文件：文件量大、NAS 上单次移动是一个网络往返，串行会非常慢
          concurrency: Math.max(1, Math.min(cfg.scanConcurrency ?? 10, 32)),
          onEvent: ev => {
            const e = ev as unknown as { type?: string; status?: string; fromPath?: string };
            if (e?.type === 'entry' && e.status === 'done' && e.fromPath) movedFrom.push(e.fromPath);
            sse.send(ev as unknown as Record<string, unknown>);
          }
        });
        if (result.stopped) {
          sse.send({
            type: 'log',
            message: `⏹ 已停止归档：本批次成功 ${result.success} / 失败 ${result.failed} / 跳过 ${result.skipped}；` +
              `剩下的条目可以点「继续归档」接着跑（已搬过去的会自动跳过）`
          });
        }
        // 归档完成后**自动重建索引**（一条都没搬成功就不用白跑一趟）
        if (result.success > 0) {
          sse.send({ type: 'phase', phase: 'index', message: '正在重建媒体库索引…' });
          const idx = await buildLibraryIndex(ctx.store, {
            libraryRoot: plan.targetRoot,
            siteDirs: [ctx.dataDir, ...ctx.indexDirs],
            onLog: msg => sse.send({ type: 'log', message: msg })
          });
          sse.send({ type: 'indexDone', generatedAt: idx.generatedAt, stats: idx.stats });
          // 源目录已变化 → **裁剪**上次扫描快照（保留尚未处理的项，下次打开免重扫）
          await ctx.store.pruneScanSnapshot(movedFrom);
        }
        sse.send({
          type: 'done',
          batchId: result.batchId,
          success: result.success,
          failed: result.failed,
          skipped: result.skipped,
          stopped: result.stopped
        });
        await ctx.store.flush();
      } catch (err) {
        sse.send({ type: 'error', message: (err as Error).message });
      } finally {
        sse.close();
      }
      return;
    }

    /* ---------- 撤回 ---------- */
    case '/api/revert': {
      const body = await readJson<{ batchId?: string; filePath?: string }>(req);
      try {
        const result = await revert(ctx.store, { batchId: body?.batchId, filePath: body?.filePath });
        // 文件被移回源目录 → 快照不完整了，标记为「建议重新扫描」（不直接删除，免得又得全量重扫）
        if (result.success > 0) await ctx.store.markScanSnapshotStale();
        // 撤回后局部刷新索引
        const cfg = ctx.store.getConfig();
        if (cfg.targetRoot) {
          await buildLibraryIndex(ctx.store, {
            libraryRoot: normalizePath(cfg.targetRoot),
            siteDirs: [ctx.dataDir, ...ctx.indexDirs]
          });
        }
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
    }

    /* ---------- 重命名番剧文件夹 ---------- */
    case '/api/rename': {
      const body = await readJson<{ relPath?: string; newName?: string }>(req);
      const cfg = ctx.store.getConfig();
      if (!cfg.targetRoot) return sendJson(res, 400, { ok: false, error: '尚未设置媒体库根目录' });
      try {
        const result = await renameAnimeFolder(ctx.store, normalizePath(cfg.targetRoot), {
          relPath: body?.relPath ?? '',
          newName: body?.newName ?? ''
        });
        await buildLibraryIndex(ctx.store, {
          libraryRoot: normalizePath(cfg.targetRoot),
          siteDirs: [ctx.dataDir, ...ctx.indexDirs]
        });
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
    }

    /* ---------- 媒体库内移动（归档结果区的二次操作） ---------- */
    case '/api/library/move': {
      const body = await readJson<{
        fromPath?: string; zhName?: string; year?: number; month?: number;
        subDir?: 'SP' | 'OP&ED' | null; newName?: string;
      }>(req);
      const cfg = ctx.store.getConfig();
      if (!cfg.targetRoot) return sendJson(res, 400, { ok: false, error: '尚未设置归档根目录' });
      try {
        const result = await moveInLibrary(ctx.store, normalizePath(cfg.targetRoot), {
          fromPath: body?.fromPath ?? '',
          zhName: body?.zhName ?? '',
          year: Number(body?.year),
          month: Number(body?.month),
          subDir: body?.subDir ?? null,
          newName: body?.newName
        });
        await buildLibraryIndex(ctx.store, {
          libraryRoot: normalizePath(cfg.targetRoot),
          siteDirs: [ctx.dataDir, ...ctx.indexDirs]
        });
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
    }

    /* ---------- 媒体库内**批量**二次移动（整部番剧一起搬） ----------
     * 与单文件接口的区别：**只在结束时重建一次索引**。
     * 逐条调单文件接口的话，100 集就是 100 次全量索引重建，慢到没法用。
     */
    case '/api/library/move-batch': {
      const body = await readJson<{
        fromPaths?: string[]; zhName?: string; year?: number; month?: number;
        subDir?: 'SP' | 'OP&ED' | null;
      }>(req);
      const cfg = ctx.store.getConfig();
      if (!cfg.targetRoot) return sendJson(res, 400, { ok: false, error: '尚未设置归档根目录' });
      const fromPaths = (body?.fromPaths ?? []).filter(p => typeof p === 'string' && p.trim());
      if (!fromPaths.length) return sendJson(res, 400, { ok: false, error: '请选择要移动的文件' });
      try {
        const result = await moveManyInLibrary(ctx.store, normalizePath(cfg.targetRoot), {
          fromPaths,
          zhName: body?.zhName ?? '',
          year: Number(body?.year),
          month: Number(body?.month),
          subDir: body?.subDir ?? null
        });
        // 只要真的动过文件就重建一次索引（没动就不白跑）
        if (result.moved > 0) {
          await buildLibraryIndex(ctx.store, {
            libraryRoot: normalizePath(cfg.targetRoot),
            siteDirs: [ctx.dataDir, ...ctx.indexDirs]
          });
        }
        return sendJson(res, 200, { ok: true, data: result });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
    }

    /* ---------- 别名表（人工确认写回） ---------- */
    case '/api/alias': {
      const body = await readJson<{
        aliases?: string[];
        zh?: string;
        year?: number | null;
        month?: number | null;
        save?: boolean;
      }>(req);
      const zh = String(body?.zh ?? '').trim();
      if (!zh) return sendJson(res, 400, { ok: false, error: '番剧名不能为空' });
      if (body?.save === false) {
        return sendJson(res, 200, { ok: true, data: { saved: false } });
      }
      await ctx.store.upsertAlias(
        (body?.aliases ?? []).filter(Boolean),
        zh,
        body?.year ?? null,
        body?.month ?? null,
        'manual'
      );
      // 人工确认的别名最不能丢，立刻落盘（不等合并写入的 800ms 延迟）
      await ctx.store.flush();
      return sendJson(res, 200, { ok: true, data: { saved: true } });
    }

    /* ---------- 媒体库索引 ---------- */
    case '/api/index': {
      const idx = await ctx.store.readLibraryIndex(ctx.dataDir);
      if (!idx) return sendJson(res, 200, { ok: true, data: null });
      return sendJson(res, 200, { ok: true, data: idx });
    }

    case '/api/index/rebuild': {
      const cfg = ctx.store.getConfig();
      const libraryRoot = normalizePath(cfg.targetRoot || '');
      if (!libraryRoot) return sendJson(res, 400, { ok: false, error: '请先设置媒体库根目录（归档根目录）' });
      if (!(await isReadableDir(libraryRoot))) {
        return sendJson(res, 400, { ok: false, error: `媒体库目录不存在或不可读：「${libraryRoot}」` });
      }
      const idx = await buildLibraryIndex(ctx.store, {
        libraryRoot,
        siteDirs: [ctx.dataDir, ...ctx.indexDirs]
      });
      return sendJson(res, 200, { ok: true, data: idx });
    }

    /* ---------- 日志 ---------- */
    case '/api/logs': {
      const batches = await ctx.store.listBatchLogs();
      const reverts = await ctx.store.listRevertLogs();
      const renames = await ctx.store.listRenameLogs();
      return sendJson(res, 200, { ok: true, data: { batches, reverts, renames } });
    }

    /* ---------- 播放 ---------- */
    case '/api/play': {
      const body = await readJson<{ path?: string }>(req);
      try {
        await playFile(body?.path ?? '');
        return sendJson(res, 200, { ok: true, data: { played: body?.path } });
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: (err as Error).message });
      }
    }

    default:
      return sendJson(res, 404, { ok: false, error: `未知接口：${pathname}` });
  }
}

/* =========================================================
   静态站点
   ========================================================= */

async function serveStatic(res: http.ServerResponse, ctx: ServerContext, pathname: string): Promise<void> {
  let rel = pathname.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  if (rel === 'data/library.json' || rel === 'data/library.js') {
    // 索引始终从 dataDir 提供（保证最新）；不存在时优雅返回 404，绝不崩溃
    const file = path.join(ctx.dataDir, path.basename(rel));
    if (!fs.existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('索引尚未生成');
      return;
    }
    return sendFile(res, file);
  }
  const candidate = path.join(ctx.siteDir, rel);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return sendFile(res, candidate);
  }
  // SPA 回退
  const indexHtml = path.join(ctx.siteDir, 'index.html');
  if (fs.existsSync(indexHtml)) return sendFile(res, indexHtml);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('未找到网站文件。请先构建前端：cd web && npm run build');
}

function sendFile(res: http.ServerResponse, file: string): void {
  const ext = path.extname(file).toLowerCase();
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('文件不存在');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  const stream = fs.createReadStream(file);
  stream.on('error', () => {
    // 读取过程中出错（如文件被删除）→ 尽可能优雅收尾，不让进程崩溃
    if (!res.writableEnded) res.end();
  });
  res.on('close', () => { try { stream.destroy(); } catch { /* ignore */ } });
  stream.pipe(res);
}

/* =========================================================
   工具
   ========================================================= */

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson<T>(req: http.IncomingMessage): Promise<T | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(Buffer.from(c)));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw) as T); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

interface Sse {
  send: (data: Record<string, unknown>) => void;
  close: () => void;
}

function openSse(res: http.ServerResponse): Sse {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  let closed = false;
  const timer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  return {
    send: data => {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
    },
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try { res.end(); } catch { /* ignore */ }
    }
  };
}
