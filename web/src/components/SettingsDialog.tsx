/**
 * ⚙ 设置：归一化数据源与置信度参数
 *
 *  - 前置网页检索：把罗马音 / 英文标题还原成日文原名后再回查 Bangumi
 *  - Google Programmable Search：可选，填了才走 Google，否则只用免费的 AniList / Jikan
 *  - 文件修改时间：作为「首播时间不会晚于下载时间」的旁证参与置信度加权
 */
import { useState } from 'react';
import { useApp } from '../store';
import { Modal } from './Dialogs';

function Switch({
  on, onChange, title, desc, disabled
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <label
      className="field"
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', alignItems: 'flex-start', opacity: disabled ? .5 : 1 }}
    >
      <span className="fk">{title}</span>
      <input
        type="checkbox"
        checked={on}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        style={{ flex: 'none', width: 'auto', marginTop: 2, accentColor: 'var(--accent)' }}
      />
      <span style={{ color: 'var(--txt-3)', fontSize: 11.5, lineHeight: 1.75 }}>{desc}</span>
    </label>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const config = useApp(s => s.config);
  const saveSettings = useApp(s => s.saveSettings);
  const serviceOnline = useApp(s => s.serviceOnline);

  const [webSearch, setWebSearch] = useState(config?.webSearchEnabled !== false);
  const [useFileTime, setUseFileTime] = useState(config?.useFileTime !== false);
  const [bangumi, setBangumi] = useState(config?.bangumiEnabled !== false);
  const [gKey, setGKey] = useState(config?.googleApiKey ?? '');
  const [gCx, setGCx] = useState(config?.googleCx ?? '');
  const [review, setReview] = useState(String(config?.reviewThreshold ?? 0.7));
  const [auto, setAuto] = useState(String(config?.autoThreshold ?? 0.9));
  const [conc, setConc] = useState(String(config?.scanConcurrency ?? 10));
  const [err, setErr] = useState('');

  const submit = () => {
    const r = parseFloat(review);
    const a = parseFloat(auto);
    const c = parseInt(conc, 10);
    if (!(r > 0 && r < 1) || !(a > 0 && a <= 1)) { setErr('阈值需为 0~1 之间的小数（如 0.7 / 0.9）'); return; }
    if (r >= a) { setErr('「待确认阈值」必须小于「自动归档阈值」'); return; }
    if (!(c >= 1 && c <= 32)) { setErr('并发度需为 1~32 之间的整数（建议 10）'); return; }
    void saveSettings({
      webSearchEnabled: webSearch,
      useFileTime,
      bangumiEnabled: bangumi,
      googleApiKey: gKey.trim(),
      googleCx: gCx.trim(),
      scanConcurrency: c,
      reviewThreshold: r,
      autoThreshold: a
    });
    onClose();
  };

  const googleReady = Boolean(gKey.trim() && gCx.trim());

  return (
    <Modal
      title="⚙ 设置 · 归一化数据源与置信度"
      width={760}
      onClose={onClose}
      footer={
        <>
          <button style={{ marginRight: 'auto' }} onClick={onClose}>取消</button>
          <button className="primary" onClick={submit} disabled={!serviceOnline}>保存并应用</button>
        </>
      }
    >
      {!serviceOnline && <div className="warn-box">⚠ 本地服务未启动，设置无法保存。</div>}
      <div className="warn-box" style={{ background: 'var(--bg-3)', borderColor: 'var(--line)', color: 'var(--txt-3)' }}>
        ℹ 修改后<b>在下次扫描时生效</b>（已生成的方案不会重算）。所有检索仅在本机发起，不发送任何文件内容。
      </div>

      <Switch
        on={useFileTime}
        onChange={setUseFileTime}
        title="① 文件修改时间"
        desc="用文件的修改时间（≈ 下载/拷入时间）校验首播时间：番剧首播不可能晚于文件时间，同季追番则加权。对「续作 vs 第一季」的区分特别有效，零联网开销。"
      />
      <Switch
        on={webSearch}
        onChange={setWebSearch}
        disabled={!bangumi}
        title="② 前置网页检索"
        desc="先用网页检索把罗马音 / 英文标题还原成日文原名或中文译名（如 Hataraku Saibou!! → はたらく細胞!!），再拿还原后的名字去 Bangumi 精确查询，避免「罗马音 ↔ 中文译名算不出相似度」导致的低置信度。"
      />
      <Switch
        on={bangumi}
        onChange={setBangumi}
        title="③ Bangumi 在线查询"
        desc="官方中文名与首播年月的权威来源。关闭后只使用本地别名表与网页检索结果。"
      />

      <div className="kv">
        <span className="k">检索源</span>
        <span className="v">
          <b>{googleReady ? 'Google → Wikipedia → Kitsu' : 'Wikipedia → Kitsu → AniList → Jikan'}</b>
          <br />
          <span style={{ color: 'var(--txt-3)' }}>
            {googleReady
              ? '已配置 Google Programmable Search，将优先使用并降低成本'
              : '未配置 Google：使用免费的 Wikipedia / Kitsu / AniList / Jikan，效果等价；如需走 Google 请在下方填写'}
            <br />
            多个源并行发起，谁先给出「含中日文的标题」就用谁，其余源不会拖慢扫描。
          </span>
        </span>
      </div>

      <div className="field">
        <span className="fk">Google API Key</span>
        <input
          value={gKey}
          spellCheck={false}
          placeholder="留空 = 不启用 Google（可选）"
          onChange={e => { setGKey(e.target.value); setErr(''); }}
        />
      </div>
      <div className="field">
        <span className="fk">Google 搜索引擎 ID</span>
        <input
          value={gCx}
          spellCheck={false}
          placeholder="Programmable Search Engine 的 cx，如 1a2b3c4d5e6f7g8h9"
          onChange={e => { setGCx(e.target.value); setErr(''); }}
        />
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--txt-3)', lineHeight: 1.8 }}>
        获取方式：<span className="mono">console.cloud.google.com</span> 启用 <b>Custom Search API</b> 拿 Key；
        <span className="mono">programmablesearchengine.google.com</span> 建一个搜索引擎拿 cx（免费额度 100 次/天）。
      </div>

      <div className="field">
        <span className="fk">待确认阈值</span>
        <input value={review} spellCheck={false} onChange={e => { setReview(e.target.value); setErr(''); }} />
        <span style={{ color: 'var(--txt-3)', fontSize: 11.5 }}>低于此值 → 必须人工确认（默认 0.7）</span>
      </div>
      <div className="field">
        <span className="fk">自动归档阈值</span>
        <input value={auto} spellCheck={false} onChange={e => { setAuto(e.target.value); setErr(''); }} />
        <span style={{ color: 'var(--txt-3)', fontSize: 11.5 }}>达到此值 → 直接归入（默认 0.9）</span>
      </div>

      <div className="field">
        <span className="fk">扫描并发度</span>
        <input value={conc} spellCheck={false} onChange={e => { setConc(e.target.value); setErr(''); }} />
        <span style={{ color: 'var(--txt-3)', fontSize: 11.5 }}>
          同时进行的目录/文件读取数（默认 10）。NAS/SMB 上每次读写都是一个网络往返，<b>并发才是提速关键</b>：
          建议 NAS 用 8~16，本地磁盘用 4~8。
        </span>
      </div>

      {err && <div className="warn-box" style={{ background: 'rgba(239,85,102,.1)', borderColor: 'rgba(239,85,102,.4)', color: '#ff9aa5' }}>{err}</div>}
    </Modal>
  );
}
