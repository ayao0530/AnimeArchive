import { useMemo, useState } from 'react';
import { useApp } from '../store';
import { formatSize } from '../utils';
import { Modal } from './Dialogs';
import { SettingsDialog } from './SettingsDialog';

const THEME_LABEL = { system: '🌓 跟随系统', dark: '🌙 深色', light: '☀️ 浅色' } as const;

/** 执行归档前的二次确认弹窗 */
function ExecuteConfirm({ onClose }: { onClose: () => void }) {
  const plan = useApp(s => s.plan);
  const groups = useApp(s => s.groups);
  const decisions = useApp(s => s.decisions);
  const decisionOf = useApp(s => s.decisionOf);
  const execute = useApp(s => s.execute);
  const targetStatus = useApp(s => s.targetStatus);
  const createTargetRoot = useApp(s => s.createTargetRoot);

  const targetBlocked = !!targetStatus?.checked && (!targetStatus.exists || !targetStatus.writable);

  const summary = useMemo(() => {
    const entries = plan?.entries ?? [];
    const chosen = entries.filter(e => (decisions[e.groupId] ?? decisionOf(e.groupId, e.status)).execute);
    const size = chosen.reduce((a, e) => a + e.size, 0);
    const byStatus = (st: string) => chosen.filter(e => e.status === st).length;
    const untouched = groups.filter(g => !(decisions[g.groupId] ?? decisionOf(g.groupId, g.status)).execute).length;
    return {
      total: chosen.length,
      size,
      ready: byStatus('ready'),
      conflict: byStatus('conflict'),
      review: byStatus('review'),
      unrecognized: byStatus('unrecognized'),
      deferred: byStatus('deferred'),
      untouched
    };
  }, [plan, groups, decisions, decisionOf]);

  return (
    <Modal
      title="▶ 执行归档 · 请确认"
      width={620}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() => { onClose(); void execute(); }}
            disabled={summary.total === 0 || targetBlocked}
          >
            确认执行（剪切移动）
          </button>
        </>
      }
    >
      {targetBlocked && (
        <div className="warn-box">
          ⚠ <b>归档根目录{targetStatus?.exists ? '不可写' : '不存在'}</b>：
          <span style={{ fontFamily: 'Consolas,monospace' }}> {plan?.targetRoot ?? '—'}</span>
          <br />
          出于安全考虑，程序<b>不会</b>自动创建归档根目录（以免在 NAS 断开时把文件移错位置）。
          请先
          <button
            className="mini"
            style={{ margin: '0 6px' }}
            onClick={() => void createTargetRoot()}
            disabled={!!targetStatus?.exists && !targetStatus?.writable}
          >
            ➕ 创建归档目录
          </button>
          后再执行。
        </div>
      )}
      <div className="warn-box">
        ⚠ 即将按方案执行 <b>剪切（移动）</b>：源文件不会保留。每一项都会写入日志，可整批撤销或单文件撤回。
      </div>
      <div className="kv"><span className="k">源目录</span><span className="v">{plan?.sourceRoot ?? '—'}</span></div>
      <div className="kv"><span className="k">归档根</span><span className="v">{plan?.targetRoot ?? '—'}</span></div>
      <div className="kv">
        <span className="k">本次移动</span>
        <span className="v">
          {summary.total} 项 · {formatSize(summary.size)}
          <br />
          <span style={{ color: 'var(--txt-3)' }}>
            可归档 {summary.ready} / 冲突改名 {summary.conflict} / 人工确认 {summary.review}
            {summary.unrecognized ? ` / 未识别入 _未识别 ${summary.unrecognized}` : ''}
            {summary.deferred ? ` / 待确认入 _待确认 ${summary.deferred}` : ''}
          </span>
        </span>
      </div>
      <div className="kv">
        <span className="k">不处理</span>
        <span className="v">{summary.untouched} 组（保持原样，不会被移动）</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--txt-3)', lineHeight: 1.8 }}>
        ℹ 冲突项默认「自动重命名 (1)」；同集多版本全部保留；文件名永不改动；已归档完成后会自动重建媒体库索引。
      </div>
    </Modal>
  );
}

