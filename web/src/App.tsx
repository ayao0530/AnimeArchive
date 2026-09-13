import { useEffect } from 'react';
import { useApp } from './store';
import TopBar from './components/TopBar';
import LogPanel from './components/LogPanel';
import BusyOverlay from './components/BusyOverlay';
import ArchiveView from './views/ArchiveView';
import LibraryView from './views/LibraryView';

export default function App() {
  const view = useApp(s => s.view);
  const boot = useApp(s => s.boot);
  const booted = useApp(s => s.booted);
  const serviceOnline = useApp(s => s.serviceOnline);
  const reconnect = useApp(s => s.reconnect);

  useEffect(() => { void boot(); }, [boot]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName ?? '').toUpperCase();
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        const input = document.querySelector<HTMLInputElement>(
          view === 'library' ? '#libQ' : '#archiveQ'
        );
        input?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  if (!booted) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--txt-2)', gap: 10 }}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
          <span className="spin" />
          <span>正在初始化…</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <TopBar />
      {!serviceOnline && (
        <div className="offline-bar">
          <span>⚠ 本地服务未启动 —— 当前为**只读浏览**模式：可查看 / 检索媒体库，播放、撤回、重命名、扫描与归档不可用。</span>
          <button className="mini" onClick={() => void reconnect()}>↻ 重新检测服务</button>
        </div>
      )}
      <div className="views" id="viewArchive" hidden={view !== 'archive'}>
        <ArchiveView />
      </div>
      <div className="views" id="viewLibrary" hidden={view !== 'library'}>
        <LibraryView />
      </div>
      <LogPanel />
      <BusyOverlay />
      <ToastHost />
    </>
  );
}

function ToastHost() {
  const toast = useApp(s => s.toast);
  return (
    <div id="toast" className={toast ? 'on' : ''} style={{ borderColor: toast?.color }}>
      <span>{toast?.msg ?? ''}</span>
    </div>
  );
}
