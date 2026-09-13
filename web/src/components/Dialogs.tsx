import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { api, type BangumiHit } from '../api/client';
import type { AnimeGroup } from '../types';
import { pad, sourceLabel } from '../utils';

/* =========================================================
   通用弹窗
   ========================================================= */

export function Modal({
  title,
  children,
  footer,
  onClose,
  width
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  width?: number;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="modal-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <h3>{title}</h3>
        <div className="mbody">{children}</div>
        <div className="mfoot">{footer}</div>
      </div>
    </div>,
    document.body
  );
}

function Opt({
  on, onSelect, title, desc, side
}: { on: boolean; onSelect: () => void; title: string; desc: ReactNode; side?: string }) {
  return (
    <div className={`opt${on ? ' on' : ''}`} onClick={onSelect}>
      <span className="o-i" />
      <div style={{ flex: 1 }}>
        <div className="o-t">{title}</div>
        <div className="o-d">{desc}</div>
      </div>
      {side && <span className="o-s">{side}</span>}
    </div>
  );
}

/* =========================================================
   ⚙ 冲突处理（二选一：自动重命名 (1) / 跳过；❌ 无「覆盖」）
   ========================================================= */

export function ConflictDialog({
  group, targetRoot, onApply, onClose
}: {
  group: AnimeGroup;
  targetRoot: string;
  onApply: (strategy: 'rename' | 'skip') => void;
  onClose: () => void;
}) {
  const [strategy, setStrategy] = useState<'rename' | 'skip'>('rename');
  const item = group.items[0];
  const name = item?.scanItem.name ?? '';
  const renamed = name.replace(/(\.[^.]+)$/, ' (1)$1');
  const dir = `${targetRoot.replace(/[\\/]+$/, '')}\\${group.year}\\${pad(group.month)}\\${group.zhName}`;

  return (
    <Modal
      title="⚙ 冲突处理 · 目标已存在同名文件"
      width={720}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={() => onApply(strategy)}>应用</button>
        </>
      }
    >
      <div className="warn-box">
        ⚠ 目标目录中已存在同名文件，请选择处理方式。此选择会立即影响归档方案。
      </div>
      <div className="kv"><span className="k">目标目录</span><span className="v">{dir}</span></div>
      <div className="kv">
        <span className="k">已存在</span>
        <span className="v">
          {name}<br />
          <span style={{ color: 'var(--txt-3)' }}>此前已归档（执行时检测到同名）</span>
        </span>
      </div>
      <div className="kv">
        <span className="k">待移入</span>
        <span className="v">
          {name}<br />
          <span style={{ color: 'var(--txt-3)' }}>{item?.scanItem.isDir ? '文件夹' : '文件'} · 来自源目录</span>
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <Opt
          on={strategy === 'rename'}
          onSelect={() => setStrategy('rename')}
          title="✅ 自动重命名 (1)"
          side="推荐"
          desc={<>保留旧文件，新文件重命名为 <code>{renamed}</code> 后移入</>}
        />
        <Opt
          on={strategy === 'skip'}
          onSelect={() => setStrategy('skip')}
          title="⏭ 跳过"
          desc="不移动该文件，原样保留在源目录"
        />
        <div style={{ fontSize: 11.5, color: 'var(--txt-3)', lineHeight: 1.75 }}>
          ℹ 不提供「覆盖」选项（避免误删）。如需其他命名，请关闭本窗后在归档结果区点「✏️」手动重命名。
        </div>
      </div>
    </Modal>
  );
}

/* =========================================================
   🔎 人工确认（候选 / 手动输入 / 年月 / 写回别名表 / 暂不处理）
   ========================================================= */

export interface DirItem {
  name: string;
  year: number | null;
  month: number | null;
  relPath: string;
  /** `plan` = 本次归档方案（文件夹还没创建）；`disk` = 已存在于归档目录 */
  from?: 'plan' | 'disk';
}

/**
 * 合并「本次归档方案」与「已归档文件夹」两个来源，供选择弹窗直接复用。
 *
 * 为什么需要方案这一路：第一次使用时归档目录里**一个文件夹都没有**，
 * 只能从已创建文件夹里选的话，这个选择框等于没有用；
 * 而本次扫描已经识别出来的番剧（含还没创建的）才是当下真正能复用的名单。
 */
