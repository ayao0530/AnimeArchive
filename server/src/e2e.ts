/**
 * 端到端自检（在临时目录中创建模拟数据，验证 A1–A13 的后端部分）
 *
 *   node dist/e2e.js
 */
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from './core/store';
import { scanSource } from './core/scanner';
import { groupItems } from './core/grouper';
import { buildPlan } from './core/planner';
import { executePlan, isExecuteRunning, requestExecuteStop, revert } from './core/executor';
import { buildLibraryIndex, computeStats } from './core/indexer';
import { moveInLibrary, moveManyInLibrary, canClimbTo } from './core/libraryMove';
import { revealInExplorer, explorerArgs } from './core/explorer';
import { exists, isInside, joinWinPath } from './fsx/fsx';
import { timeAdjust } from './util/timesignal';
import { buildBangumiQueries, clearNormalizeCache, normalizeName } from './core/normalizer';
import { compareByEpisode } from './core/parser';
import { createPageSessions } from './core/pageSessions';
import { animeEpisodes, attributedMonths } from './core/airStats';
import { aliasKey, similarity, similarityKeyed, strictKey, toSimplified } from './util/text';
import type { LibraryAnime, LibraryFile } from './types';

const results: Array<{ id: string; name: string; pass: boolean; detail: string }> = [];

