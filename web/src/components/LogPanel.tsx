import { useEffect, useRef } from 'react';
import { useApp } from '../store';

export default function LogPanel() {
  const logOpen = useApp(s => s.logOpen);
  const logs = useApp(s => s.logs);
  const toggleLog = useApp(s => s.toggleLog);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [logs, logOpen]);

  return (
    <div className={`logpanel${logOpen ? ' on' : ''}`} id="logPanel">
      <header>
        <span>📜 变更日志（归档 / 播放 / 撤回 / 重命名）</span>
        <span className="close" onClick={() => toggleLog(false)}>✕</span>
      </header>
      <div className="log-body" id="logBody" ref={bodyRef}>
        {logs.length === 0 ? (
          <div className="log-line">
            <span className="msg" style={{ color: '#697691' }}>
              尚未有操作。可先扫描源目录并生成归档方案，或在「② 媒体库」点击 ▶ 播放 / ↩ 撤回。
            </span>
          </div>
        ) : (
          logs.map(l => (
            <div className={`log-line ${l.kind}`} key={l.id}>
              <span className="t">{l.time}</span>
              <span className="msg">{l.msg}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
