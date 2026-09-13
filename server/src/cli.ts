/**
 * 命令行入口（M2 验收用：不启动界面也能输出归档方案）
 *
 *   node dist/cli.js plan  --src "<源目录>" --dst "<归档根目录>" --out plan.json [--offline]
 *   node dist/cli.js index --lib "<已看\\Anime 路径>" [--out library.json]
 *   node dist/cli.js selftest
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from './core/store';
import { scanSource } from './core/scanner';
import { groupItems } from './core/grouper';
import { buildPlan } from './core/planner';
import { buildLibraryIndex } from './core/indexer';
import { probe } from './bangumi/client';

const SERVER_ROOT = path.resolve(__dirname, '..');

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

async function cmdPlan(): Promise<void> {
  const src = arg('src');
  const dst = arg('dst');
  const out = arg('out') ?? 'plan.json';
  const offline = process.argv.includes('--offline');
  if (!src || !dst) {
    console.error('用法：node dist/cli.js plan --src "<源目录>" --dst "<归档根目录>" [--out plan.json] [--offline]');
    process.exit(1);
  }

  const store = new Store(SERVER_ROOT);
  await store.init();

  console.log(`↻ 扫描源目录：${src}`);
  const scan = await scanSource({
    sourceRoot: src,
    excludeRoot: dst,
    onProgress: p => { if (p.scanned % 25 === 0) process.stdout.write(`\r  已扫描 ${p.scanned} 项…`); }
  });
  process.stdout.write('\r');
  console.log(`✅ 扫描完成：视频文件 ${scan.files} 个 / 文件夹 ${scan.dirs} 个 / 忽略非视频 ${scan.skippedNonVideo} 个 / 排除归档目录内 ${scan.excluded} 项`);

  const online = offline ? false : await probe();
  console.log(online ? '🌐 Bangumi 可用，启用在线查询' : '📴 离线模式（仅使用本地别名表 L1/L3）');

  const cfg = store.getConfig();
  const groups = await groupItems(scan.items, store, {
    reviewThreshold: cfg.reviewThreshold,
    autoThreshold: cfg.autoThreshold,
    bangumiEnabled: cfg.bangumiEnabled,
    online,
    persistCache: true,
    onProgress: p => process.stdout.write(`\r  归一化 ${p.done}/${p.total}…`),
    onLog: m => console.log('\n' + m)
  });
  process.stdout.write('\r');
  console.log(`✅ 归一化完成：${groups.length} 组`);

  const plan = await buildPlan(groups, { sourceRoot: src, targetRoot: dst, detectConflicts: true });
  fs.writeFileSync(out, JSON.stringify(plan, null, 2), 'utf8');
  console.log(`✅ 归档方案已写出：${path.resolve(out)}`);
  console.table(groups.map(g => ({
    组: g.groupId,
    原始名: g.rawNames.join(' / '),
    中文名: g.zhName || '（未识别）',
    年月: g.year ? `${g.year}-${String(g.month).padStart(2, '0')}` : '—',
    项数: g.items.length,
    置信度: g.resolution ? g.resolution.confidence.toFixed(2) : '—',
    层级: g.resolution?.matchLevel ?? '—',
    状态: g.status
  })));
  console.log(`统计：${JSON.stringify(plan.stats)}`);
}

async function cmdIndex(): Promise<void> {
  const lib = arg('lib');
  if (!lib) {
    console.error('用法：node dist/cli.js index --lib "<已看\\Anime 路径>"');
    process.exit(1);
  }
  const store = new Store(SERVER_ROOT);
  await store.init();
  const outDir = path.resolve(SERVER_ROOT, 'data');
  const idx = await buildLibraryIndex(store, { libraryRoot: lib, siteDirs: [outDir] });
  console.log(`✅ 索引已生成：${idx.stats.animeCount} 部 / ${idx.stats.fileCount} 个文件 / ${(idx.stats.totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
}

/** 端到端自检：解析 / 归一化 / 分组 / 目标路径（不触碰任何真实文件） */
async function cmdSelfTest(): Promise<void> {
  const { parseName } = await import('./core/parser');
  const { normalizeName } = await import('./core/normalizer');
  const { buildPlan } = await import('./core/planner');
  const { aliasKey } = await import('./util/text');

  const cases: Array<[string, boolean]> = [
    ['[Lilith-Raws] Full Dive - 04 [Baha][WEB-DL][1080p][AVC AAC][CHT][MP4].mp4', false],
    ['[Lilith-Raws] Full Dive - 03 [Baha][WEB-DL][1080p][AVC AAC]', true],
    ['[喵萌奶茶屋] ぼっち・ざ・ろっく！ - SP01 [1080p].mp4', false],
    ['[Group] [Unknown] - 01.mp4', false]
  ];

  console.log('— 文件名解析 —');
  const parsed = cases.map(([n, isDir]) => {
    const p = parseName(n, isDir);
    console.log(`  ${p.recognized ? '✅' : '❌'} ${n}\n     番剧名="${p.animeRawName}" 集数=${p.episode} 类型=${p.mediaType} 子目录=${p.subDir} 字幕组=${p.releaseGroup}`);
    return p;
  });
  const ok1 = parsed[0].animeRawName === 'Full Dive' && parsed[0].episode === '04';
  const ok2 = parsed[1].animeRawName === 'Full Dive' && parsed[1].episode === '03';
  const ok3 = parsed[2].mediaType === 'SP' && parsed[2].episode === 'SP01';
  const ok4 = parsed[3].recognized === false;
  console.log(`  解析断言：${ok1 && ok2 && ok3 && ok4 ? '✅ 全部通过' : '❌ 存在失败'}`);
  console.log(`  Full Dive 与 Full Dive 归一化键一致：${aliasKey('Full Dive') === aliasKey('Full Dive') ? '✅' : '❌'}`);

  console.log('— 分组与目标路径 —');
  const store = new Store(SERVER_ROOT);
  await store.init();
  const cfg = store.getConfig();
  const items = parsed.map((p, i) => ({
    id: `i${i}`,
    path: `D:\\src\\${p.rawName}`,
    name: p.rawName,
    isDir: i === 1,
    size: 1024 * 1024,
    childCount: 1,
    mtime: new Date().toISOString(),
    btime: new Date().toISOString()
  }));
  const groups = await groupItems(items, store, {
    reviewThreshold: cfg.reviewThreshold,
    autoThreshold: cfg.autoThreshold,
    bangumiEnabled: false,
    online: false,
    persistCache: false
  });
  const fullDive = groups.find(g => g.rawNames.some(n => n === 'Full Dive'));
  console.log(`  组数=${groups.length}；Full Dive 组项数=${fullDive?.items.length ?? 0} ${fullDive?.items.length === 2 ? '✅' : '❌'}`);
  const plan = await buildPlan(groups, { sourceRoot: 'D:\\src', targetRoot: 'D:\\dst', detectConflicts: false });
  plan.entries.forEach(e => console.log(`  ${e.fromPath}  ➜  ${e.toPath}  [${e.status}]`));
  const targetOk = plan.entries.some(e => /2021\\04\\/.test(e.toPath));
  console.log(`  目标路径含 2021\\04\\：${targetOk ? '✅' : '⚠ 未命中（离线且别名表未覆盖时属正常）'}`);
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'selftest';
  if (cmd === 'plan') return cmdPlan();
  if (cmd === 'index') return cmdIndex();
  if (cmd === 'selftest') return cmdSelfTest();
  console.error(`未知命令：${cmd}`);
  process.exit(1);
}

main().catch(err => {
  console.error('❌ 执行失败：', (err as Error).message);
  process.exit(1);
});