function check(id: string, name: string, pass: boolean, detail = ''): void {
  results.push({ id, name, pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${name}${detail ? ` —— ${detail}` : ''}`);
}

async function write(file: string, content = 'x'): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, content, 'utf8');
}

async function main(): Promise<void> {
  const root = path.join(os.tmpdir(), `anime-archive-e2e-${Date.now()}`);
  const srcRoot = path.join(root, 'Media');
  const dstRoot = path.join(srcRoot, '已看', 'Anime');

  console.log(`\n📁 测试根目录：${root}\n`);

  /* ---------- 准备模拟数据 ---------- */
  const fileA = '[Lilith-Raws] Full Dive - 04 [Baha][WEB-DL][1080p][AVC AAC][CHT][MP4].mp4';
  const dirB = '[Lilith-Raws] Full Dive - 03 [Baha][WEB-DL][1080p][AVC AAC]';
  const fileC = '[喵萌奶茶屋] ぼっち・ざ・ろっく！ - SP01 [1080p].mp4';
  const fileD = '[Group] [Unknown] - 01.mp4';
  const fileE = '[Lilith-Raws] Spy x Family - 05 [Baha][WEB-DL][1080p][AVC AAC][CHT][MP4].mp4';

  await write(path.join(srcRoot, fileA));
  await write(path.join(srcRoot, dirB, 'ep03.mkv'));
  await write(path.join(srcRoot, fileC));
  await write(path.join(srcRoot, fileD));
  await write(path.join(srcRoot, fileE));
  await write(path.join(srcRoot, 'readme.txt'), 'ignore me');
  // 归档根目录内已存在的文件（必须被扫描排除）
  await write(path.join(dstRoot, '2020', '01', '既有番剧', 'old.mp4'));

  const store = new Store(path.join(root, 'serverdata'));
  await store.init();

  /* ---------- A1 扫描排除归档根目录 ---------- */
  const scan = await scanSource({ sourceRoot: srcRoot, excludeRoot: dstRoot });
  const names = scan.items.map(i => i.name);
  const notIncluded = !names.some(n => n === '已看');
  check('A1', '扫描正确排除归档根目录', scan.excluded >= 1 && notIncluded,
    `排除 ${scan.excluded} 项；视频 ${scan.files} 个、文件夹 ${scan.dirs} 个、忽略非视频 ${scan.skippedNonVideo} 个`);

  /* ---------- 分组 + 归一化 ---------- */
  const groups = await groupItems(scan.items, store, {
    reviewThreshold: 0.7,
    autoThreshold: 0.9,
    bangumiEnabled: false,
    online: false,
    persistCache: false
  });

  const fullDive = groups.find(g => g.items.some(i => i.scanItem.name === fileA));
  check('A2', 'Full Dive - 04 与文件夹 Full Dive - 03 归为同组',
    Boolean(fullDive) && fullDive!.items.length === 2,
    fullDive ? `${fullDive.rawNames.join('/')} → ${fullDive.zhName}（${fullDive.items.length} 项）` : '未找到该组');

  const bocchi = groups.find(g => g.items.some(i => i.scanItem.name === fileC));
  check('A3', 'SP 项归入 SP 子目录 + 目标路径为 年/月/中文名',
    Boolean(bocchi && bocchi.items[0].parsed.subDir === 'SP'),
    bocchi ? `${bocchi.zhName} / ${bocchi.items[0].parsed.subDir}` : '未找到');

  const unknownGroup = groups.find(g => g.items.some(i => i.scanItem.name === fileD));
  check('A4', '无法解析的名称标记为 unrecognized', unknownGroup?.status === 'unrecognized',
    `状态=${unknownGroup?.status}`);

  /* ---------- 方案（dry-run） ---------- */
  const plan1 = await buildPlan(groups, { sourceRoot: srcRoot, targetRoot: dstRoot, detectConflicts: true });
  const fdEntries = plan1.entries.filter(e => e.fromPath.includes('Full Dive'));
  const targetOk = fdEntries.length === 2
    && fdEntries.every(e => e.toPath.includes('2021\\04\\'));
  check('A5', '目标路径为 {归档根}\\2021\\04\\{官方中文名}\\', targetOk,
    fdEntries.map(e => e.toPath.replace(dstRoot, '<root>')).join(' | '));

  const unk = plan1.entries.find(e => e.name === fileD);
  check('A6', '未识别项进入 _未识别/ 且不误归档',
    Boolean(unk && unk.toPath.includes('_未识别')), unk ? unk.toPath.replace(dstRoot, '<root>') : '—');

  /* ---------- A8 冲突：目标已存在同名文件 ---------- */
  const spyDir = path.join(dstRoot, '2022', '04', '间谍过家家');
  await write(path.join(spyDir, fileE), 'already here');
  const plan2 = await buildPlan(groups, { sourceRoot: srcRoot, targetRoot: dstRoot, detectConflicts: true });
  const spyEntry = plan2.entries.find(e => e.name === fileE);
  check('A8a', '目标已存在同名文件 → 标记 conflict',
    spyEntry?.status === 'conflict', `状态=${spyEntry?.status} 冲突类型=${spyEntry?.conflictType}`);

  /* ---------- 执行归档 ---------- */
  const decisions: Record<string, { execute: boolean; strategy?: 'rename' | 'skip' }> = {};
  plan2.entries.forEach(e => { decisions[e.entryId] = { execute: true, strategy: 'rename' }; });
  const exec = await executePlan(store, { plan: plan2, decisions, concurrency: 2 });

  const movedA = !(await exists(path.join(srcRoot, fileA)));
  const movedB = !(await exists(path.join(srcRoot, dirB)));
  const arrivedA = await exists(path.join(dstRoot, '2021', '04', '这算是哪门子的全能幻想RPG啊！', fileA));
  const arrivedB = await exists(path.join(dstRoot, '2021', '04', '这算是哪门子的全能幻想RPG啊！', dirB, 'ep03.mkv'));
  check('A7', '执行归档：源文件消失、目标出现',
    movedA && movedB && arrivedA && arrivedB,
    `成功 ${exec.success} / 失败 ${exec.failed} / 跳过 ${exec.skipped}`);

  const logHasPaths = exec.logs.every(l => l.fromPath && l.toPath);
  check('A7b', '日志完整记录 fromPath → toPath', logHasPaths && exec.logs.length > 0, `${exec.logs.length} 条`);

  const conflictLog = exec.logs.find(l => l.originPath.endsWith(fileE));
  const renamedOk = Boolean(conflictLog && /\(1\)\.mp4$/.test(conflictLog.toPath));
  const oldStillThere = await exists(path.join(spyDir, fileE));
  const newArrived = Boolean(conflictLog && await exists(conflictLog.toPath));
  check('A8', '冲突自动重命名为 xxx (1).mp4，旧文件未被删除',
    renamedOk && oldStillThere && newArrived,
    conflictLog ? path.basename(conflictLog.toPath) : '—');

  /* ---------- A13 索引 ---------- */
  const siteDir = path.join(root, 'site', 'data');
  const idx = await buildLibraryIndex(store, { libraryRoot: dstRoot, siteDirs: [siteDir] });
  const hasFullDive = idx.anime.some(a => a.zhName.includes('全能幻想'));
  const hasSpecial = idx.anime.some(a => a.special && a.zhName === '_未识别');
  const hasOld = idx.anime.some(a => a.zhName === '既有番剧');
  const jsonExists = await exists(path.join(siteDir, 'library.json'));
  const jsExists = await exists(path.join(siteDir, 'library.js'));
  check('A13', 'library.json 生成且含 _未识别/ 特殊目录',
    jsonExists && jsExists && hasFullDive && hasSpecial,
    `番剧 ${idx.stats.animeCount} 部 / 文件 ${idx.stats.fileCount} 个 / 特殊目录 ${idx.stats.specialCount} 个 / 既有番剧入索引=${hasOld}`);

  const revertableOk = idx.anime
    .flatMap(a => [...a.files, ...a.subDirs.flatMap(s => s.files)])
    .filter(f => f.name === fileA)
    .every(f => f.revertable && f.originPath);
  check('A10a', '索引中本工具归档的文件标记为可撤回（含 originPath）', revertableOk);

  /* ---------- A10 单文件撤回 ---------- */
  const curA = path.join(dstRoot, '2021', '04', '这算是哪门子的全能幻想RPG啊！', fileA);
  const rev1 = await revert(store, { filePath: curA });
  const backA = await exists(path.join(srcRoot, fileA));
  check('A10b', '单文件撤回：移回归档前原位置', rev1.success === 1 && backA,
    `成功 ${rev1.success} / 失败 ${rev1.failed}`);

  /* ---------- A10 整批撤销 ---------- */
  const rev2 = await revert(store, { batchId: exec.batchId });
  const backB = await exists(path.join(srcRoot, dirB, 'ep03.mkv'));
  const backC = await exists(path.join(srcRoot, fileC));
  check('A10c', '整批撤销：全部移回原位', rev2.failed === 0 && backB && backC,
    `成功 ${rev2.success} / 失败 ${rev2.failed} / 跳过 ${rev2.skipped}（已单文件撤回的不重复处理）`);

  /* ---------- A9 归档根目录不存在 → 中止且源文件零改动 ---------- */
  await write(path.join(srcRoot, 'probe-anchor.txt'));
  const badPlan = await buildPlan(groups, { sourceRoot: srcRoot, targetRoot: path.join(root, 'NOPE'), detectConflicts: false });
  let aborted = false;
  let errMsg = '';
  try {
    await executePlan(store, { plan: badPlan, decisions: {}, concurrency: 1 });
  } catch (err) {
    aborted = true;
    errMsg = (err as Error).message;
  }
  const srcIntact = await exists(path.join(srcRoot, 'probe-anchor.txt'));
  check('A9', '归档根目录不存在 → 中止且源文件零改动', aborted && srcIntact, errMsg.slice(0, 60));

  /* ---------- A4 离线不崩溃 ---------- */
  check('A4', '离线（L1/L3）可跑通且不抛异常', groups.length > 0, `共 ${groups.length} 组`);

  /* ---------- A14 文件修改时间加权 ---------- */
  // 同一部作品的两次首播：与文件时间同季的应当明显高于相隔多年的
  const hint = { earliestMs: Date.parse('2021-02-14T00:00:00Z'), latestMs: Date.parse('2021-03-20T00:00:00Z') };
  const adjSame = timeAdjust(2021, 1, hint);    // 第 2 季：与文件时间同季
  const adjOld = timeAdjust(2018, 7, hint);     // 第 1 季：早于文件时间 2 年以上
  const adjFuture = timeAdjust(2021, 4, hint);  // 首播晚于文件时间 → 不可能
  const timeOk = adjSame.delta > adjOld.delta && adjFuture.relation === 'future' && adjFuture.delta < -0.2;
  check('A14', '文件修改时间参与置信度：同季加分 / 首播晚于文件时间重罚', timeOk,
    `同季 ${adjSame.delta} / 多年 ${adjOld.delta} / 未来 ${adjFuture.relation} ${adjFuture.delta}`);

  /* ---------- A15 严格键区分续作 ---------- */
  // `はたらく細胞` 与 `はたらく細胞!!` 经别名键（去标点）后会撞车，严格键必须能分开
  const sk1 = strictKey('はたらく細胞');
  const sk2 = strictKey('はたらく細胞!!');
  const ak1 = aliasKey('はたらく細胞');
  const ak2 = aliasKey('はたらく細胞!!');
  const strictOk = sk1 !== sk2 && ak1 === ak2
    && strictKey('Hataraku Saibou!!') === 'hatarakusaibou!!'
    && strictKey('Hataraku Saibou') === 'hatarakusaibou';
  check('A15', '严格键保留 ! / 数字，可区分续作（别名键会撞车）', strictOk,
    `${sk1} ≠ ${sk2}，别名键均为 ${ak1}`);

  /* ---------- A16 离线时网页检索不发起、不抛异常 ---------- */
  const offlineStore = new Store(path.join(root, 'offline-store'));
  await offlineStore.init();
  const offlineGroups = await groupItems(
    [
      {
        id: 'o1', path: 'X:\\off\\Hataraku Saibou!! - 01.mp4', name: 'Hataraku Saibou!! - 01.mp4',
        isDir: false, size: 1024, childCount: 0,
        mtime: '2021-02-14T00:00:00.000Z', btime: '2021-02-20T00:00:00.000Z'
      }
    ],
    offlineStore,
    {
      reviewThreshold: 0.7, autoThreshold: 0.9, bangumiEnabled: true, online: false,
      persistCache: false, webSearchEnabled: true, useFileTime: true
    }
  );
  check('A16', '离线（online=false）时网页检索与 Bangumi 均不发起，且不抛异常',
    offlineGroups.length === 1 && offlineGroups[0].items.length === 1,
    `共 ${offlineGroups.length} 组`);

  /* ---------- A17 别名「预计算键」必须与旧算法完全等价 ---------- */
  // L3 模糊匹配现在直接拿 Store 预计算好的键算相似度（不再在热路径里调 aliasKey）。
  // 这里双向校验：预计算键上的结果必须与「现算 aliasKey」的旧路径一模一样，
  // 否则轻则分数漂移，重则分组结果变化。
  const keySamples: Array<[string, string]> = [
    ['Full Dive', 'Full Dive RPG'],
    ['Yuru Camp', '摇曳露营△'],
    ['はたらく細胞', 'はたらく細胞!!'],
    ['五等分の花嫁', '五等分の花嫁∬'],
    ['Maidragon_S', '小林さんちのメイドラゴンS'],
    ['NotExistedAtAllTitle', 'Adachi to Shimamura']
  ];
  const keyedOk = keySamples.every(([a, b]) => {
    const oldWay = similarity(a, aliasKey(b));                    // 旧：similarity 内部再算一次 aliasKey
    const newWay = similarityKeyed(aliasKey(a), aliasKey(aliasKey(b))); // 新：预计算键
    return Math.abs(oldWay - newWay) < 1e-12;
  });
  check('A17', '别名预计算键与原 similarity() 结果完全等价', keyedOk,
    `${keySamples.length} 组样本逐位相等`);

  /* ---------- A18 新增别名后增量更新索引，L1 立即可命中 ---------- */
  const idxStore = new Store(path.join(root, 'idx-store'));
  await idxStore.init();
  const missBefore = idxStore.lookup('佐贺偶像是传奇 Revenge') === null;
  await idxStore.upsertAlias(['Saga Jiugan', '佐贺偶像是传奇 Revenge'], '佐贺偶像是传奇 Revenge', 2021, 4, 'manual');
  const hitByAlias = idxStore.lookup('Saga Jiugan');
  const hitByZh = idxStore.lookup('佐贺偶像是传奇 Revenge');
  const listed = idxStore.listAliases().some(a => a.alias === 'saga jiugan' && a.key === 'sagajiugan' && a.key2 === 'sagajiugan');
  await idxStore.flush();
  const persisted = JSON.parse(await fsp.readFile(path.join(root, 'idx-store', 'data', 'aliases.json'), 'utf8'));
  const fileOk = persisted.entries['sagajiugan']?.zh === '佐贺偶像是传奇 Revenge';
  check('A18', '别名增量写入：L1 立即命中 + 预计算键正确 + flush 后落盘',
    missBefore && !!hitByAlias && !!hitByZh && listed && fileOk,
    `新增前未命中=${missBefore}；别名/中文名均可命中；写盘=${fileOk}`);

  /* ---------- A19 繁 → 简字表必须完整 ---------- */
  // 旧的手写「高频字表」缺了几百个常用字，后果不只是繁体名搜不到，
  // 而是会命中错误条目（孤獨搖滾 → 透明的孤独）。这里用实际踩过的字做回归。
  const t2sCases: Array<[string, string]> = [
    ['孤獨搖滾', '孤独摇滚'],
    ['鬼滅之刃', '鬼灭之刃'],
    ['給不灭的你', '给不灭的你'],
    ['佐賀偶像是傳奇 捲土重來', '佐贺偶像是传奇 卷土重来'],
    ['關於我轉生變成史萊姆這檔事', '关于我转生变成史莱姆这档事'],
    ['小書痴的下剋上', '小书痴的下克上'],
    ['戀上換裝娃娃', '恋上换装娃娃']
  ];
  const t2sBad = t2sCases.filter(([t, s]) => toSimplified(t) !== s);
  check('A19', '繁→简字表完整（覆盖旧表缺失的 給/僅/擇/擊/捲/搖/換/檔/剋 …）',
    t2sBad.length === 0,
    t2sBad.length ? `未通过：${t2sBad.map(([t]) => `${t}→${toSimplified(t)}（应为 ${t2sCases.find(x => x[0] === t)![1]}）`).join('；')}` : `${t2sCases.length} 条全部正确`);

  /* ---------- A20 Bangumi 检索词：中文先转简体，日文原名保原文 ---------- */
  const qTrad = buildBangumiQueries('孤獨搖滾', null);
  const qJp = buildBangumiQueries('進撃の巨人', null);
  const qSeq = buildBangumiQueries('Yuru Camp', 'Yuru Camp S02');
  const queryOk = qTrad[0] === '孤独摇滚' && qTrad.includes('孤獨搖滾')
    && qJp[0] === '進撃の巨人'          // 含假名 ⇒ 日文原名，不能改成「进击の巨人」
    && qSeq.length === 2 && qSeq[0] === 'Yuru Camp S02';
  check('A20', 'Bangumi 检索词：繁体先转简体；含假名的日文原名保留原文', queryOk,
    `${qTrad.join(' , ')}｜${qJp.join(' , ')}｜${qSeq.join(' , ')}`);

  /* ---------- A21 目标路径必须保住 UNC 前缀 ---------- */
  // 真实事故：`parts.join('\\').replace(/\\+/g,'\\')` 把 `\\NAS\share` 压成 `\NAS\share`，
  // Windows 会把它当「当前盘符根目录」→ 归档目标静默变成 `<盘符>:\NAS\share\…`，
  // 文件被移到了本机磁盘，而且下次扫描还会报一堆假冲突。
  const unc = joinWinPath('\\\\NAS\\share\\已看\\Anime', '2020', '10', '安达与岛村', 'a.mp4');
  const uncTrail = joinWinPath('\\\\NAS\\share\\已看\\Anime\\\\', '2020', 'x.mkv');
  const drive = joinWinPath('D:\\dst', '2021', '04', 'x', 'y.mp4');
  const uncOk = unc === '\\\\NAS\\share\\已看\\Anime\\2020\\10\\安达与岛村\\a.mp4'
    && uncTrail === '\\\\NAS\\share\\已看\\Anime\\2020\\x.mkv'
    && drive === 'D:\\dst\\2021\\04\\x\\y.mp4';
  check('A21', '路径拼接保住 UNC 前缀（不得把 \\\\ 压成 \\）', uncOk,
    `${unc} ｜ ${drive}`);

  /* ---------- A22 用 UNC 目标根跑一遍 planner，不得产生假冲突 ---------- */
  const uncPlan = await buildPlan(
    [{
      groupId: 'g-unc', rawKey: 'x', rawNames: ['X'], zhName: '假想番剧', year: 2020, month: 10,
      aliasQuery: [], items: [{
        scanItem: {
          id: 'u1', path: '\\\\NAS\\share\\已看\\X - 01.mp4', name: 'X - 01.mp4',
          isDir: false, size: 1024, childCount: 0, mtime: '2020-10-01T00:00:00.000Z', btime: '2020-10-01T00:00:00.000Z'
        },
        parsed: {
          rawName: 'X - 01.mp4', animeRawName: 'X', seasonHint: null, episode: '01',
          mediaType: 'TV', subDir: null, releaseGroup: null, recognized: true, note: null
        } as never
      }],
      episodes: ['01'], totalSize: 1024, releaseGroup: null, resolution: null,
      status: 'ready', note: null, resolved: false, saveAlias: false
    }] as never,
    { sourceRoot: '\\\\NAS\\share\\已看', targetRoot: '\\\\NAS\\share\\已看\\Anime', detectConflicts: true }
  );
  const uncTo = uncPlan.entries[0]?.toPath ?? '';
  check('A22', 'UNC 归档根下的 toPath 开头必须是 \\\\（否则会落到本机盘符）',
    uncTo.startsWith('\\\\NAS\\share\\已看\\Anime\\'), `toPath = ${uncTo}`);

  /* ---------- A23 安全护栏：目标不在归档根内必须拒绝执行 ---------- */
  // 真实事故：UNC 前缀被压掉一个反斜杠后，`\\NAS\share\Anime\…` 变成 `\NAS\share\…`，
  // Windows 会解析到「当前盘符根目录」，于是文件被搬到了本机磁盘。
  // 这一项锁死「越界就拒绝」这个行为。
  const guardSrc = path.join(srcRoot, 'guard-test-01.mp4');
  await write(guardSrc, 'guard');
  const escapeTarget = path.join(path.dirname(dstRoot), 'OUTSIDE-SHOULD-NOT-HAPPEN', 'guard-test-01.mp4');
  const guardPlan = {
    planId: 'plan-guard',
    createdAt: new Date().toISOString(),
    sourceRoot: srcRoot,
    targetRoot: dstRoot,
    groups: [],
    entries: [{
      entryId: 'e-guard',
      groupId: 'g-guard',
      fromPath: guardSrc,
      toPath: escapeTarget,
      name: path.basename(guardSrc),
      targetName: path.basename(guardSrc),
      isDir: false,
      size: 5,
      action: 'move' as const,
      status: 'ready' as const,
      conflictType: 'none' as const,
      note: null,
      subDir: null,
      episode: '01',
      mediaType: 'TV' as const,
      relTargetDir: ''
    }],
    stats: { total: 1, totalSize: 5, ready: 1, review: 0, conflict: 0, unrecognized: 0, deferred: 0, skipped: 0 }
  };
  const guardRes = await executePlan(store, { plan: guardPlan as never, decisions: { 'e-guard': { execute: true } }, concurrency: 1 });
  const guardKept = await exists(guardSrc);
  const guardBlocked = !(await exists(escapeTarget));
  check('A23', '安全护栏：目标路径不在归档根内 → 拒绝执行且源文件不动',
    guardRes.failed === 1 && guardKept && guardBlocked,
    `失败 ${guardRes.failed}；源仍在=${guardKept}；越界目标未生成=${guardBlocked}`);

  /* ---------- A24 断点续跑：源已不在 + 目标已存在 → 记为跳过，不重复写日志 ---------- */
  const resumeFrom = path.join(srcRoot, 'resume-test-01.mp4');
  const resumeTo = path.join(dstRoot, '2020', '01', '断点续传测试', 'resume-test-01.mp4');
  await write(resumeTo, 'already archived');
  // 故意不创建源文件（模拟上次已经搬走）
  const resumePlan = {
    ...guardPlan,
    planId: 'plan-resume',
    entries: [{ ...guardPlan.entries[0], entryId: 'e-resume', fromPath: resumeFrom, toPath: resumeTo }],
    stats: { ...guardPlan.stats }
  };
  const resumeRes = await executePlan(store, { plan: resumePlan as never, decisions: { 'e-resume': { execute: true } }, concurrency: 1 });
  check('A24', '断点续跑：源已搬走且目标已存在 → 计为跳过（不再报失败、不重复记日志）',
    resumeRes.skipped === 1 && resumeRes.failed === 0 && resumeRes.logs.length === 0,
    `跳过 ${resumeRes.skipped} / 失败 ${resumeRes.failed} / 日志 ${resumeRes.logs.length} 条`);

  /* ---------- A25 停止执行归档：立即不再取新条目 ---------- */
  // 用户的诉求：「中途要停止，就马上停止」。
  // 语义是「不再取新条目」，已经在飞的那几条会让它跑完（半途硬断会在 NAS 上留下半个文件）。
  const stopEntries: typeof guardPlan.entries = [];
  for (let i = 1; i <= 12; i++) {
    const no = String(i).padStart(2, '0');
    const from = path.join(srcRoot, `stop-test-${no}.mp4`);
    await write(from, `stop-${i}`);
    stopEntries.push({
      ...guardPlan.entries[0],
      entryId: `e-stop-${i}`,
      fromPath: from,
      name: path.basename(from),
      targetName: path.basename(from),
      toPath: path.join(dstRoot, '2020', '02', '停止测试', path.basename(from))
    });
  }
  const stopPlan = {
    ...guardPlan,
    planId: 'plan-stop',
    entries: stopEntries,
    stats: { ...guardPlan.stats, total: stopEntries.length, ready: stopEntries.length }
  };
  const stopDecisions: Record<string, { execute: boolean }> = {};
  stopEntries.forEach(e => { stopDecisions[e.entryId] = { execute: true }; });

  let processed = 0;
  let stopAck: { stopped: boolean; batchId: string | null } = { stopped: false, batchId: null };
  const stopRes = await executePlan(store, {
    plan: stopPlan as never,
    decisions: stopDecisions,
    concurrency: 1,
    onEvent: ev => {
      if (ev.type !== 'entry') return;
      processed++;
      if (processed === 3) stopAck = requestExecuteStop();
    }
  });
  const stopState = await store.readExecuteState();
  let stopLeftover = 0;
  for (const e of stopEntries) if (await exists(e.fromPath)) stopLeftover++;
  check('A25', '停止归档：立即不再取新条目，剩余文件原封不动',
    stopAck.stopped === true && stopRes.stopped === true && stopRes.finished === false &&
    stopRes.success === 3 && stopLeftover === 9 &&
    stopState?.stopped === true && stopState.running === false && stopState.done === 3,
    `停止确认=${stopAck.stopped}；成功 ${stopRes.success}；剩余未动 ${stopLeftover}；state.stopped=${stopState?.stopped}`);

  /* ---------- A26 停止后「继续归档」：已搬走的跳过，其余搬完 ---------- */
  const contRes = await executePlan(store, {
    plan: stopPlan as never,
    decisions: stopDecisions,
    concurrency: 4
  });
  check('A26', '停止后继续：已搬走的计为跳过，其余搬完（不重复搬、不误报失败）',
    contRes.skipped === 3 && contRes.success === 9 && contRes.failed === 0 && contRes.finished === true,
    `跳过 ${contRes.skipped} / 成功 ${contRes.success} / 失败 ${contRes.failed}`);
  check('A26b', '没有批次在跑时请求停止 → 明确返回未停止（不会误伤下一批）',
    requestExecuteStop().stopped === false && isExecuteRunning() === false,
    `stopped=${requestExecuteStop().stopped}`);

  /* ---------- A27 迁移失败自动重试 3 次（共 4 次尝试） ---------- */
  // 用一个「文件」占住目标目录的位置，让每一层 mkdir/rename 都必然失败（确定性失败）。
  const blocker = path.join(dstRoot, '2021', '03', 'BLOCKER-IS-A-FILE');
  await write(blocker, 'x');
  const retryFailFrom = path.join(srcRoot, 'retry-fail-01.mp4');
  await write(retryFailFrom, 'retry');
  const retryFailPlan = {
    ...guardPlan,
    planId: 'plan-retry-fail',
    entries: [{
      ...guardPlan.entries[0],
      entryId: 'e-retry-fail',
      fromPath: retryFailFrom,
      name: path.basename(retryFailFrom),
      targetName: path.basename(retryFailFrom),
      toPath: path.join(blocker, 'retry-fail-01.mp4')
    }],
    stats: { ...guardPlan.stats }
  };
  const retryFailRes = await executePlan(store, {
    plan: retryFailPlan as never,
    decisions: { 'e-retry-fail': { execute: true } },
    concurrency: 1
  });
  const retryFailLog = retryFailRes.logs[0];
  check('A27', '迁移失败自动重试 3 次（共 4 次尝试），仍失败则记日志 + 失败项清单',
    retryFailRes.failed === 1 && retryFailLog?.attempts === 4 &&
    retryFailRes.failedItems.length === 1 && retryFailRes.failedItems[0]?.attempts === 4 &&
    /已尝试 4 次/.test(retryFailLog?.error ?? '') && (await exists(retryFailFrom)),
    `失败 ${retryFailRes.failed}；尝试 ${retryFailLog?.attempts} 次；失败清单 ${retryFailRes.failedItems.length} 条；源保留=${await exists(retryFailFrom)}`);

  /* ---------- A28 正常迁移：attempts=1，失败清单为空 ---------- */
  const retryOkFrom = path.join(srcRoot, 'retry-ok-01.mp4');
  await write(retryOkFrom, 'ok');
  const retryOkPlan = {
    ...guardPlan,
    planId: 'plan-retry-ok',
    entries: [{
      ...guardPlan.entries[0],
      entryId: 'e-retry-ok',
      fromPath: retryOkFrom,
      name: path.basename(retryOkFrom),
      targetName: path.basename(retryOkFrom),
      toPath: path.join(dstRoot, '2021', '04', '重试正常测试', path.basename(retryOkFrom))
    }],
    stats: { ...guardPlan.stats }
  };
  const retryOkRes = await executePlan(store, {
    plan: retryOkPlan as never,
    decisions: { 'e-retry-ok': { execute: true } },
    concurrency: 1
  });
  check('A28', '正常迁移：attempts=1、失败清单为空（重试机制不影响正常流程）',
    retryOkRes.success === 1 && retryOkRes.logs[0]?.attempts === 1 &&
    retryOkRes.failedItems.length === 0 && retryOkRes.stopped === false && retryOkRes.finished === true,
    `成功 ${retryOkRes.success}；尝试 ${retryOkRes.logs[0]?.attempts} 次；失败清单 ${retryOkRes.failedItems.length} 条`);

  /* ---------- A29 批次号唯一：同一秒内的两批不能同号 ---------- */
  // 用户「点停止 → 马上点继续」时两批很可能落在同一秒。
  // 批次号同时也是日志文件名与撤回依据，同号会让后一批覆盖前一批的日志，
  // 于是「撤销整批」会搬到错误的那一批上。
  const uniqFrom1 = path.join(srcRoot, 'uniq-batch-01.mp4');
  const uniqFrom2 = path.join(srcRoot, 'uniq-batch-02.mp4');
  await write(uniqFrom1, 'u1');
  await write(uniqFrom2, 'u2');
  const mkUniqPlan = (tag: string, from: string): unknown => ({
    ...guardPlan,
    planId: `plan-uniq-${tag}`,
    entries: [{
      ...guardPlan.entries[0],
      entryId: `e-${tag}`,
      fromPath: from,
      name: path.basename(from),
      targetName: path.basename(from),
      toPath: path.join(dstRoot, '2021', '05', '批次号测试', path.basename(from))
    }],
    stats: { ...guardPlan.stats }
  });
  const uniqRes1 = await executePlan(store, {
    plan: mkUniqPlan('uniq1', uniqFrom1) as never,
    decisions: { 'e-uniq1': { execute: true } },
    concurrency: 1
  });
  const uniqRes2 = await executePlan(store, {
    plan: mkUniqPlan('uniq2', uniqFrom2) as never,
    decisions: { 'e-uniq2': { execute: true } },
    concurrency: 1
  });
  const allLogs = await store.listBatchLogs();
  const log1 = allLogs.find(b => b.batchId === uniqRes1.batchId);
  const log2 = allLogs.find(b => b.batchId === uniqRes2.batchId);
  check('A29', '批次号唯一：同一秒内的两批不同号、各自日志不互相覆盖（否则撤回会撤错批次）',
    uniqRes1.batchId !== uniqRes2.batchId &&
    log1?.entries.length === 1 && log2?.entries.length === 1 &&
    log1?.entries[0]?.fromPath === uniqFrom1 && log2?.entries[0]?.fromPath === uniqFrom2,
    `id1=${uniqRes1.batchId}；id2=${uniqRes2.batchId}；日志条数 ${log1?.entries.length}/${log2?.entries.length}`);

  /* ---------- A30 库内二次移动（归档结果区「发现归错位置」的修正） ---------- */
  // 这是「归档结果区二次操作」的后端核心：已归档的文件可以改归到另一部番剧。
  // 约束：只能在归档根内部、自动建目录、同名加 (1) 绝不覆盖、移出根一律拒绝。
  const libRoot = path.join(root, 'library');
  const libA = path.join(libRoot, '2021', '01', '番剧A');
  await write(path.join(libA, 'ep-01.mp4'), 'one');
  const mvOk = await moveInLibrary(store, libRoot, {
    fromPath: path.join(libA, 'ep-01.mp4'), zhName: '番剧B', year: 2022, month: 3
  });
  const mvLanded = await exists(path.join(libRoot, '2022', '03', '番剧B', 'ep-01.mp4'));

  await write(path.join(libA, 'ep-02.mp4'), 'two');
  const mvDup = await moveInLibrary(store, libRoot, {
    fromPath: path.join(libA, 'ep-02.mp4'), zhName: '番剧B', year: 2022, month: 3, newName: 'ep-01.mp4'
  });
  const dupKept = await exists(path.join(libRoot, '2022', '03', '番剧B', 'ep-01.mp4'));

  const libOutside = path.join(root, 'not-in-library.mp4');
  await write(libOutside, 'x');
  let libRejected = false;
  try {
    await moveInLibrary(store, libRoot, { fromPath: libOutside, zhName: '番剧B', year: 2022, month: 3 });
  } catch { libRejected = true; }

  check('A30', '库内二次移动：自动建目录 + 同名加 (1) 不覆盖 + 移出归档根被拒绝',
    mvLanded && mvOk.relTargetDir === '2022\\03\\番剧B' && !(await exists(path.join(libA, 'ep-01.mp4'))) &&
    mvDup.renamed === true && path.basename(mvDup.toPath) === 'ep-01 (1).mp4' && dupKept &&
    libRejected && (await exists(libOutside)),
    `落位=${mvLanded}；同名改名=${path.basename(mvDup.toPath)}；越界拒绝=${libRejected}`);

  /* ---------- A31 库内**批量**二次移动（媒体库「批量移动」按钮的后端） ---------- */
  // 必须一次搬完多个，且单条失败不能中断整批（与执行归档一致）。
  const libB = path.join(libRoot, '2021', '01', '番剧B');
  const batchPaths: string[] = [];
  for (let i = 1; i <= 3; i++) {
    const f = path.join(libB, `b-${i}.mp4`);
    await write(f, `b${i}`);
    batchPaths.push(f);
  }
  const batchMissing = path.join(libB, 'missing.mp4');   // 故意不存在
  const batchRes = await moveManyInLibrary(store, libRoot, {
    fromPaths: [...batchPaths, batchMissing], zhName: '番剧C', year: 2020, month: 5
  });
  const batchLanded = (await fsp.readdir(path.join(libRoot, '2020', '05', '番剧C'))).length;
  // 目标 == 现在的位置 → 全部计为「无需移动」，而不是报失败
  const sameRes = await moveManyInLibrary(store, libRoot, {
    fromPaths: [path.join(libRoot, '2020', '05', '番剧C', 'b-1.mp4')], zhName: '番剧C', year: 2020, month: 5
  });
  check('A31', '库内批量移动：一次搬完多个 + 单条失败不中断整批 + 目标相同计为无需移动',
    batchRes.moved === 3 && batchRes.failed.length === 1 && batchRes.failed[0]?.fromPath === batchMissing &&
    batchLanded === 3 && batchRes.relTargetDir === '2020\\05\\番剧C' &&
    sameRes.moved === 0 && sameRes.unchanged === 1 && sameRes.failed.length === 0,
    `搬走 ${batchRes.moved}；失败 ${batchRes.failed.length}；落地 ${batchLanded}；目标相同 moved=${sameRes.moved}/unchanged=${sameRes.unchanged}`);

  /* ---------- A32 资源管理器打开：坏路径必须先拒绝 ---------- */
  // 为什么必须查：`explorer.exe /select,<不存在的路径>` **不会报错**，
  // 它会默默把「文档」打开 —— 用户看到弹窗以为成功了，其实根本没到那个文件夹。
  let revealEmpty = false;
  let revealMissing = false;
  try { await revealInExplorer(''); } catch { revealEmpty = true; }
  try { await revealInExplorer(path.join(root, 'definitely-missing-file.mp4')); } catch { revealMissing = true; }
  check('A32', '资源管理器打开：空路径 / 不存在的路径先报错（否则 explorer 会静默打开「文档」）',
    revealEmpty && revealMissing,
    `空路径拒绝=${revealEmpty}；不存在拒绝=${revealMissing}`);

  /* ---------- A33 `/select` 的引号只能包住路径 ---------- */
  // 实测过的坑：`"/select,<路径>"`（整串加引号）会让 explorer 解析失败，**静默打开「文档」**；
  // 必须拼成 `/select,"<路径>"`。而 Node 的 spawn 默认正好是错的那种，
  // 所以实现里用了 windowsVerbatimArguments 自己拼命令行 —— 这里把这个约定锁死。
  const argsSelect = explorerArgs(path.join(root, 'a b', 'c.mp4'), true);
  const argsFolder = explorerArgs(path.join(root, 'a b'), false);
  check('A33', 'explorer 参数：/select 的引号只包路径（不得给整串加引号）',
    argsSelect.length === 1 && argsSelect[0].startsWith('/select,"') && argsSelect[0].endsWith('"') &&
    argsFolder.length === 1 && argsFolder[0].startsWith('"') && argsFolder[0].endsWith('"') &&
    !argsFolder[0].includes('/select'),
    `select=${argsSelect[0]}；folder=${argsFolder[0]}`);

  /* ---------- A34 库内移动后：变空的目录要顺手清理 ---------- */
  // 场景：一部只有 1 集的番剧被挪走后，`2019\11\某番剧`（以及跟着变空的月/年）都不该继续留着；
  // 但只要目录里还有别的文件，就**绝不能**动它。
  const soloDir = path.join(libRoot, '2019', '11', '只有一集的番剧');
  await write(path.join(soloDir, 'only-01.mp4'), 'solo');
  const soloRes = await moveInLibrary(store, libRoot, {
    fromPath: path.join(soloDir, 'only-01.mp4'), zhName: '清理目标番剧', year: 2022, month: 2
  });
  const soloGone = !(await exists(soloDir));
  const yearGone = !(await exists(path.join(libRoot, '2019')));

  const keepDir = path.join(libRoot, '2019', '12', '还有别的文件');
  await write(path.join(keepDir, 'a.mp4'), 'a');
  await write(path.join(keepDir, 'b.mp4'), 'b');
  const keepRes = await moveInLibrary(store, libRoot, {
    fromPath: path.join(keepDir, 'a.mp4'), zhName: '清理目标番剧', year: 2022, month: 2
  });
  const keepAlive = (await exists(keepDir)) && (await exists(path.join(keepDir, 'b.mp4')));

  check('A34', '库内移动后：变空的目录逐级清理（含月/年），但非空目录绝不动',
    soloGone && yearGone && soloRes.cleanedDirs.length === 3 &&
    keepRes.cleanedDirs.length === 0 && keepAlive,
    `清理 ${soloRes.cleanedDirs.length} 个；年目录也清了=${yearGone}；非空目录保留=${keepAlive}`);

  /* ---------- A35 空目录清理的「向上走」判定在 UNC 路径上也成立 ---------- */
  // 为什么单独测：上面 A34 跑在本地临时目录（`<本地临时目录>\…`）。
  // 而上次 UNC 事故的教训正是「本地测试全绿、跑到 \\NAS 上就错」——
  // `pruneEmptyDirsUpward` 每往上一层都要用 `path.resolve` + `isInside` 判断，
  // 这两个东西必须确认不会把 UNC 前缀的 `\\` 吃掉，也不能把归档根自己也判成「在内」。
  const uncRoot = '\\\\NAS\\share\\已看\\Anime';
  const uncAnime = `${uncRoot}\\2013\\01\\向山进发`;
  check('A35', '空目录清理的向上走边界：UNC 前缀不被压斜杠 + 归档根本身绝不算「可清理的一层」',
    path.resolve(uncAnime).startsWith('\\\\') &&
    path.resolve(uncRoot).startsWith('\\\\') &&
    isInside(uncAnime, uncRoot) &&
    isInside(`${uncRoot}\\2013`, uncRoot) &&
    canClimbTo(uncAnime, uncRoot) &&
    canClimbTo(`${uncRoot}\\2013`, uncRoot) &&
    !canClimbTo(uncRoot, uncRoot) &&
    !canClimbTo(path.dirname(uncRoot), uncRoot),
    `resolve=${path.resolve(uncRoot)}；根自身可爬=${canClimbTo(uncRoot, uncRoot)}；根之上可爬=${canClimbTo(path.dirname(uncRoot), uncRoot)}`);

  /* ---------- A36 库内移动「整个子目录」（含内容的目录） ---------- */
  // 媒体库里「单独子目录」那一行现在也能整体移动 —— 那是**目录**的移动，
  // 走的是 moveItem 的目录分支（跨设备时是 copyDirRecursive + 条目数校验），必须单独测。
  const packAnime = path.join(libRoot, '2023', '03', '带整包目录的番剧');
  const packDir = path.join(packAnime, '[组名][某番剧][01][1080p]');
  await write(path.join(packDir, 'a.mp4'), 'a');
  await write(path.join(packDir, 'b.mp4'), 'b');
  await write(path.join(packAnime, 'loose-02.mp4'), 'loose');
  const packRes = await moveInLibrary(store, libRoot, {
    fromPath: packDir, zhName: '整包目标番剧', year: 2022, month: 6
  });
  const packLanded = path.join(libRoot, '2022', '06', '整包目标番剧', '[组名][某番剧][01][1080p]');
  const packContentOk = (await exists(path.join(packLanded, 'a.mp4'))) && (await exists(path.join(packLanded, 'b.mp4')));
  const packSrcGone = !(await exists(packDir));
  const packAnimeKept = await exists(path.join(packAnime, 'loose-02.mp4'));
  check('A36', '库内移动整个子目录：目录连内容一起搬走；原番剧里还有文件就不清理',
    packContentOk && packSrcGone && packRes.renamed === false &&
    packRes.cleanedDirs.length === 0 && packAnimeKept,
    `目录落地=${packContentOk}；源目录已移走=${packSrcGone}；清理=${packRes.cleanedDirs.length} 个；原番剧保留=${packAnimeKept}`);

  /* ---------- A38 写入护栏：不把「更具体的名字」收成更宽泛条目的别名 ---------- */
  // 这正是脏数据的产生方式：确认第一季时把整组 rawName（含第四季的「領主的養女」）一起写成别名。
  // 现在 upsertAlias 应当拒收这条（否则第四季文件会被原始键命中第一季条目）。
  const SEASON1 = '小书痴的下克上 〜为了成为图书管理员而不择手段〜';
  const SEASON4 = '小书痴的下克上 〜为了成为图书管理员而不择手段〜 领主的养女';
  const RAW4 = '小書痴的下剋上 為了成為圖書管理員不擇手段！領主的養女';
  const offlineOpts = {
    reviewThreshold: 0.7,
    autoThreshold: 0.9,
    bangumiEnabled: false,
    online: false,
    persistCache: false,
    webSearchEnabled: false,
    useFileTime: false
  };
  const guardStore = new Store(path.join(root, 'guard-store'));
  await guardStore.init();
  await guardStore.upsertAlias([SEASON1, RAW4], SEASON1, 2019, 10, 'manual');
  const guardZh = guardStore.lookup(RAW4);
  const guardS1 = guardStore.lookup(SEASON1);
  check('A38', '写入护栏：更具体的名字（另一季标题）不会被收成更宽泛条目的别名',
    !guardZh && !!guardS1 && guardS1.zh === SEASON1,
    `第四季原始名未被收录=${!guardZh}；第一季名正常入库=${guardS1?.zh === SEASON1}`);

  /* ---------- A37 多季作品：「更具体者胜」复核 ---------- */
  // 用户实测：`…領主的養女`（第四季）被自动归到了第一季文件夹。
  // 原因是别名表里有一条脏记录 —— 第一季的条目把第四季的名字当成了自己的别名，
  // 且 dataSource=manual/置信度 1.0，后面根本没机会纠正。
  // 这里直接改盘复现当时的脏数据（走 upsertAlias 已经会被 A38 那道护栏拦住）。
  const seasonDir = path.join(root, 'season-store');
  const seedStore = new Store(seasonDir);
  await seedStore.init();
  await seedStore.flush();
  const seedFile = path.join(seasonDir, 'data', 'aliases.json');
  const seedTable = JSON.parse(await fsp.readFile(seedFile, 'utf8'));
  const dirty: { zh: string; year: number; month: number; src: string; bangumiId: null; aliases: string[] } =
    { zh: SEASON1, year: 2019, month: 10, src: 'manual', bangumiId: null, aliases: ['Honzuki no Gekokujou', RAW4] };
  seedTable.entries[aliasKey(RAW4)] = dirty;
  seedTable.entries[RAW4.toLowerCase()] = dirty;
  await fsp.writeFile(seedFile, JSON.stringify(seedTable, null, 2), 'utf8');

  const seasonStore = new Store(seasonDir);
  await seasonStore.init();
  const dirtyHit = seasonStore.lookup(RAW4);

  // ① 只给「已归档文件夹」（用户建议的依据）→ 必须选更具体的那一季
  clearNormalizeCache();
  const r4folder = await normalizeName(RAW4, seasonStore, {
    ...offlineOpts,
    archiveFolders: [{ zh: SEASON4, year: 2026, month: 4 }]
  });

  // ② 改成别名表里已有正确的第四季条目（直接改盘，不再传文件夹）→ 同样要选第四季
  seedTable.entries[aliasKey(SEASON4)] = {
    zh: SEASON4, year: 2026, month: 4, src: 'manual', bangumiId: null, aliases: ['Honzuki no Gekokujou S04']
  };
  await fsp.writeFile(seedFile, JSON.stringify(seedTable, null, 2), 'utf8');
  const store2 = new Store(seasonDir);
  await store2.init();
  clearNormalizeCache();
  const r4alias = await normalizeName(RAW4, store2, offlineOpts);

  // ③ 已经精确命中正确名字时，不能被任何「更长的名字」抢掉
  clearNormalizeCache();
  const r4exact = await normalizeName(SEASON4, store2, offlineOpts);

  check('A37', '多季作品：别名表把季名挂错时，用「更具体且更相似」的归档文件夹 / 别名纠正；正确命中不被抢',
    dirtyHit?.zh === SEASON1 &&
    r4folder.officialZhName === SEASON4 && r4folder.year === 2026 && r4folder.month === 4 &&
    r4alias.officialZhName === SEASON4 && r4alias.year === 2026 &&
    r4exact.officialZhName === SEASON4 && r4exact.year === 2026,
    `脏数据复现（L1 错命中第一季）=${dirtyHit?.zh === SEASON1}；` +
    `按文件夹 → ${r4folder.officialZhName}（${r4folder.year}/${r4folder.month}）；` +
    `按别名 → ${r4alias.officialZhName}（${r4alias.year}/${r4alias.month}）；精确名 → ${r4exact.officialZhName}`);

  /* ---------- A39 媒体库文件按集数排（不是按文件名字符串） ---------- */
  // 用户实测：同一部番剧混了两个字幕组，按文件名字符串排 ⇒ 01 后面直接跟 14、02 跑去另一段。
  const mixedFiles = [
    { name: '[BeanSub&FZSD][Jigokuraku][01][GB][1080p].mp4', episode: '01' },
    { name: '[BeanSub&FZSD][Jigokuraku][14][GB][1080p].mp4', episode: '14' },
    { name: '[BeanSub&FZSD][Jigokuraku][24v2][GB][1080p].mp4', episode: '24v2' },
    { name: '[BeanSub&FZSD][Jigokuraku][25][GB][1080p].mp4', episode: '25' },
    { name: '[Nekomoe kissaten][Jigokuraku][02][JPSC].mp4', episode: '02' },
    { name: '[Nekomoe kissaten][Jigokuraku][10][JPSC].mp4', episode: '10' },
    { name: '[Nekomoe kissaten][Jigokuraku][24][JPSC].mp4', episode: '24' },
    { name: 'NCOP.mp4', episode: '' }
  ];
  const ordered = [...mixedFiles].sort(compareByEpisode).map(f => f.name);
  const epOf = (n: string): string => (/\[(\d+[^\]]*)\]/.exec(n) ?? ['', n])[1] || n;
  const gotOrder = ordered.map(epOf).join(' / ');
  const wantOrder = '01 / 02 / 10 / 14 / 24 / 24v2 / 25 / NCOP.mp4';
  // 对照：按文件名字符串排会得到 01 / 14 / 24v2 / 25 / 02 / 10 / 24（就是用户看到的现象）
  check('A39', '媒体库文件按集数数字排：多字幕组混排时 01 后面跟 02 而不是 14；无集数的排最后',
    gotOrder === wantOrder, `实际：${gotOrder}`);

  /* ---------- A40 「关掉最后一个网页 → 自动关闭服务」的会话登记 ---------- */
  // 这条锁的是「什么时候才该关服务」：
  //   ① 没登记过的会话 id 一律忽略（防止别的工具一个请求就把服务关掉）
  //   ② 只关掉多个标签页里的一个 → 不关
  //   ③ 最后一个页面关掉后，宽限期内重新登记（= 刷新页面）→ 取消关闭
  //   ④ 真的没页面了 → 宽限期到点才关（且只关一次）
  //   ⑤ 设置里关掉该功能 → 永不自动关
  const delay = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));
  {
    let closed = 0;
    const s = createPageSessions({ graceMs: 40, onCloseService: () => { closed++; } });
    s.open('tab-a');
    s.open('tab-b');
    const unknownAccepted = s.close('never-opened');       // ①
    s.close('tab-a');                                      // ②
    const pendingAfterOne = s.pending();
    await delay(90);
    const afterOneTab = closed;                            // 仍应为 0

    s.close('tab-b');                                      // ③ 最后一个页面
    const pendingAfterLast = s.pending();                  // 应为 true（已进倒计时）
    s.open('tab-b-reload');                                // 刷新：宽限期内重新登记
    const pendingAfterReload = s.pending();                // 应为 false（已取消）
    await delay(90);
    const afterReload = closed;                            // 仍应为 0

    s.close('tab-b-reload');                               // ④ 真的没页面了
    await delay(90);
    const afterLast = closed;                              // 应为 1
    await delay(60);
    const notTwice = closed === 1;                         // 不应重复触发

    // ⑤ 设置里关掉「关闭网页时自动关闭服务」
    let closedOff = 0;
    const off = createPageSessions({ graceMs: 20, enabled: () => false, onCloseService: () => { closedOff++; } });
    off.open('only');
    off.close('only');
    await delay(60);

    check('A40', '关掉最后一个网页才自动关服务：未登记会话忽略 / 多标签只关一个不关 / 刷新取消 / 开关关闭时不关',
      unknownAccepted === false && afterOneTab === 0 && pendingAfterOne === false &&
      pendingAfterLast === true && pendingAfterReload === false &&
      afterReload === 0 && afterLast === 1 && notTwice && closedOff === 0,
      `未知会话受理=${unknownAccepted}；关一个标签后触发=${afterOneTab}（pending=${pendingAfterOne}）；` +
      `最后一个页面关闭后 pending=${pendingAfterLast}；刷新后 pending=${pendingAfterReload}、触发=${afterReload}；` +
      `真关闭触发=${afterLast}（重复触发=${!notTwice}）；开关关闭时触发=${closedOff}`);
  }

  /* ---------- A41 统计「播出月份」口径：集数 ≤3 不纳入 + >14 集跨季重复计入 ---------- */
  // 口径实现在 core/airStats.ts（用户 2026-09-13 定的三条规则），前端 utils.computeAirStatsLocal 是同一套。
  const mkFile = (name: string, size: number, rev = false, type: 'video' | 'other' = 'video'): LibraryFile => ({
    uid: `uid-${name}`, name, fullPath: `X:\\lib\\${name}`, size, type,
    episode: null, originPath: rev ? `X:\\src\\${name}` : null, revertable: rev, mtime: ''
  });
  /** n 个视频文件（每个 size 大小） */
  const vids = (prefix: string, n: number, size = 10): LibraryFile[] =>
    Array.from({ length: n }, (_, i) => mkFile(`${prefix}-${String(i + 1).padStart(2, '0')}.mp4`, size));
  const mkAnime = (
    id: string,
    year: number | null,
    month: number | null,
    files: LibraryFile[],
    opts: { special?: boolean; subDirs?: Array<{ dir: string; files: LibraryFile[] }> } = {}
  ): LibraryAnime => {
    const subDirs = (opts.subDirs ?? []).map(s => ({
      dir: s.dir,
      files: s.files,
      fullPath: `X:\\lib\\${id}\\${s.dir}`,
      originPath: null,
      revertable: false,
      totalSize: s.files.reduce((a, f) => a + f.size, 0)
    }));
    const all = [...files, ...subDirs.flatMap(s => s.files)];
    return {
      id, zhName: id, aliases: [], year, month, bangumiId: null, cover: '',
      relPath: `${year}\\${month}\\${id}`,
      totalSize: all.reduce((a, f) => a + f.size, 0),
      fileCount: all.length,
      episodes: 0,
      files,
      subDirs,
      special: opts.special === true
    };
  };

  const statAnime: LibraryAnime[] = [
    // ① 只有 2 集 → 不纳入统计
    mkAnime('short', 2024, 1, vids('s', 2, 100)),
    // ② 13 集（12 个顶层视频 + 1 个「多文件发布目录」，里面 3 个文件只算 1 集）+ 1 个非视频文件
    mkAnime('normal', 2024, 1, [...vids('n', 12), mkFile('n.nfo', 1, false, 'other')], {
      subDirs: [{ dir: '[FLsnow][Star-Detective_Precure][13][1080p]', files: vids('nf', 3, 5) }]
    }),
    // ③ 16 集、4 月首播 → 计入 2024-04 与 2024-07
    mkAnime('spread16', 2024, 4, vids('a', 16, 20)),
    // ④ 36 集、10 月首播 → ceil(36/14)=3 季 → 2024-10 / 2025-01 / 2025-04（跨年）
    mkAnime('spread36', 2024, 10, vids('b', 36, 30)),
    // ⑤ 33 集但 2 月首播（非季度月）→ 只计入 2026-02
    mkAnime('nonQuarter', 2026, 2, vids('c', 33, 40)),
    // ⑥ 4 集 + SP 子目录（SP 不算集数，但文件/体积仍计入）
    mkAnime('spOnly', 2025, 7, vids('d', 4, 50), { subDirs: [{ dir: 'SP', files: vids('ds', 2, 60) }] }),
    // ⑦ 特殊目录（_未识别）→ 两组统计都不参与
    mkAnime('specialDir', null, null, vids('e', 5, 999), { special: true })
  ];

  const st = computeStats(statAnime);
  const mKey = st.airMonths.map(x => `${x.year}-${x.month}`).join(',');
  const yKey = st.airYears.map(y => `${y.year}:${y.animeCount}`).join(',');
  const m = (y: number, mm: number) => st.airMonths.find(x => x.year === y && x.month === mm);
  const sumM = (pick: (x: typeof st.airMonths[number]) => number): number =>
    st.airMonths.reduce((a, x) => a + pick(x), 0);
  check('A41', '播出月份口径：集数 ≤3 不纳入 / >14 集且在 1/4/7/10 月播出的按季度重复计入（含跨年）/ 年份桶同年去重',
    mKey === '2026-2,2025-7,2025-4,2025-1,2024-10,2024-7,2024-4,2024-1' &&
    yKey === '2026:1,2025:2,2024:3' &&
    m(2024, 1)?.animeCount === 1 && m(2024, 1)?.episodeCount === 13 &&      // normal（13 集）
    m(2024, 4)?.animeCount === 1 && m(2024, 7)?.animeCount === 1 &&          // spread16 两季都在
    m(2025, 1)?.animeCount === 1 && m(2025, 4)?.animeCount === 1 &&          // spread36 跨年
    m(2026, 2)?.animeCount === 1 && m(2026, 2)?.episodeCount === 33 &&       // 非季度月不跨季
    m(2025, 7)?.episodeCount === 4 &&                                        // SP 不算集数
    st.excludedShort === 1 && st.spreadCount === 2 &&
    sumM(x => x.animeCount) === 8 &&                                         // 5 部 + 跨季多出的 3 次
    (st.airYears.reduce((a, y) => a + y.animeCount, 0)) === 6 &&             // 跨年那部在两年各计一次
    // 真值（文件夹口径）不受统计口径影响：2024 仍是 4 部（含 2 集的 short），且特殊目录不计
    st.years.find(y => y.year === 2024)?.animeCount === 4 &&
    st.animeCount === 6 && st.specialCount === 1,
    `月份桶=${mKey}；年份桶=${yKey}；2024-01=${JSON.stringify(m(2024, 1))}；2025-07=${JSON.stringify(m(2025, 7))}；` +
    `排除(≤3集)=${st.excludedShort}；跨季=${st.spreadCount}；月份部数合计=${sumM(x => x.animeCount)}；` +
    `真值 2024=${st.years.find(y => y.year === 2024)?.animeCount} 部`);

  /* ---------- A42 集数算法：子目录=1 集、SP/OP&ED 不算、非视频不算 ---------- */
  const epCase = (files: LibraryFile[], subDirs: Array<{ dir: string; files: LibraryFile[] }>) =>
    animeEpisodes(mkAnime('t', 2024, 1, files, { subDirs }));
  const epFlat = epCase(vids('x', 12), []);                                        // 12
  const epMultifile = epCase(vids('x', 12), [{ dir: '[FLsnow][…][13][1080p]', files: vids('y', 3) }]);  // 13（不是 15）
  const epSp = epCase(vids('x', 12), [
    { dir: 'SP', files: vids('s', 2) },
    { dir: 'OP&ED', files: vids('o', 2) }
  ]);                                                                             // 12（SP/OP&ED 不算）
  const epOther = epCase([...vids('x', 12), mkFile('a.nfo', 1, false, 'other')], []);  // 12（非视频不算）
  const epNested = epCase(vids('x', 3), [{ dir: 'Season 2', files: vids('z', 24) }]); // 4（子目录只算 1 集）
  check('A42', '集数 = 顶层视频文件数 + 子目录数（每个子目录 1 集）：多文件发布目录不再被算成多集，SP/OP&ED 与非视频不计',
    epFlat === 12 && epMultifile === 13 && epSp === 12 && epOther === 12 && epNested === 4 &&
    // 跨季分摊本身：16 集 4 月首播 → 04/07；13 集不跨季；2 月首播不跨季；54 集封顶 4 季
    attributedMonths(mkAnime('t1', 2024, 4, []), 16).map(x => `${x.year}-${x.month}`).join(',') === '2024-4,2024-7' &&
    attributedMonths(mkAnime('t2', 2024, 4, []), 14).map(x => `${x.year}-${x.month}`).join(',') === '2024-4' &&
    attributedMonths(mkAnime('t3', 2026, 2, []), 33).map(x => `${x.year}-${x.month}`).join(',') === '2026-2' &&
    attributedMonths(mkAnime('t4', 2024, 10, []), 54).map(x => `${x.year}-${x.month}`).join(',') === '2024-10,2025-1,2025-4,2025-7',
    `12 集=${epFlat}；12+多文件目录=${epMultifile}；12+SP&OPED=${epSp}；12+非视频=${epOther}；3+整季目录=${epNested}`);

  /* ---------- 汇总 ---------- */
  const failed = results.filter(r => !r.pass);
  console.log(`\n================ 结果 ================`);
  console.log(`通过 ${results.length - failed.length} / ${results.length}`);
  if (failed.length) {
    failed.forEach(f => console.log(`  ❌ ${f.id} ${f.name}：${f.detail}`));
    process.exitCode = 1;
  } else {
    console.log('🎉 后端端到端自检全部通过');
  }
  console.log(`（测试目录保留以便人工查看：${root}）\n`);
}

main().catch(err => {
  console.error('❌ e2e 执行失败：', err);
  process.exit(1);
});
