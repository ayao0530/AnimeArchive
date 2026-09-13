import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useApp } from '../store';
import { api } from '../api/client';
import type { LibraryAnime, LibraryFile, LibrarySubDir, MonthStat } from '../types';
import {
  allLibraryFiles, compareByEpisode, formatDateTime, formatSize, formatTime, highlight,
  isTextSelecting, joinWinPath, matchAnime, pad, padEpisode, parseQuery
} from '../utils';
import { RenameDialog } from '../components/Dialogs';
import { EntryMoveHost, type MoveEntry } from '../components/EntryMove';

export default function LibraryView() {
  return (
    <>
      <LibToolbar />
      <main className="layout">
        <LibListPanel />
        <LibStatsPanel />
      </main>
    </>
  );
}

/* =========================================================
   工具条（检索只作用于媒体库）
   ========================================================= */

function LibToolbar() {
  const libQuery = useApp(s => s.libQuery);
  const setLibQuery = useApp(s => s.setLibQuery);
  const chartMode = useApp(s => s.chartMode);
  const setChartMode = useApp(s => s.setChartMode);
  const chartBucket = useApp(s => s.chartBucket);
  const setChartBucket = useApp(s => s.setChartBucket);
  const rebuildIndex = useApp(s => s.rebuildIndex);
  const serviceOnline = useApp(s => s.serviceOnline);
  const libraryLoading = useApp(s => s.libraryLoading);

  return (
    <div className="toolbar">
      <div className="search">
        <span className="ico">🔍</span>
        <input
          id="libQ"
          value={libQuery}
          spellCheck={false}
          placeholder="检索媒体库：番剧名 / 别名（中·日·英）/ 文件名 / year:2022 / month:10 / ep:01 / type:sp"
          onChange={e => setLibQuery(e.target.value)}
        />
        {libQuery && <span className="clear" onClick={() => setLibQuery('')}>✕</span>}
      </div>
      <div className="seg" id="segChart">
        <span className={chartMode === 'count' ? 'on' : ''} onClick={() => setChartMode('count')}>番剧数量</span>
        <span className={chartMode === 'size' ? 'on' : ''} onClick={() => setChartMode('size')}>占用空间</span>
      </div>
      <div className="seg" id="segBucket" title="统计粒度：按年份（每年一部/一片）或按月份（归档目录本来就是 年\月）">
        <span className={chartBucket === 'year' ? 'on' : ''} onClick={() => setChartBucket('year')}>按年份</span>
        <span className={chartBucket === 'month' ? 'on' : ''} onClick={() => setChartBucket('month')}>按月份</span>
      </div>
      <button
        onClick={() => void rebuildIndex()}
        disabled={!serviceOnline || libraryLoading}
        title={serviceOnline ? '扫描 已看/Anime 并重建 library.json' : '请先启动本地服务'}
      >
        ↻ 重建索引
      </button>
    </div>
  );
}

/* =========================================================
   左侧：媒体库列表
   ========================================================= */

