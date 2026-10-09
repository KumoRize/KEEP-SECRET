import type { CatalogModel } from '../lib/catalog';
import { initials, providerGradient } from '../lib/catalog';
import { CATEGORY_META } from './Icon';

export function ModelCard({ m, onUse }: { m: CatalogModel; onUse?: (m: CatalogModel) => void }) {
  return (
    <article className="card model-card">
      <div className="row start">
        <div className="model-avatar" style={{ background: providerGradient(m.provider) }}>{initials(m.label)}</div>
        <div className="grow">
          <h3 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.label}>{m.label}</h3>
          <div className="muted tiny">{m.provider}{m.contextLength ? ` · ${Math.round(m.contextLength / 1000)}K context` : ''}{m.maxDurationSec ? ` · up to ${m.maxDurationSec}s` : ''}</div>
        </div>
        {m.isFree ? <span className="badge free">Free</span> : m.featured ? <span className="badge pro">Top</span> : null}
      </div>
      <p className="model-desc">{m.description || m.categories.map((c) => CATEGORY_META[c]?.blurb).filter(Boolean).join(' · ')}</p>
      <div className="chips">{m.categories.slice(0, 4).map((c) => <span key={c} className="badge">{CATEGORY_META[c]?.label ?? c}</span>)}</div>
      <div className="quality" title={`Quality ${m.quality}/10`}><span style={{ width: `${m.quality * 10}%` }} /></div>
      <div className="row between">
        <span className="small"><strong>{m.priceHint}</strong></span>
        {onUse && <button className="primary" onClick={() => onUse(m)}>Use</button>}
      </div>
      {m.dataNote && <p className="tiny muted">{m.dataNote}</p>}
    </article>
  );
}