export function mergeDirItems(plan: DirItem[], disk: DirItem[]): DirItem[] {
  const seen = new Set<string>();
  const out: DirItem[] = [];
  const push = (d: DirItem): void => {
    const k = `${d.name.toLowerCase()}|${d.year ?? ''}|${d.month ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(d);
  };
  plan.forEach(push);
  disk.forEach(d => push({ ...d, from: d.from ?? 'disk' }));
  return out;
}

/** 来源徽标：本次方案 / 已归档 */
function SourceBadge({ from }: { from?: 'plan' | 'disk' }) {
  const isPlan = from !== 'disk';
  return (
    <span
      className="pill"
      style={{
        fontSize: 10,
        padding: '0 5px',
        flex: 'none',
        color: isPlan ? '#c3b6ff' : '#9fd0ff',
        borderColor: isPlan ? 'rgba(124,92,255,.45)' : 'rgba(59,169,255,.4)',
        background: isPlan ? 'rgba(124,92,255,.14)' : 'rgba(59,169,255,.1)'
      }}
    >
      {isPlan ? '本次方案' : '已归档'}
    </span>
  );
}

/**
 * 番剧选择器：**下拉框 + 搜索**。
 *
 * 默认收起，只占一行；点开（或直接输入）才会浮出候选面板，
 * 因此不会像常驻列表那样占掉对话框一半高度。
 *
 * 候选来自两处：本次归档方案（文件夹还没创建也能选）+ 归档目录里已存在的。
 */
function AnimePicker({
  planDirs,
  loadDirs,
  onPick,
  placeholder = '输入番剧名 / 年份检索，或点击查看全部'
}: {
  planDirs: DirItem[];
  loadDirs: () => Promise<DirItem[]>;
  onPick: (d: DirItem) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [disk, setDisk] = useState<DirItem[] | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    void loadDirs().then(list => { if (alive) setDisk(list); });
    return () => { alive = false; };
  }, [loadDirs]);

  // 点击外部 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const all = useMemo(() => mergeDirItems(planDirs, disk ?? []), [planDirs, disk]);
  const list = useMemo(() => {
    const key = q.trim().toLowerCase();
    const out = key
      ? all.filter(d => d.name.toLowerCase().includes(key) || (d.year ? `${d.year}-${pad(d.month ?? '')}`.includes(key) : false))
      : all;
    return out.slice(0, 200);
  }, [all, q]);

  const pick = (d: DirItem): void => {
    onPick(d);
    setOpen(false);
    setQ('');
  };

  const planCount = planDirs.length;
  const diskCount = (disk ?? []).length;

  return (
    <div className="field" ref={boxRef} style={{ position: 'relative' }}>
      <span className="fk">快速选择</span>
      <div className="combo">
        <span className="ico">🔍</span>
        <input
          value={q}
          spellCheck={false}
          placeholder={placeholder}
          onFocus={() => setOpen(true)}
          onChange={e => { setQ(e.target.value); setOpen(true); }}
        />
        {q
          ? <span className="clear" onClick={() => setQ('')}>✕</span>
          : <span className="caret" onClick={() => setOpen(v => !v)}>{open ? '▴' : '▾'}</span>}
      </div>
      <span className="combo-hint">
        本次方案 <b>{planCount}</b> · 已归档 <b>{disk === null ? '…' : diskCount}</b>
      </span>

      {open && (
        <div className="combo-pop">
          {disk === null && !planCount && <div className="ft-hint" style={{ padding: '8px 10px' }}>读取中…</div>}
          {!list.length && (disk !== null || planCount > 0) && (
            <div className="ft-hint" style={{ padding: '8px 10px' }}>
              {all.length ? '没有匹配的番剧' : '本次方案里还没有已识别的番剧，归档目录也还是空的 —— 请手动填写名称与年月'}
            </div>
          )}
          {list.map(d => (
            <div
              className="combo-item"
              key={`${d.from ?? 'disk'}|${d.relPath}|${d.year}-${d.month}`}
              onMouseDown={e => { e.preventDefault(); pick(d); }}
            >
              <span className="ci-name">{d.name}</span>
              <SourceBadge from={d.from} />
              <span className="ci-year">{d.year ? `${d.year}-${pad(d.month ?? '')}` : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResolveDialog({
  groups, loadDirs, planDirs = [], sameKeyCount = 0, onApply, onDefer, onClose
}: {
  /** 目标分组（1 个 = 单选；多个 = 批量） */
  groups: AnimeGroup[];
  /** 加载「已归档的番剧文件夹」列表，便于直接选择而无需重复输入 */
  loadDirs: () => Promise<DirItem[]>;
  /** 本次归档方案里已识别出的番剧（含尚未创建的文件夹） */
  planDirs?: DirItem[];
  /** 与该组同名同季、也会一并被应用的分组数量 */
  sameKeyCount?: number;
  onApply: (p: { zhName: string; year: number; month: number; saveAlias: boolean; applySameKey: boolean }) => void;
  onDefer: (p: { zhName: string; year: number; month: number }) => void;
  onClose: () => void;
}) {
  const primary = groups[0];
  const isBatch = groups.length > 1;
  const isUnknown = groups.every(g => g.status === 'unrecognized');
  const cands = useMemo(() => primary?.resolution?.candidates ?? [], [primary]);

  const [sel, setSel] = useState<number>(cands.length ? 0 : -1);
  const [name, setName] = useState(cands.length ? cands[0].name : primary?.zhName || '');
  const [year, setYear] = useState(primary?.year ? String(primary.year) : '');
  const [month, setMonth] = useState(primary?.month ? pad(primary.month) : '');
  const [save, setSave] = useState(true);
  const [applySame, setApplySame] = useState(true);
  const [err, setErr] = useState('');

  const pickCandidate = (i: number) => {
    setSel(i);
    const c = i >= 0 ? cands[i] : undefined;
    if (!c) return;
    setName(c.name);
    if (c.year) setYear(String(c.year));
    if (c.month) setMonth(pad(c.month));
  };

  const pickDir = (d: DirItem) => {
    setName(d.name);
    if (d.year) setYear(String(d.year));
    if (d.month) setMonth(pad(d.month));
    setSel(-1);
    setErr('');
  };

  const submit = () => {
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    const finalName = name.trim() || (isUnknown ? '' : primary?.rawNames[0] ?? '');
    if (!finalName) { setErr('请填写番剧名（或用上方「快速选择」挑一个）'); return; }
    if (!y || !m || m < 1 || m > 12) { setErr('请填写合法的首播年份与月份（1–12）'); return; }
    onApply({ zhName: finalName, year: y, month: m, saveAlias: save, applySameKey: applySame });
  };

  const rawLabel = groups
    .map(g => (g.aliasQuery?.[0] || g.rawNames[0] || g.items[0]?.scanItem.name || '—'))
    .slice(0, 3)
    .join('  /  ');

  return (
    <Modal
      title={`🔎 ${isUnknown ? '指定番剧名' : '人工确认番剧名'}${isBatch ? `（批量 · ${groups.length} 组）` : ''} · 原始名「${rawLabel}${groups.length > 3 ? ' …' : ''}」`}
      width={820}
      onClose={onClose}
      footer={
        <>
          <button
            style={{ marginRight: 'auto' }}
            onClick={() => onDefer({ zhName: name.trim(), year: parseInt(year, 10) || 0, month: parseInt(month, 10) || 0 })}
          >
            ⏸ 暂不处理 → _待确认/
          </button>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={submit}>
            {isBatch ? `确认并应用到 ${groups.length} 组` : '确认并加入归档方案'}
          </button>
        </>
      }
    >
      <div className="warn-box">
        {isBatch
          ? `将把下面填写的番剧名与首播年月一次性应用到选中的 ${groups.length} 个分组。`
          : isUnknown
            ? '无法从文件名解析出有效番剧名。请手动指定名称与首播年月，否则该文件将移入 _未识别/。'
            : `置信度 ${((primary?.resolution?.confidence ?? 0) * 100).toFixed(0)}% 低于自动阈值，请从候选 / 已归档文件夹中选择，或手动输入。`}
      </div>

      {!isBatch && (
        <>
          <div className="kv"><span className="k">原始组名</span><span className="v">{groupRawText(primary)}</span></div>
          <div className="kv">
            <span className="k">匹配信息</span>
            <span className="v">
              {primary?.resolution?.matchLevel ?? '—'} · 来源 {sourceLabel(primary?.resolution?.dataSource)}
              {primary?.note ? ` · ${primary.note}` : ''}
            </span>
          </div>
          {primary?.resolution?.note && (
            <div className="kv"><span className="k">命中方式</span><span className="v">🔎 {primary.resolution.note}</span></div>
          )}
          {primary?.resolution?.timeNote && (
            <div className="kv"><span className="k">时间线索</span><span className="v">🕒 {primary.resolution.timeNote}</span></div>
          )}
        </>
      )}

      {/* ---------- 快速选择：下拉框 + 搜索（本次方案 + 已归档文件夹） ---------- */}
      <AnimePicker planDirs={planDirs} loadDirs={loadDirs} onPick={pickDir} />

      {/* ---------- 候选都不对？直接联网查 Bangumi ---------- */}
      <BangumiSearch
        initialQuery={primary?.aliasQuery?.[0] || primary?.rawNames?.[0] || ''}
        onPick={r => pickDir({ name: (r.nameCn || r.name).trim(), year: r.year, month: r.month, relPath: '', from: 'plan' })}
      />

      {/* ---------- 候选列表 ---------- */}
      {!!cands.length && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {cands.map((c, i) => (
            <Opt
              key={`${c.name}-${i}`}
              on={sel === i}
              onSelect={() => pickCandidate(i)}
              title={c.webMatched ? `✅ ${c.name}` : c.name}
              desc={
                <>
                  {c.source}
                  {c.year ? ` · 首播 ${c.year}-${pad(c.month ?? '')}` : ''}
                  {c.bangumiId ? ` · bgm${c.bangumiId}` : ''}
                  {c.webMatched ? ' · 网页还原名精确命中' : ''}
                  {c.timeRelation === 'future'
                    ? ' · ⚠ 首播晚于文件时间'
                    : c.timeRelation === 'same'
                      ? ' · 🕒 与文件时间同季'
                      : ''}
                </>
              }
              side={c.fromPrior ? `Bangumi 相关度 #${(c.rank ?? 0) + 1}` : `相似度 ${(c.score * 100).toFixed(0)}%`}
            />
          ))}
        </div>
      )}

      <div className="field">
        <span className="fk">番剧名</span>
        <input
          value={name}
          spellCheck={false}
          placeholder="留空则使用日文原名"
          onChange={e => { setName(e.target.value); setSel(-1); }}
        />
      </div>
      <div className="field">
        <span className="fk">首播年份</span>
        <input value={year} spellCheck={false} placeholder="如 2022" onChange={e => setYear(e.target.value)} />
      </div>
      <div className="field">
        <span className="fk">首播月份</span>
        <input value={month} spellCheck={false} placeholder="如 04" onChange={e => setMonth(e.target.value)} />
      </div>

      <label className="field" style={{ cursor: 'pointer' }}>
        <span className="fk">写回别名表</span>
        <input
          type="checkbox"
          checked={save}
          onChange={e => setSave(e.target.checked)}
          style={{ flex: 'none', width: 'auto', accentColor: 'var(--accent)' }}
        />
        <span style={{ color: 'var(--txt-3)', fontSize: 11.5 }}>下次遇到相同名称直接命中（L1）</span>
      </label>

      {!isBatch && sameKeyCount > 0 && (
        <label className="field" style={{ cursor: 'pointer' }}>
          <span className="fk">批量应用</span>
          <input
            type="checkbox"
            checked={applySame}
            onChange={e => setApplySame(e.target.checked)}
            style={{ flex: 'none', width: 'auto', accentColor: 'var(--accent)' }}
          />
          <span style={{ color: 'var(--txt-3)', fontSize: 11.5 }}>
            同时应用到其它 <b>{sameKeyCount}</b> 个同名（同季）分组
          </span>
        </label>
      )}

      {err && <div className="warn-box" style={{ background: 'rgba(239,85,102,.1)', borderColor: 'rgba(239,85,102,.4)', color: '#ff9aa5' }}>{err}</div>}
    </Modal>
  );
}