export default function TopBar() {
  const view = useApp(s => s.view);
  const setView = useApp(s => s.setView);
  const sourceRoot = useApp(s => s.sourceRoot);
  const targetRoot = useApp(s => s.targetRoot);
  const setPaths = useApp(s => s.setPaths);
  const scan = useApp(s => s.scan);
  const undoBatch = useApp(s => s.undoBatch);
  const busy = useApp(s => s.busy);
  const serviceOnline = useApp(s => s.serviceOnline);
  const servicePort = useApp(s => s.servicePort);
  const cycleTheme = useApp(s => s.cycleTheme);
  const themeIdx = useApp(s => s.themeIdx);
  const shutdownService = useApp(s => s.shutdownService);
  const reconnect = useApp(s => s.reconnect);
  const toggleLog = useApp(s => s.toggleLog);
  const logOpen = useApp(s => s.logOpen);
  const lastBatchId = useApp(s => s.lastBatchId);
  const plan = useApp(s => s.plan);

  const theme = (['system', 'dark', 'light'] as const)[themeIdx];
  const isArchive = view === 'archive';
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">🎬</span>
        <span>番剧归档助手</span>
        <span className="tag">本地单机版</span>
      </div>

      <div className="nav" id="nav">
        <span className={isArchive ? 'on' : ''} onClick={() => setView('archive')}>① 归档整理</span>
        <span className={!isArchive ? 'on' : ''} onClick={() => setView('library')}>② 媒体库</span>
      </div>

      {isArchive && (
        <>
          <div className="paths" id="pathsArchive">
            <div className="path-group">
              <label>源目录</label>
              <input
                id="srcPath"
                value={sourceRoot}
                spellCheck={false}
                placeholder="\\NAS\Media"
                onChange={e => setPaths(e.target.value, targetRoot)}
              />
            </div>
            <span className="arrow-sep">➜</span>
            <div className="path-group">
              <label>归档根目录</label>
              <input
                id="dstPath"
                value={targetRoot}
                spellCheck={false}
                placeholder="\\NAS\Media\已看\Anime"
                onChange={e => setPaths(sourceRoot, e.target.value)}
              />
            </div>
          </div>

          <div className="actions" id="actionsArchive">
            <button onClick={() => void scan()} disabled={!!busy || !serviceOnline}>↻ 重新扫描</button>
            <button onClick={() => void undoBatch()} disabled={!!busy || !lastBatchId || !serviceOnline}>↩ 撤销整批</button>
            <button className="primary" onClick={() => setConfirmOpen(true)} disabled={!!busy || !plan || !serviceOnline}>▶ 执行归档</button>
            <button onClick={() => toggleLog()} title="查看变更日志">📜 日志{logOpen ? '（已开）' : ''}</button>
          </div>
        </>
      )}

      {confirmOpen && <ExecuteConfirm onClose={() => setConfirmOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}

      <span className={`svc${serviceOnline ? '' : ' off'}`} id="svcState">
        <span className="dot" />
        <span>
          {serviceOnline
            ? `本地服务运行中 · 127.0.0.1:${servicePort}`
            : '本地服务已停止 · 仅可浏览'}
        </span>
      </span>

      <button
        className="theme-btn"
        onClick={() => setSettingsOpen(true)}
        title="设置：网页检索 / 文件修改时间 / 置信度阈值"
      >
        ⚙ 设置
      </button>

      <button className="theme-btn" onClick={cycleTheme} title="切换主题（跟随系统 / 深色 / 浅色）">
        {THEME_LABEL[theme]}
      </button>

      {serviceOnline ? (
        <button className="theme-btn" onClick={() => void shutdownService()} title="一键关闭本地服务">⏻ 关闭服务</button>
      ) : (
        <button className="theme-btn" onClick={() => void reconnect()} title="重新检测 / 启动本地服务">⏻ 启动服务</button>
      )}
    </header>
  );
}
