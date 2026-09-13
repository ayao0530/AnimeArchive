import { useApp } from '../store';

export default function BusyOverlay() {
  const busy = useApp(s => s.busy);
  const stopExecute = useApp(s => s.stopExecute);
  if (!busy) return null;

  return (
    <div className="busy">
      <div className="box">
        <div className="t" title={busy.title}>
          <span className="spin" style={{ flex: 'none' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {busy.title}
          </span>
        </div>
        <div className="progress-wrap on">
          <div className="progress-bar" style={{ width: `${busy.percent}%` }} />
        </div>
        <div className="cur" title={busy.current}>{busy.current || '\u00a0'}</div>
        <div className="hintline">
          <span className="grow">
            {busy.hint ?? (busy.stoppable
              ? '随时可停止：停止后可以「继续归档」，也可以「撤销整批」'
              : `已完成 ${busy.percent}%（单次整理量建议 < 1000 个文件）`)}
          </span>
          {busy.stoppable ? (
            <button className="mini stop" onClick={() => void stopExecute()}>⏹ 停止归档</button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