function groupRawText(g?: AnimeGroup): string {
  if (!g) return '—';
  const q = (g.aliasQuery ?? []).filter(Boolean);
  const names = q.length ? q : g.rawNames;
  const extra = g.items.length > 1 ? `（该组共 ${g.items.length} 个文件）` : '';
  return `${names.join(' / ') || g.items[0]?.scanItem.name || '—'}${extra}`;
}

/* =========================================================
   ✏️ 重命名（仅番剧文件夹名）
   ========================================================= */

export function RenameDialog({
  title, locationHint, initial, note, onApply, onClose
}: {
  title: string;
  locationHint: ReactNode;
  initial: string;
  note: ReactNode;
  onApply: (v: string) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [err, setErr] = useState('');

  const submit = () => {
    const v = value.trim();
    if (!v) { setErr('文件夹名不能为空'); return; }
    if (/[\\/:*?"<>|]/.test(v)) { setErr('名称含非法字符 \\ / : * ? " < > |'); return; }
    if (v.length > 120) { setErr('名称过长（>120 字符）'); return; }
    onApply(v);
  };

  return (
    <Modal
      title={title}
      width={720}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={submit}>应用</button>
        </>
      }
    >
      <div className="kv"><span className="k">位置</span><span className="v">{locationHint}</span></div>
      <div className="field">
        <span className="fk">文件夹名</span>
        <input value={value} spellCheck={false} onChange={e => setValue(e.target.value)} />
      </div>
      <div className="warn-box" style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--txt-3)' }}>
        {note}
      </div>
      {err && <div className="warn-box" style={{ background: 'rgba(239,85,102,.1)', borderColor: 'rgba(239,85,102,.4)', color: '#ff9aa5' }}>{err}</div>}
    </Modal>
  );
}

/* =========================================================
   🔍 Bangumi 在线检索（弹窗内的「现查」入口）

   目的：手动确认 / 分开归档时，不必再另开浏览器去 bgm.tv 查条目 ——
   输入关键词（**繁体会自动转成简体再检索**）→ 选一条 → 自动填好
   「番剧名（优先官方中文名）+ 首播年份 + 首播月份」。
   ========================================================= */

export function BangumiSearch({
  onPick,
  initialQuery = '',
  auto = false
}: {
  onPick: (r: BangumiHit) => void;
  /** 打开弹窗时预填的关键词（一般是当前识别到的名字） */
  initialQuery?: string;
  /** 是否在打开后自动搜一次 */
  auto?: boolean;
}) {
  const [q, setQ] = useState(initialQuery);
  const [busy, setBusy] = useState(false);
  const [hits, setHits] = useState<BangumiHit[] | null>(null);
  const [tried, setTried] = useState<string[]>([]);
  const [open, setOpen] = useState(auto);
  const [err, setErr] = useState('');
  const seq = useRef(0);

  const run = async (kw: string) => {
    const k = kw.trim();
    if (k.length < 2) { setHits(null); setErr(''); return; }
    const my = ++seq.current;
    setBusy(true);
    setErr('');
    try {
      const res = await api.bangumiSearch(k, 8);
      if (my !== seq.current) return;    // 只认最后一次请求的结果
      setHits(res.results);
      setTried(res.tried ?? []);
      if (!res.online && !res.results.length) setErr('无法访问 Bangumi（可能是网络或限流），只查了本地缓存');
    } catch (e) {
      if (my === seq.current) { setErr((e as Error).message); setHits([]); }
    } finally {
      if (my === seq.current) setBusy(false);
    }
  };

  // 输入去抖自动检索（600ms）
  useEffect(() => {
    if (!open) return;
    const k = q.trim();
    if (k.length < 2) { setHits(null); return; }
    const t = setTimeout(() => { void run(k); }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open]);

  const fmt = (r: BangumiHit) => (r.nameCn && r.nameCn !== r.name ? r.nameCn : r.name) || r.name;

  return (
    <div className="bgm-search">
      <div className="field" style={{ marginBottom: 0 }}>
        <span className="fk">🔍 查 Bangumi</span>
        <input
          value={q}
          spellCheck={false}
          placeholder="输入番剧名（简繁皆可，会自动转简体检索）"
          onChange={e => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void run(q); } }}
        />
        <button className="mini" onClick={() => { setOpen(true); void run(q); }} disabled={busy || q.trim().length < 2}>
          {busy ? '搜索中…' : '搜索'}
        </button>
      </div>

      {open && (
        <div className="bgm-hits">
          {err && <div className="ft-hint" style={{ color: '#ffd47a', padding: '4px 2px' }}>⚠ {err}</div>}
          {!busy && q.trim().length < 2 && (
            <div className="ft-hint" style={{ padding: '4px 2px' }}>
              输入 2 个字以上即自动检索；选中后会自动填好番剧名与首播年月。
            </div>
          )}
          {hits !== null && !hits.length && !err && (
            <div className="ft-hint" style={{ padding: '4px 2px' }}>
              没有匹配的条目{tried.length > 1 ? `（已尝试：${tried.join(' / ')}）` : ''}，换个写法试试
            </div>
          )}
          {hits?.map(r => (
            <div className="bgm-hit" key={r.id} onMouseDown={e => { e.preventDefault(); onPick(r); }}>
              <span className="bh-name">{fmt(r)}</span>
              {r.nameCn && r.name !== r.nameCn && <span className="bh-jp">{r.name}</span>}
              <span className="bh-date">{r.year ? `${r.year}-${pad(r.month ?? '')}` : '年份未知'}</span>
            </div>
          ))}
          {!!hits?.length && (
            <div className="ft-hint" style={{ padding: '4px 2px', opacity: .75 }}>
              共 {hits.length} 条{tried.length > 1 ? ` · 已尝试：${tried.join(' / ')}` : ''} · 点一条即填入下方表单
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* =========================================================
   ↗ 单独调整：把某个（或一批）文件/文件夹从原组拆出来，归到另一部番剧
   ========================================================= */

/** 待调整的条目 */
export interface MoveItemTarget {
  path: string;
  name: string;
  isDir: boolean;
}

export function MoveItemDialog({
  items,
  currentTarget,
  loadDirs,
  planDirs = [],
  mode = 'plan',
  busy,
  onApply,
  onClose
}: {
  /** 要一起调整的条目（1 个 = 单选；多个 = 批量） */
  items: MoveItemTarget[];
  /** 它们当前所在的归档位置（提示用） */
  currentTarget: string;
  loadDirs: () => Promise<DirItem[]>;
  /** 本次归档方案里已识别出的番剧（含尚未创建的文件夹） */
  planDirs?: DirItem[];
  /**
   * 语义模式（决定文案与警告强度，行为由调用方决定）：
   *  - `plan`  —— 只改方案（文件还没搬）
   *  - `disk`  —— 文件**已经在归档目录里**，这次会真实移动磁盘文件
   *  - `mixed` —— 两者都有（如整组调整）
   */
  mode?: 'plan' | 'disk' | 'mixed';
  /**
   * 正在执行：弹窗**保持打开**并锁住两个按钮。
   *
   * 为什么不能先关再干：NAS 上搬几个 GB 要好几十秒，关掉后界面一点动静都没有，
   * 用户会以为没生效 → 再点一次 → 重复移动同一个文件（还会生成 ` (1)` 副本）。
   */
  busy?: { note: string } | null;
  onApply: (p: { zhName: string; year: number; month: number }) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [year, setYear] = useState('');
  const [month, setMonth] = useState('');
  const [err, setErr] = useState('');
  const n = items.length;
  const isBatch = n > 1;
  const dirCount = items.filter(i => i.isDir).length;

  const title = mode === 'disk'
    ? (isBatch
        ? `↗ 二次整理 · 把 ${n} 个已归档条目移到另一部番剧`
        : items[0]?.isDir
          ? '↗ 二次整理 · 把这个已归档文件夹移到另一部番剧'
          : '↗ 二次整理 · 把这个已归档文件移到另一部番剧')
    : mode === 'mixed'
      ? `↗ 二次整理 · 把 ${n} 个条目改归到另一部番剧（含已归档）`
      : (isBatch ? `↗ 批量单独调整 · 把 ${n} 个条目一起归到另一部番剧` : '↗ 单独调整 · 把该条目归到另一部番剧');

  const pickDir = (d: DirItem) => {
    setName(d.name);
    setYear(d.year ? String(d.year) : '');
    setMonth(d.month ? pad(d.month) : '');
    setErr('');
  };

  const submit = () => {
    const v = name.trim();
    const y = parseInt(year, 10);
    const m = parseInt(month, 10);
    if (!v) { setErr('请选择或填写目标番剧名'); return; }
    if (!y || !m || m < 1 || m > 12) { setErr('请填写合法的首播年份与月份（1–12）'); return; }
    onApply({ zhName: v, year: y, month: m });
  };

  return (
    <Modal
      title={title}
      width={800}
      onClose={onClose}
      footer={
        <>
          <button style={{ marginRight: 'auto' }} disabled={!!busy} onClick={onClose}>取消</button>
          <button className="primary" disabled={!!busy} onClick={submit}>
            {busy ? '处理中…' : isBatch ? `应用到 ${n} 个条目` : '应用调整'}
          </button>
        </>
      }
    >
      {busy && (
        <div className="op-busy">
          <span className="spin" />
          <span>{busy.note}</span>
        </div>
      )}
      <div className="warn-box">
        {mode === 'disk' ? (
          <>
            将把下面这 <b>{n}</b> 个条目（{dirCount ? `其中 ${dirCount} 个文件夹` : '全部为文件'}）
            <b>真实移入目标番剧文件夹</b> —— 它们已经在归档目录里了，所以这次是<b>真的动磁盘</b>。
            目标已有同名文件时自动加 <code> (1)</code>，<b>绝不覆盖</b>；每个条都会记入日志。
          </>
        ) : mode === 'mixed' ? (
          <>
            混合处理：其中<b>已经在磁盘上</b>的会被<b>真实移动</b>；<b>还没搬</b>的只改方案（记入方案记忆）。
            目标同名一律自动加 <code> (1)</code>，绝不覆盖。
          </>
        ) : isBatch
          ? <>将把下面这 <b>{n}</b> 个条目（{dirCount ? `其中 ${dirCount} 个文件夹` : '全部为文件'}）<b>一起</b>从原分组拆出，改归到同一部番剧；原分组里的其它文件不受影响。</>
          : <>只调整<b>这一个</b>条目（{items[0]?.isDir ? '文件夹' : '文件'}），同一组的其它文件不受影响。</>}
        {mode === 'plan' ? '调整结果会记入「方案记忆」，重新扫描后自动生效。' : ''}
      </div>

      <div className="kv"><span className="k">当前将归入</span><span className="v">{currentTarget || '—'}（{n} 个条目均在此）</span></div>

      <div className="field" style={{ alignItems: 'flex-start' }}>
        <span className="fk">待调整条目</span>
        <div className="move-list">
          {items.map(it => (
            <div key={it.path} className="move-row">
              <span className="mr-name">{it.isDir ? '📁' : '🎬'} {it.name}</span>
              <span className="mr-path" title={it.path}>{it.path}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ---------- 快速选择：下拉框 + 搜索（本次方案 + 已归档文件夹） ---------- */}
      <AnimePicker
        planDirs={planDirs}
        loadDirs={loadDirs}
        onPick={pickDir}
        placeholder="输入目标番剧名 / 年份检索，或点击查看全部"
      />

      {/* ---------- 列表里没有？直接联网查 Bangumi ---------- */}
      <BangumiSearch
        initialQuery={items[0]?.name ?? ''}
        onPick={r => { setName((r.nameCn || r.name).trim()); setYear(r.year ? String(r.year) : ''); setMonth(r.month ? pad(r.month) : ''); setErr(''); }}
      />

      <div className="field">
        <span className="fk">番剧名</span>
        <input
          value={name}
          spellCheck={false}
          placeholder="从上方快速选择」挑，或手动输入"
          onChange={e => { setName(e.target.value); setErr(''); }}
        />
      </div>
      <div className="field">
        <span className="fk">首播年份</span>
        <input value={year} spellCheck={false} placeholder="如 2021" onChange={e => { setYear(e.target.value); setErr(''); }} />
      </div>
      <div className="field">
        <span className="fk">首播月份</span>
        <input value={month} spellCheck={false} placeholder="如 01" onChange={e => { setMonth(e.target.value); setErr(''); }} />
      </div>

      {name.trim() && (!parseInt(year, 10) || !parseInt(month, 10)) && (
        <div className="warn-box" style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--txt-3)' }}>
          ⚠ 该名称在已归档文件夹中不存在，请同时填写首播年份与月份。
        </div>
      )}

      {err && <div className="warn-box" style={{ background: 'rgba(239,85,102,.1)', borderColor: 'rgba(239,85,102,.4)', color: '#ff9aa5' }}>{err}</div>}
    </Modal>
  );
}
