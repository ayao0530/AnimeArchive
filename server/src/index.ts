/**
 * 服务启动入口
 *
 *  - 默认端口 9999；被占用时自动 +1 并写回配置（文档 8.8）
 *  - 只监听 127.0.0.1
 *  - 优雅退出（写 runtime.json 便于 start/stop 脚本定位进程）
 */
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer, VERSION } from './http/server';
import { Store } from './core/store';
import { ensureDir } from './fsx/fsx';

const SERVER_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

async function findSiteDir(): Promise<string> {
  const dist = path.join(PROJECT_ROOT, 'web', 'dist');
  if (fs.existsSync(path.join(dist, 'index.html'))) return dist;
  const dev = path.join(PROJECT_ROOT, 'web');
  if (fs.existsSync(path.join(dev, 'index.html'))) return dev;
  await ensureDir(dist);
  return dist;
}

function listenOnce(server: import('node:http').Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function main(): Promise<void> {
  const store = new Store(SERVER_ROOT);
  await store.init();

  // 上次运行若在搬文件途中被关掉，execute-state.json 里会留着 running:true。
  // 启动时把它标成「已中断」，界面才能提示「上次归档未完成，可继续」。
  const prevState = await store.readExecuteState();
  if (prevState?.running) {
    await store.saveExecuteState({
      ...prevState,
      running: false,
      interrupted: true,
      updatedAt: new Date().toISOString()
    });
  }

  const cfg = store.getConfig();
  const siteDir = await findSiteDir();
  const dataDir = path.join(siteDir, 'data');
  await ensureDir(dataDir);
  // 索引额外写一份到源码目录 web/data，便于开发模式与直接查看
  const webDataDir = path.join(PROJECT_ROOT, 'web', 'data');
  /*
   * 还要再写一份到 web/public/data：
   * `vite build` 会**清空 dist**（emptyOutDir 默认开），把 dist/data 里的索引一起删掉，
   * 于是「重建一次前端 → 媒体库变空」这种莫名其妙的故障就出现了。
   * public/ 下的内容会被原样拷进 dist，所以放这里最稳。
   */
  const publicDataDir = path.join(PROJECT_ROOT, 'web', 'public', 'data');

  const ctx = {
    store,
    siteDir,
    dataDir,
    indexDirs: [webDataDir, publicDataDir],
    startedAt: Date.now(),
    onShutdown: (): void => {
      /* 由 /api/shutdown 调用；此处无需额外动作 */
    }
  };
  const server = createServer(ctx);

  let port = cfg.port || 9999;
  let bound = false;
  for (let i = 0; i < 50; i++) {
    try {
      await listenOnce(server, port);
      bound = true;
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        console.log(`⚠ 端口 ${port} 已被占用，尝试 ${port + 1} …`);
        port += 1;
        continue;
      }
      throw err;
    }
  }
  if (!bound) throw new Error('无法找到可用端口（已尝试 50 个）');

  if (port !== cfg.port) await store.saveConfig({ port });

  const url = `http://127.0.0.1:${port}`;
  const runtime = {
    pid: process.pid,
    port,
    url,
    version: VERSION,
    startedAt: new Date().toISOString(),
    siteDir,
    dataDir
  };
  await fsp.writeFile(path.join(store.dataDir, 'runtime.json'), JSON.stringify(runtime, null, 2), 'utf8');
  await fsp.writeFile(path.join(dataDir, 'runtime.json'), JSON.stringify(runtime, null, 2), 'utf8');

  console.log('');
  console.log('  ╔══════════════════════════════════════════════════╗');
  console.log('  ║   番剧归档助手 · 本地服务已启动                   ║');
  console.log('  ╚══════════════════════════════════════════════════╝');
  console.log(`   网站地址 : ${url}`);
  console.log(`   索引目录 : ${dataDir}`);
  console.log(`   进程 PID : ${process.pid}`);
  console.log('   关闭方式 : 网页右上角「⏻ 关闭服务」，或运行 server\\bin\\stop.bat');
  console.log('');

  // 自动打开浏览器（可用 --no-open 关闭）
  if (!process.argv.includes('--no-open')) {
    const { spawn } = await import('node:child_process');
    spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' })
      .on('error', () => undefined)
      .unref();
  }

  const cleanup = async (): Promise<void> => {
    try { await fsp.rm(path.join(dataDir, 'runtime.json'), { force: true }); } catch { /* ignore */ }
    try { await fsp.rm(path.join(store.dataDir, 'runtime.json'), { force: true }); } catch { /* ignore */ }
  };
  const bye = (): void => { void cleanup().finally(() => process.exit(0)); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}

main().catch(err => {
  console.error('❌ 启动失败：', (err as Error).message);
  process.exit(1);
});

// 兜底：任何未捕获异常都只记录日志，避免本地服务意外退出
process.on('uncaughtException', err => {
  console.error('⚠ 未捕获异常（服务继续运行）：', err);
});
process.on('unhandledRejection', reason => {
  console.error('⚠ 未处理的 Promise 拒绝（服务继续运行）：', reason);
});
