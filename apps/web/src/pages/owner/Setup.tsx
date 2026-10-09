import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Icon } from '../../components/Icon';

interface Item { id: string; label: string; status: 'ok' | 'missing' | 'warning' | 'optional'; detail: string; fix?: string; required: boolean }
const ICON = { ok: 'check', missing: 'x', warning: 'bolt', optional: 'plus' } as const;
const COLOR = { ok: 'var(--ok)', missing: 'var(--err)', warning: 'var(--warn)', optional: 'var(--muted)' } as const;

/** Launch checklist: what's connected, what's missing, and a button to fix each item. */
export function SetupPanel({ go }: { go: (tab: string, focus?: string) => void }) {
  const [data, setData] = useState<{ items: Item[]; ready: boolean; progress: number } | null>(null);
  useEffect(() => { api<{ items: Item[]; ready: boolean; progress: number }>('/owner/setup').then(setData).catch(() => undefined); }, []);
  if (!data) return <div className="skeleton" />;
  return (
    <div className="stack">
      <section className="card glow stack">
        <div className="row between wrap">
          <h2>{data.ready ? 'Ready to launch' : 'Launch checklist'}</h2>
          <span className="pill">{data.progress}% of required steps done</span>
        </div>
        <div className="quality" style={{ height: 8 }}><span style={{ width: `${data.progress}%` }} /></div>
        <p className="muted small">Everything below can be done from this dashboard. No code or server access needed except where noted.</p>
      </section>
      <div className="stack tight">
        {data.items.map((i) => (
          <div key={i.id} className="card flat row start" style={{ padding: 14 }}>
            <span className="model-avatar" style={{ width: 34, height: 34, background: 'var(--surface-2)', color: COLOR[i.status] }}><Icon name={ICON[i.status]} size={18} /></span>
            <div className="grow stack tight">
              <div className="row wrap" style={{ gap: 8 }}>
                <strong>{i.label}</strong>
                {i.required ? <span className="badge">Required</span> : <span className="badge">Optional</span>}
              </div>
              <span className="muted small">{i.detail}</span>
            </div>
            {i.fix && i.status !== 'ok' && (
              <button className="primary" onClick={() => { const [tab, focus] = i.fix!.split(':'); go(tab === 'keys' ? 'keys' : 'settings', focus); }}>Fix</button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