function LibListPanel() {
  const library = useApp(s => s.library);
  const libQuery = useApp(s => s.libQuery);
  const serviceOnline = useApp(s => s.serviceOnline);
  const libraryLoading = useApp(s => s.libraryLoading);
  const collapsed = useApp(s => s.collapsed);
  const setCollapsed = useApp(s => s.setCollapsed);
  const libraryError = useApp(s => s.libraryError);
  const loadLibrary = useApp(s => s.loadLibrary);
  const [renaming, setRenaming] = useState<LibraryAnime | null>(null);

  const pushLog = useApp(s => s.pushLog);
  const showToast = useApp(s => s.showToast);
  const revertFile = useApp(s => s.revertFile);

  /** 番剧文件夹的完整路径（relPath 是相对归档根的） */
  const animeFolderPath = (a: LibraryAnime): string =>
    joinWinPath([library?.libraryRoot ?? '', a.relPath]);

  /** 在资源管理器中打开番剧文件夹 */
  const revealFolder = (a: LibraryAnime): void => {
    const p = animeFolderPath(a);
    void (async () => {
      try {
        await api.reveal(p, false);
        pushLog(`📂 已在资源管理器中打开：${p}`, 'ok');
      } catch (err) {
        pushLog(`❌ 打开失败：${(err as Error).message}`, 'err');
        showToast(`❌ ${(err as Error).message}`, '#ef5566');
      }
    })();
  };
  /** 二次移动：文件已经在磁盘上，这里真的是移动文件 */
  const [moving, setMoving] = useState<{ items: MoveEntry[]; currentTarget: string } | null>(null);

  /**
   * 多选：勾选的**文件绝对路径**（跨卡片、跨年份都能攒在一起，最后一次性搬走）。
   *
   * 只存路径不存对象：搬完之后索引会重载，旧对象就过期了；路径是稳定的。
   */
  const [sel, setSel] = useState<Set<string>>(new Set());
  const pick = (path: string, on: boolean): void => setSel(prev => {
    const next = new Set(prev);
    if (on) next.add(path); else next.delete(path);
    return next;
  });
  const pickMany = (paths: string[], on: boolean): void => setSel(prev => {
    const next = new Set(prev);
    paths.forEach(p => { if (on) next.add(p); else next.delete(p); });
    return next;
  });

  /** 已选文件的个数 / 总大小 / 所属目录数（只管展示，不参与逻辑） */
  const selInfo = useMemo(() => {
    let n = 0;
    let size = 0;
    const dirs = new Set<string>();
    for (const a of library?.anime ?? []) {
      for (const f of allLibraryFiles(a)) {
        if (!sel.has(f.fullPath)) continue;
        n++;
        size += f.size;
        dirs.add(f.fullPath.replace(/\\[^\\]+$/, '').toLowerCase());
      }
    }
    return { n, size, dirs: dirs.size };
  }, [library, sel]);

  /** 文件路径 → 字节数（仅用于执行期显示总大小） */
  const sizeOf = (p: string): number => {
    const key = p.toLowerCase();
    for (const a of library?.anime ?? []) {
      const hit = allLibraryFiles(a).find(f => f.fullPath.toLowerCase() === key);
      if (hit) return hit.size;
    }
    return 0;
  };

  /** 把勾选的文件交给同一个「二次整理」弹窗（底部批量条与卡片头的「移动选中的 N 个」都走它） */
  const openMove = (paths: string[]): void => {
    if (!paths.length) return;
    const root = (library?.libraryRoot ?? '').replace(/\\+$/, '');
    const rel = (p: string): string =>
      root && p.toLowerCase().startsWith(root.toLowerCase()) ? p.slice(root.length).replace(/^\\+/, '') : p;
    const dirs = new Set(paths.map(p => p.replace(/\\[^\\]+$/, '').toLowerCase()));
    setMoving({
      items: paths.map(p => ({ path: p, name: p.split('\\').pop() ?? p, isDir: false, archivedPath: p, size: sizeOf(p) })),
      currentTarget: dirs.size === 1 ? rel(paths[0].replace(/\\[^\\]+$/, '')) : `多个位置（${dirs.size} 个目录）`
    });
  };
  const openBatchMove = (): void => openMove(Array.from(sel));

  const pq = useMemo(() => parseQuery(libQuery), [libQuery]);
  const terms = pq.terms;

  const list = useMemo(
    () => (library?.anime ?? []).filter(a => allLibraryFiles(a).length && matchAnime(a, pq)),
    [library, pq]
  );

  const normals = list.filter(a => !a.special);
  const specials = list.filter(a => a.special);

  /** 有检索条件时：年份一律自动展开，否则搜到的东西藏在折叠的年份里，很像「没搜到」 */
  const searching = pq.terms.length > 0 || Object.keys(pq.filters).length > 0;

  /**
   * 折叠状态的读写口（传下去给各层用）。
   *
   * **四层（年 / 月 / 番剧卡片 / 子目录）默认全部折叠**：
   * 媒体库有 700+ 部、8000+ 文件，一进来就全铺开既卡又难找；
   * 折叠时子树**根本不渲染**（不是 `display:none`），所以初始打开很快。
   *
   * ⚠ 为什么需要搜索期的「覆盖」：如果搜索时无条件强制展开，用户就**没法手动折叠**了
   * （点了没反应）。所以搜索期间的点击记在 `searchOverride` 里（优先级高于强制展开），
   * 而**检索词一变就清空覆盖** —— 换了个词当然要重新把命中项露出来。
   */
  const [searchOverride, setSearchOverride] = useState<Record<string, boolean>>({});
  useEffect(() => { setSearchOverride({}); }, [libQuery]);

  const collapse = useMemo(() => ({
    isCollapsed: (key: string, normalDefault: boolean): boolean => {
      const ov = searchOverride[key];
      if (ov !== undefined) return ov;
      if (searching) return false;                                    // 搜索时默认全展开
      return collapsed[key] === undefined ? normalDefault : collapsed[key] === true;
    },
    toggle: (key: string, cur: boolean): void => {
      if (searching) setSearchOverride(o => ({ ...o, [key]: !cur })); // 搜索期间的折叠只记在覆盖里
      else setCollapsed(key, !cur);
    }
  }), [searchOverride, searching, collapsed, setCollapsed]);

  const groups = useMemo(() => {
    const years = new Map<number, Map<number, LibraryAnime[]>>();
    normals.forEach(a => {
      const y = a.year ?? 0;
      const m = a.month ?? 0;
      if (!years.has(y)) years.set(y, new Map());
      const mm = years.get(y)!;
      if (!mm.has(m)) mm.set(m, []);
      mm.get(m)!.push(a);
    });
    return Array.from(years.entries()).sort((a, b) => b[0] - a[0]);
  }, [normals]);

  return (
    <section className="panel">
      <div className="panel-head">
        <span>📺 媒体库</span>
        <span className="hint">{library?.libraryRoot ?? '（尚未生成索引）'}</span>
      </div>
      <div className="panel-body" id="libList">
        {libraryLoading && <div className="empty"><span className="spin" /> 正在读取索引…</div>}

        {/*
         * 刷新失败必须看得见：以前失败只写一行日志，列表继续显示旧数据。
         * 用户会以为「刚才的移动没生效」→ 再点一次 → 重复移动同一个文件。
         */}
        {libraryError && !libraryLoading && (
          <div className="notice-bar fail" style={{ margin: '8px 10px 0' }}>
            <span>⚠ {libraryError}</span>
            <span className="spacer" />
            <button className="mini" onClick={() => void loadLibrary()}>↻ 重试</button>
          </div>
        )}

        {!libraryLoading && !library && (
          <div className="empty">
            尚未生成媒体库索引<br />
            {serviceOnline
              ? <>请点击右上角 <code>↻ 重建索引</code> 扫描「已看/Anime」</>
              : <>启动本地服务后点击 <code>↻ 重建索引</code></>}
          </div>
        )}

        {!libraryLoading && library && !list.length && (
          <div className="empty">
            媒体库中没有匹配的番剧<br />
            试试清空检索条件，或使用 <code>year:2022</code> / <code>ep:01</code> 这类语法
          </div>
        )}

        {normals.length > 0 && (
          <div className="tree">
            <div className="tree-hint">
              ℹ 四层都默认折叠：<b>年份 → 月份 → 番剧 → 子目录</b>，逐层点开。
              一个年份动辄上千个文件，折叠时不建 DOM，所以打开很快；检索时会自动全部展开。
              <br />
              ℹ 想只移动其中几个：勾选文件行左侧的方框 → 卡片头会出现「<b>↗ 移动选中的 N 个</b>」
              （底部也会浮出一条操作条）。<b>点文件行的任意位置都能勾选</b>，不用精准点那个小方框。
            </div>
            {groups.map(([y, months]) => {
              const fileCount = Array.from(months.values()).reduce(
                (a, arr) => a + arr.reduce((x, an) => x + allLibraryFiles(an).length, 0), 0
              );
              // ⚠ 折叠键要加 `lib-` 前缀：归档视图用的是 `y2026`，两边共用 store 里同一张折叠表
              const yKey = `lib-y${y}`;
              const yCollapsed = collapse.isCollapsed(yKey, true);   // 年份默认**折叠**
              return (
                <div className="node-year" key={y}>
                  <div
                    className={`row${yCollapsed ? ' collapsed' : ''}`}
                    onClick={() => collapse.toggle(yKey, yCollapsed)}
                  >
                    <span className="caret">▼</span>
                    <span className="label">📅 {y === 0 ? '未归档年' : `${y} 年`}</span>
                    <span className="count">{fileCount} 个文件</span>
                  </div>
                  {/* 折叠时**不渲染**子树：展开一个年份可能要建上万个节点 */}
                  {!yCollapsed && (
                  <div className="children">
                    {Array.from(months.entries()).sort((a, b) => b[0] - a[0]).map(([m, arr]) => {
                      const mKey = `lib-y${y}-m${m}`;
                      const mCollapsed = collapse.isCollapsed(mKey, true);   // 月份默认**折叠**
                      const mFiles = arr.reduce((a, an) => a + allLibraryFiles(an).length, 0);
                      return (
                      <div key={`${y}-${m}`}>
                        <div
                          className={`lib-month${mCollapsed ? ' collapsed' : ''}`}
                          onClick={() => collapse.toggle(mKey, mCollapsed)}
                        >
                          <span className="caret">▼</span>
                          <span className="mname">🗓 {pad(m)} 月</span>
                          <span className="mcount">{arr.length} 部 · {mFiles} 个文件</span>
                        </div>
                        {!mCollapsed && arr.map(a => (
                          <AnimeCard
                            key={a.id}
                            anime={a}
                            terms={terms}
                            serviceOnline={serviceOnline}
                            collapse={collapse}
                            sel={sel}
                            onPick={pick}
                            onPickMany={pickMany}
                            onMoveSel={openMove}
                            onRename={() => setRenaming(a)}
                            onRevealFolder={() => revealFolder(a)}
                            onMoveAll={() => setMoving({
                              items: allLibraryFiles(a).map(f => ({ path: f.fullPath, name: f.name, isDir: false, archivedPath: f.fullPath, size: f.size })),
                              currentTarget: a.relPath
                            })}
                            onMove={f => setMoving({
                              items: [{ path: f.fullPath, name: f.name, isDir: false, archivedPath: f.fullPath, size: f.size }],
                              currentTarget: a.relPath
                            })}
                            onMoveDir={(sub, dirPath) => setMoving({
                              items: [{ path: dirPath, name: sub.dir, isDir: true, archivedPath: dirPath, size: sub.totalSize ?? sub.files.reduce((x, f) => x + f.size, 0) }],
                              currentTarget: a.relPath
                            })}
                            onRevertDir={(sub, dirPath) => void revertFile(dirPath, sub.dir)}
                          />
                        ))}
                      </div>
                      );
                    })}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {specials.length > 0 && (
          <>
            <div className="special-head">
              ⚠ 特殊目录（_未识别 / _待确认） · 未参与正式归档，可手动归类（不参与图表统计）
            </div>
            {specials.map(a => (
              <AnimeCard
                key={a.id}
                anime={a}
                terms={terms}
                serviceOnline={serviceOnline}
                collapse={collapse}
                sel={sel}
                onPick={pick}
                onPickMany={pickMany}
                onMoveSel={openMove}
                onRename={() => setRenaming(a)}
                onRevealFolder={() => revealFolder(a)}
                onMoveAll={() => setMoving({
                  items: allLibraryFiles(a).map(f => ({ path: f.fullPath, name: f.name, isDir: false, archivedPath: f.fullPath, size: f.size })),
                  currentTarget: a.relPath
                })}
                onMove={f => setMoving({
                  items: [{ path: f.fullPath, name: f.name, isDir: false, archivedPath: f.fullPath, size: f.size }],
                  currentTarget: a.relPath
                })}
                onMoveDir={(sub, dirPath) => setMoving({
                  items: [{ path: dirPath, name: sub.dir, isDir: true, archivedPath: dirPath, size: sub.totalSize ?? sub.files.reduce((x, f) => x + f.size, 0) }],
                  currentTarget: a.relPath
                })}
                onRevertDir={(sub, dirPath) => void revertFile(dirPath, sub.dir)}
              />
            ))}
          </>
        )}
      </div>

      {sel.size > 0 && createPortal(
        <div className="batch-bar sel">
          <span>
            ☑ 已选中 <b>{sel.size}</b> 个文件（{formatSize(selInfo.size)}）
            {selInfo.dirs > 1 && ` · 来自 ${selInfo.dirs} 个目录`}
          </span>
          <span className="spacer" />
          <button
            className="mini accent"
            onClick={openBatchMove}
            disabled={!serviceOnline}
            title={serviceOnline
              ? `只把这 ${sel.size} 个勾选的文件移到另一部番剧（整部番剧请用卡片头的「↗ 整部移动」）`
              : '请先启动本地服务'}
          >
            ↗ 移动选中 {sel.size} 个
          </button>
          <button className="mini" onClick={() => setSel(new Set())}>清空选择</button>
        </div>,
        document.body
      )}

      {renaming && (
        <LibraryRenameHost anime={renaming} onClose={() => setRenaming(null)} />
      )}

      {moving && (
        <EntryMoveHost
          items={moving.items}
          currentTarget={moving.currentTarget}
          onClose={() => setMoving(null)}
          /* 搬成功了才清空勾选：失败时保留选择，方便直接重试 */
          onDone={() => setSel(new Set())}
        />
      )}
    </section>
  );
}

function LibraryRenameHost({ anime, onClose }: { anime: LibraryAnime; onClose: () => void }) {
  const renameLibraryAnime = useApp(s => s.renameLibraryAnime);
  const libraryRoot = useApp(s => s.library?.libraryRoot ?? '');
  return (
    <RenameDialog
      title="✏️ 重命名番剧文件夹（媒体库 · 真实改名）"
      initial={anime.zhName}
      locationHint={
        <>
          将在 NAS 上真实重命名这一层：<br />
          {libraryRoot}\{anime.relPath.replace(anime.zhName, '')}
          <b>{anime.zhName}</b>\<br />
          例：孤独摇滚！ → 孤独摇滚
        </>
      }
      note={
        <>
          ℹ 只改<b>番剧文件夹</b>这一层：<code>{'{年份}/{月份}'}</code> 与里面的<b>文件名都不会改动</b>。
          会立即在 NAS 上生效（并写入日志，可反向改回）。
        </>
      }
      onClose={onClose}
      onApply={v => { void renameLibraryAnime(anime.relPath, v); onClose(); }}
    />
  );
}

/* =========================================================
   番剧卡片 + 文件行
   ========================================================= */

function AnimeCard({
  anime, terms, serviceOnline, collapse, sel, onPick, onPickMany, onMoveSel,
  onRename, onRevealFolder, onMoveAll, onMove, onMoveDir, onRevertDir
}: {
  anime: LibraryAnime;
  terms: string[];
  serviceOnline: boolean;
  onRename: () => void;
  /** 在资源管理器中打开这部番剧的文件夹 */
  onRevealFolder: () => void;
  /** 整部番剧一起移到另一部番剧（批量） */
  onMoveAll: () => void;
  onMove: (f: LibraryFile) => void;
  /** 整个「单独子目录」一起移走（子目录在磁盘上就是真实文件夹，可以整体搬） */
  onMoveDir: (s: LibrarySubDir, dirPath: string) => void;
  /** 整个「单独子目录」撤回 */
  onRevertDir: (s: LibrarySubDir, dirPath: string) => void;
  /** 折叠状态读写（由列表层统一提供，带「搜索期覆盖」逻辑） */
  collapse: { isCollapsed: (key: string, normalDefault: boolean) => boolean; toggle: (key: string, cur: boolean) => void };
  /** 多选：已勾选的文件路径集合 */
  sel: Set<string>;
  onPick: (path: string, on: boolean) => void;
  onPickMany: (paths: string[], on: boolean) => void;
  /** 只移动**这一部番剧里被勾选**的那些文件（参数是该卡的勾选路径） */
  onMoveSel: (paths: string[]) => void;
}) {
  const play = useApp(s => s.play);
  const revertFile = useApp(s => s.revertFile);
  const libraryRoot = useApp(s => s.library?.libraryRoot ?? '');
  /*
   * 文件一律**按集数**排（不是按文件名字符串）：
   * 同一部番剧常混多个字幕组，按整串排会让 01 直接接 14、02 跑去另一段。
   * `allLibraryFiles` 含子目录里的文件，卡片头的「N 集 / 大小 / 全选」都用这一份。
   */
  const files = useMemo(() => [...allLibraryFiles(anime)].sort(compareByEpisode), [anime]);
  const size = files.reduce((a, f) => a + f.size, 0);
  const animeDir = joinWinPath([libraryRoot, anime.relPath]);
  const selCountOf = (arr: LibraryFile[]): number => arr.reduce((a, f) => a + (sel.has(f.fullPath) ? 1 : 0), 0);
  const selCount = selCountOf(files);

  // 卡片自己一层折叠；每张卡片独立折叠（键带 anime.id）；默认**折叠**
  const selfKey = `lib-anime-${anime.id}`;
  const selfCollapsed = collapse.isCollapsed(selfKey, true);

  return (
    <div className={`lib-anime${anime.special ? ' special' : ''}`}>
      <div
        className={`arow${selfCollapsed ? ' collapsed' : ''}`}
        onClick={() => collapse.toggle(selfKey, selfCollapsed)}
      >
        <span className="caret">▼</span>
        <TriCheck
          className="achk"
          checked={files.length > 0 && selCount === files.length}
          partial={selCount > 0 && selCount < files.length}
          onToggle={on => onPickMany(files.map(f => f.fullPath), on)}
          title={`全选本番剧（${files.length} 个文件）`}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="aname" dangerouslySetInnerHTML={{ __html: `📁 ${highlight(anime.zhName, terms)}` }} />
          <div className="aalias">
            {anime.aliases.length ? `${anime.aliases.join(' / ')} · ` : ''}
            {anime.year ? `${anime.year}-${pad(anime.month)}` : '未归档'}
            {anime.bangumiId ? ` · bgm${anime.bangumiId}` : ''}
          </div>
        </div>
        <span className="pill">{files.length} 集</span>
        <span className="pill src">{formatSize(size)}</span>
        {/* 勾选后**就地把入口放在这儿**：用户容易在卡片头找「只移动勾选的那几个」 */}
        {selCount > 0 && (
          <button
            className="mini accent"
            onClick={e => { e.stopPropagation(); onMoveSel(files.filter(f => sel.has(f.fullPath)).map(f => f.fullPath)); }}
            disabled={!serviceOnline}
            title={serviceOnline
              ? `只把这 ${selCount} 个勾选的文件移到另一部番剧（不是整部）`
              : '请先启动本地服务'}
          >
            ↗ 移动选中的 {selCount} 个
          </button>
        )}
        {!anime.special && (
          <button
            className="mini"
            onClick={e => { e.stopPropagation(); onRename(); }}
            disabled={!serviceOnline}
            title={serviceOnline ? '重命名番剧文件夹（真实改名）' : '请先启动本地服务'}
          >
            ✏️
          </button>
        )}
        <button
          className="mini"
          onClick={e => { e.stopPropagation(); onMoveAll(); }}
          disabled={!serviceOnline || !files.length}
          title={serviceOnline
            ? `整部移动：把这 ${files.length} 个文件**全部**移到另一部番剧。` +
              `只改归勾选的那几个文件 → 用底部的「↗ 移动选中 N 个」`
            : '请先启动本地服务'}
        >
          ↗ 整部移动（{files.length}）
        </button>
        <button
          className="mini"
          onClick={e => { e.stopPropagation(); onRevealFolder(); }}
          disabled={!serviceOnline}
          title={serviceOnline ? '在 Windows 文件资源管理器中打开这部番剧的文件夹' : '请先启动本地服务'}
        >
          📂 打开文件夹
        </button>
      </div>

      {!selfCollapsed && (
      <>
      {anime.files.length > 0 && [...anime.files].sort(compareByEpisode).map(f => (
        <FileRow
          key={f.uid}
          file={f}
          terms={terms}
          serviceOnline={serviceOnline}
          checked={sel.has(f.fullPath)}
          onPick={onPick}
          onPlay={() => void play(f.fullPath, f.name)}
          onRevert={() => void revertFile(f.fullPath, f.name)}
          onMove={() => onMove(f)}
        />
      ))}

      {(anime.subDirs ?? []).map(s => {
        // 子目录本身就是一个真实文件夹（比如整包归档进来的一个目录）→ 可以整体搬 / 整体撤回
        const dirPath = s.fullPath || joinWinPath([animeDir, s.dir]);
        const dirSize = s.totalSize ?? s.files.reduce((a, f) => a + f.size, 0);
        const subKey = `lib-sub-${anime.id}-${s.dir}`;
        const subCollapsed = collapse.isCollapsed(subKey, true);   // 子目录默认**折叠**
        return (
          <div key={s.dir}>
            <div
              className={`lib-sub${subCollapsed ? ' collapsed' : ''}`}
              onClick={() => collapse.toggle(subKey, subCollapsed)}
            >
              <span className="caret">▼</span>
              <TriCheck
                className="dchk"
                checked={s.files.length > 0 && selCountOf(s.files) === s.files.length}
                partial={selCountOf(s.files) > 0 && selCountOf(s.files) < s.files.length}
                onToggle={on => onPickMany(s.files.map(f => f.fullPath), on)}
                title={`全选该子目录（${s.files.length} 个文件）`}
              />
              <span className="dname" title={dirPath}>📁 {s.dir}（单独子目录）</span>
              <span className="dcount">{s.files.length} 个文件 · {formatSize(dirSize)}</span>
              <button
                className="mini rev"
                onClick={e => { e.stopPropagation(); onRevertDir(s, dirPath); }}
                disabled={!serviceOnline || s.revertable === false}
                title={
                  !serviceOnline
                    ? '请先启动本地服务'
                    : s.revertable === false
                      ? '这个子目录没有归档记录（不是本工具搬进来的），无法撤回'
                      : `把整个子目录撤回至：${s.originPath ?? ''}`
                }
              >
                ↩ 撤回
              </button>
              <button
                className="mini"
                onClick={e => { e.stopPropagation(); onMoveDir(s, dirPath); }}
                disabled={!serviceOnline}
                title={serviceOnline ? '把整个子目录（含里面的所有文件）移到另一部番剧' : '请先启动本地服务'}
              >
                ↗ 移动整个目录
              </button>
            </div>
            {!subCollapsed && [...s.files].sort(compareByEpisode).map(f => (
              <FileRow
                key={f.uid}
                file={f}
                terms={terms}
                serviceOnline={serviceOnline}
                checked={sel.has(f.fullPath)}
                onPick={onPick}
                onPlay={() => void play(f.fullPath, f.name)}
                onRevert={() => void revertFile(f.fullPath, f.name)}
                onMove={() => onMove(f)}
              />
            ))}
          </div>
        );
      })}
      </>
      )}
    </div>
  );
}

function FileRowBase({
  file, terms, serviceOnline, checked, onPick, onPlay, onRevert, onMove
}: {
  file: LibraryFile;
  terms: string[];
  serviceOnline: boolean;
  /** 是否被勾选（多选批量操作） */
  checked: boolean;
  onPick: (path: string, on: boolean) => void;
  onPlay: () => void;
  onRevert: () => void;
  onMove: () => void;
}) {
  /**
   * 整行都能勾选（用户要求）。
   *
   * 文件行是**最小单元**，本身不可再展开 ⇒ 行上的点击不存在歧义，没必要逼用户精准点那个 13px 的小方框。
   *
   * ⚠ 三个坑：
   *  ① 行内三个按钮（播放 / 撤回 / 移动）必须 `stopPropagation`，否则点按钮会顺手改掉勾选；
   *  ② 复选框自己必须 `stopPropagation`（`TriCheck` 内已做）—— 否则触发两次 = 看起来「勾不上」；
   *  ③ 正在拖选文件名时不算点击（想复制一段文件名，结果被勾上了）。
   */
  const rowClick = (): void => {
    if (isTextSelecting()) return;
    onPick(file.fullPath, !checked);
  };
  return (
    <div className={`lib-file${checked ? ' picked' : ''} clickable`} onClick={rowClick}>
      <TriCheck
        className="fchk"
        checked={checked}
        partial={false}
        onToggle={on => onPick(file.fullPath, on)}
        title="勾选后可批量移动（也可以直接点这一行任意位置）"
      />
      <span className="ep-badge">{padEpisode(file.episode) || '—'}</span>
      <span
        className="fname"
        title={file.fullPath}
        dangerouslySetInnerHTML={{ __html: `🎬 ${highlight(file.name, terms)}` }}
      />
      <span className="fsz" title="文件大小">{formatSize(file.size)}</span>
      <span className="ftime" title={`修改时间：${formatTime(file.mtime)}`}>{formatDateTime(file.mtime)}</span>
      <button
        className="mini play"
        onClick={e => { e.stopPropagation(); onPlay(); }}
        disabled={!serviceOnline}
        title={serviceOnline ? '调用 Windows 默认播放器' : '请先启动本地服务'}
      >
        ▶ 播放
      </button>
      <button
        className="mini rev"
        onClick={e => { e.stopPropagation(); onRevert(); }}
        disabled={!serviceOnline || !file.revertable}
        title={
          !serviceOnline
            ? '请先启动本地服务'
            : file.revertable
              ? `撤回至：${file.originPath ?? ''}`
              : '无归档记录（非本工具归档），不可撤回'
        }
      >
        ↩ 撤回
      </button>
      <button
        className="mini"
        onClick={e => { e.stopPropagation(); onMove(); }}
        disabled={!serviceOnline}
        title={serviceOnline ? '归错位置了？直接移到另一部番剧（真实移动，不必先撤回再归档）' : '请先启动本地服务'}
      >
        ↗ 移动
      </button>
    </div>
  );
}

/**
 * 文件行做 `memo`：勾选是逐个文件的操作，但不做隔离的话，
 * 每勾一下都会把**所有已渲染的文件行**重渲一遍（展开全部卡片时是 8000+ 行）。
 *
 * 比较器故意忽略回调的引用（它们每次渲染都是新函数）—— 回调闭包里捕获的
 * `file` / `anime` 对同一行来说是不变的，所以不存在拿到陈旧数据的问题。
 */
const FileRow = memo(
  FileRowBase,
  (a, b) =>
    a.file.uid === b.file.uid &&
    a.checked === b.checked &&
    a.terms === b.terms &&
    a.serviceOnline === b.serviceOnline
);

/**
 * 三态复选框：全选（☑）/ 部分选中（▣，`indeterminate`）/ 未选（☐）。
 *
 * 用途：番剧卡片头「全选本番剧」、子目录行「全选该子目录」、文件行勾选。
 * ⚠ 卡片头与子目录行整行都带折叠点击，所以必须 `stopPropagation`，
 * 否则勾一下会顺手把这一层折叠掉。
 */
function TriCheck({
  checked, partial, onToggle, title, className
}: {
  checked: boolean;
  partial: boolean;
  onToggle: (on: boolean) => void;
  title: string;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial && !checked;
  }, [partial, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={className}
      checked={checked}
      title={title}
      onClick={e => e.stopPropagation()}
      onChange={e => onToggle(e.target.checked)}
    />
  );
}
interface StatsRow {
  key: string;
  label: string;
  animeCount: number;
  fileCount: number;
  totalSize: number;
  /** 0 = 年份（或按月份模式的平铺行），1 = 年份下面展开出来的月份行 */
  depth: 0 | 1;
  /** 该年实际有归档记录的月份数（>0 才可展开） */
  childCount?: number;
  year?: number;
}

/** 统计/图表用的一行（年份行或月份行） */
function statRowLabel(year: number, month: number): string {
  return month > 0 ? `${year}-${pad(month)}` : `${year}-未知`;
}

function LibStatsPanel() {
  const library = useApp(s => s.library);
  const chartMode = useApp(s => s.chartMode);
  const chartBucket = useApp(s => s.chartBucket);
  /** 展开的年份；null = 用户还没手动点过 → 默认展开最新的一年 */
  const [openYears, setOpenYears] = useState<number[] | null>(null);

  const stats = library?.stats;
  const yearList = stats?.years;

  /*
   * 按月聚合：新索引直接带 stats.months；
   * 旧索引（还没点「↻ 重建索引」）现场按 anime 算一遍 —— 否则月份行会显示不出来，
   * 用户会以为功能没做。两边的过滤/求和口径必须与服务端 computeStats 完全一致：
   * 排除特殊目录、year 为 null 的不统计、体积含子目录里的文件。
   */
  const months = useMemo(() => {
    if (!library) return [];
    if (library.stats.months?.length) return library.stats.months;
    const map = new Map<string, MonthStat>();
    library.anime.forEach(a => {
      const year = a.year;
      if (a.special || year === null) return;
      const month = a.month ?? 0;
      const fs = allLibraryFiles(a);
      const cur = map.get(`${year}-${month}`)
        ?? { year, month, animeCount: 0, fileCount: 0, totalSize: 0 };
      cur.animeCount += 1;
      cur.fileCount += fs.length;
      cur.totalSize += fs.reduce((x, f) => x + f.size, 0);
      map.set(`${year}-${month}`, cur);
    });
    return Array.from(map.values()).sort((a, b) => (b.year - a.year) || (b.month - a.month));
  }, [library]);

  /** 年份 → 该年实际存在的月份（只列真实存在的月份，不留空的 12 个月） */
  const monthsByYear = useMemo(() => {
    const m = new Map<number, MonthStat[]>();
    months.forEach(x => {
      const arr = m.get(x.year) ?? [];
      arr.push(x);
      m.set(x.year, arr);
    });
    return m;
  }, [months]);

  // 默认展开最新的一年：一进页面就能看到「年 + 月」两层，点一下即可收起
  const expandedYears = useMemo(() => {
    if (openYears) return openYears;
    return yearList?.length ? [yearList[0].year] : [];
  }, [openYears, yearList]);

  if (!library || !stats) {
    return (
      <section className="panel">
        <div className="panel-head"><span>📊 统计与图表</span><span className="hint">索引未加载</span></div>
        <div className="panel-body"><div className="empty">尚未生成媒体库索引</div></div>
      </section>
    );
  }

  const isMonth = chartBucket === 'month';
  const toggleYear = (y: number): void => {
    const cur = expandedYears.includes(y);
    setOpenYears(cur ? expandedYears.filter(x => x !== y) : [...expandedYears, y]);
  };

  const monthRowOf = (m: MonthStat): StatsRow => ({
    key: `${m.year}-${m.month}`,
    label: statRowLabel(m.year, m.month),
    animeCount: m.animeCount,
    fileCount: m.fileCount,
    totalSize: m.totalSize,
    depth: 1,
    year: m.year
  });

  /** 年份模式：年份行 + （展开时）该年的月份行；月份模式：所有月份平铺 */
  const yearRows: StatsRow[] = (yearList ?? []).map(y => ({
    key: String(y.year),
    label: String(y.year),
    animeCount: y.animeCount,
    fileCount: y.fileCount,
    totalSize: y.totalSize,
    depth: 0,
    childCount: (monthsByYear.get(y.year) ?? []).length,
    year: y.year
  }));

  const rows: StatsRow[] = isMonth
    // 平铺模式：月份就是顶层行（不能带 depth=1，否则会被套上「子行」的缩进样式）
    ? months.map(m => ({ ...monthRowOf(m), depth: 0 }))
    : yearRows.flatMap(r => (
      r.year !== undefined && expandedYears.includes(r.year)
        ? [r, ...(monthsByYear.get(r.year) ?? []).map(monthRowOf)]
        : [r]
    ));

  const val = (r: StatsRow): number => (chartMode === 'count' ? r.animeCount : r.totalSize);
  // 比例尺以「年份」为基准（年份 = 其各月之和，必然 ≥ 月份），月份模式下以月份为基准
  const scaleRows = isMonth ? rows : yearRows;
  const max = scaleRows.length ? Math.max(...scaleRows.map(val)) : 1;

  const unit = isMonth ? '月份' : '年份';
  const bucketCount = isMonth ? months.length : yearRows.length;
  const chartTitle = isMonth
    ? (chartMode === 'count' ? '各月份番剧数量（部）' : '各月份占用空间')
    : (chartMode === 'count' ? '各年份番剧数量（部）' : '各年份占用空间');
  const detailTitle = isMonth ? '月份明细' : '年份明细';
  const hint = isMonth
    ? '· 按归档目录的「年\\月」层级统计'
    : '· 点年份整行即可展开该年的月份（只列真实存在的月份）';

  /** 该行可展开的年份（null = 不可展开：月份行、平铺模式的月份行、没有归档月份的年份） */
  const expandableYear = (r: StatsRow): number | null =>
    (!isMonth && r.depth === 0 && r.childCount && r.year !== undefined ? r.year : null);

  /**
   * 展开箭头：**只做展示**。
   *
   * 事件挂在整行上（用户要求「点年份整一条都能展开」），箭头再单独绑一次就会连点两下 = 看起来没反应。
   * 不可展开的行也要渲染占位，否则各列对不齐。
   */
  const caretOf = (r: StatsRow) => {
    const y = expandableYear(r);
    if (y === null) return <span className="ycaret" aria-hidden="true" />;
    const open = expandedYears.includes(y);
    return (
      <span className={'ycaret clickable' + (open ? ' open' : '')} aria-hidden="true">
        {open ? '▾' : '▸'}
      </span>
    );
  };

  /**
   * 整行可点：点年份行的**任意位置**（标签 / 柱子 / 数值 / 空白）都能展开或收起该年的月份。
   * 用 role=button + 键盘回车/空格，让「整行可点」对键盘操作也可用。
   */
  const rowPropsOf = (r: StatsRow) => {
    const y = expandableYear(r);
    if (y === null) return {};
    const open = expandedYears.includes(y);
    return {
      role: 'button' as const,
      tabIndex: 0,
      title: `${open ? '收起' : '展开'} ${r.label} 年的 ${r.childCount} 个月份（点这一行任意位置都行）`,
      onClick: () => toggleYear(y),
      onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleYear(y); }
      }
    };
  };

  const labelCls = (r: StatsRow): string => 'y' + (isMonth || r.depth === 1 ? ' wide' : '');

  /** 行的类名：可展开的年份行加 `expandable`（悬停高亮 + 手型光标） */
  const rowCls = (r: StatsRow): string =>
    'bar-row' + (r.depth === 1 ? ' child' : '') + (expandableYear(r) === null ? '' : ' expandable');

  return (
    <section className="panel">
      <div className="panel-head">
        <span>📊 统计与图表</span>
        <span className="hint">索引生成于 {formatTime(library.generatedAt)}</span>
      </div>
      <div className="panel-body">
        <div className="stats-grid">
          <div className="stat-card"><div className="k">番剧总数</div><div className="v">{stats.animeCount}<small>部</small></div></div>
          <div className="stat-card"><div className="k">文件总数</div><div className="v">{stats.fileCount}<small>个</small></div></div>
          <div className="stat-card"><div className="k">总占用空间</div><div className="v">{formatSize(stats.totalSize)}</div></div>
          <div className="stat-card"><div className="k">可撤回文件</div><div className="v">{stats.revertableCount}<small>个</small></div></div>
          <div className="stat-card"><div className="k">特殊目录</div><div className="v">{stats.specialCount}<small>个</small></div></div>
          <div className="stat-card" title={isMonth ? '有归档记录的月份数' : '有归档记录的年份数'}>
            <div className="k">覆盖{unit}</div>
            <div className="v">{bucketCount}<small>{isMonth ? '个月' : '年'}</small></div>
          </div>
        </div>

        <div className="chart">
          <div className="ct">
            {chartTitle}
            <span style={{ marginLeft: 8, color: 'var(--txt-3)' }}>{hint}</span>
          </div>
          {!rows.length && <div style={{ fontSize: 11.5, color: 'var(--txt-3)' }}>暂无数据</div>}
          {rows.map(r => (
            <div className={rowCls(r)} key={r.key} {...rowPropsOf(r)}>
              {caretOf(r)}
              <span className={labelCls(r)}>{r.label}</span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.max(4, (val(r) / max) * 100)}%` }} />
              </div>
              <span className="vv">
                {chartMode === 'count' ? `${r.animeCount} 部` : formatSize(r.totalSize)}
              </span>
            </div>
          ))}
        </div>

        <div className="chart">
          <div className="ct">{detailTitle}</div>
          {!rows.length && <div style={{ fontSize: 11.5, color: 'var(--txt-3)' }}>暂无数据</div>}
          {rows.map(r => (
            <div className={rowCls(r)} key={r.key} {...rowPropsOf(r)}>
              {caretOf(r)}
              <span className={labelCls(r)}>{r.label}</span>
              <span style={{ flex: 1, color: 'var(--txt-2)' }}>
                {r.animeCount} 部 · {r.fileCount} 个文件
              </span>
              <span className="vv">{formatSize(r.totalSize)}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
