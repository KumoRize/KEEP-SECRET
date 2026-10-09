import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { CATEGORY_META, Icon } from '../components/Icon';
import { ModelCard } from '../components/ModelCard';
import { useModels, type CatalogModel } from '../lib/catalog';

const PAGE = 48;

/** "World of AI": every runnable model, searchable and filterable. Public, so it doubles as a marketing page. */
export function ExplorePage() {
  const { me } = useAuth();
  const nav = useNavigate();
  const { items, counts, loading } = useModels();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('');
  const [price, setPrice] = useState<'all' | 'free' | 'paid'>('all');
  const [limit, setLimit] = useState(PAGE);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((m) => (!cat || m.categories.includes(cat))
      && (price === 'all' || (price === 'free') === m.isFree)
      && (!needle || `${m.label} ${m.id} ${m.description} ${m.tags.join(' ')}`.toLowerCase().includes(needle)));
  }, [items, q, cat, price]);

  const use = (m: CatalogModel) => {
    if (!me) return nav('/register');
    nav(`/?mode=${m.categories.includes(cat) ? cat : m.categories[0]}&model=${encodeURIComponent(m.id)}`);
  };

  return (
    <div className="stack">
      <div className="hero" style={{ textAlign: 'left' }}>
        <span className="pill"><Icon name="globe" size={14} /> World of AI</span>
        <h1 style={{ marginTop: 12 }}>Explore <span className="gradient-text">{items.length.toLocaleString('en-IN')}</span> AI models</h1>
        <p>Premium and free models for images, video, music, 3D, websites, apps, games, writing, coding and research.</p>
      </div>

      <div className="card flat stack">
        <div className="row wrap">
          <div className="grow" style={{ minWidth: 220, position: 'relative' }}>
            <input value={q} onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }} placeholder="Search models, e.g. claude, flux, veo, llama…" aria-label="Search models" />
          </div>
          <div className="chips" role="radiogroup" aria-label="Price">
            {(['all', 'free', 'paid'] as const).map((p) => (
              <button key={p} role="radio" aria-checked={price === p} className={price === p ? 'chip active' : 'chip'} onClick={() => setPrice(p)}>
                {p === 'all' ? 'All' : p === 'free' ? 'Free' : 'Premium'}
              </button>
            ))}
          </div>
        </div>
        <div className="chips scroll" role="radiogroup" aria-label="Category">
          <button role="radio" aria-checked={!cat} className={!cat ? 'chip active' : 'chip'} onClick={() => setCat('')}>Everything <span className="count">{items.length}</span></button>
          {Object.entries(CATEGORY_META).map(([k, v]) => (
            <button key={k} role="radio" aria-checked={cat === k} className={cat === k ? 'chip active' : 'chip'} onClick={() => { setCat(k); setLimit(PAGE); }}>
              <Icon name={v.icon} size={15} /> {v.label} <span className="count">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="grid">{Array.from({ length: 6 }, (_, i) => <div key={i} className="skeleton" />)}</div>
      ) : list.length === 0 ? (
        <p className="center muted">No models match. Try another search or category.</p>
      ) : (
        <>
          <p className="muted small">{list.length.toLocaleString('en-IN')} models</p>
          <div className="grid four">{list.slice(0, limit).map((m) => <ModelCard key={m.id} m={m} onUse={use} />)}</div>
          {list.length > limit && <button onClick={() => setLimit(limit + PAGE)} style={{ alignSelf: 'center' }}>Show more</button>}
        </>
      )}
    </div>
  );
}
