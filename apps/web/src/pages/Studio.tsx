import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, MODALITY_LABELS, TEXT_MODES, type Generation, type Quote } from '../api';
import { useAuth } from '../auth';
import { AssetPreview } from '../components/AssetPreview';
import { CATEGORY_META, Icon } from '../components/Icon';
import { ModelCard } from '../components/ModelCard';
import { ModelPicker } from '../components/ModelPicker';
import { useModels, type CatalogModel } from '../lib/catalog';

const TERMINAL = ['succeeded', 'failed', 'canceled'];
const MODES = ['auto', 'image', 'video', 'music', '3d', 'website', 'app', 'game', 'chat', 'story', 'code', 'research'];
const IDEAS: Record<string, string[]> = {
  auto: ['A cinematic 8 second video of monsoon rain over Mumbai', 'Logo for a chai cafe called Kettle & Co', 'Landing page for a yoga studio in Goa'],
  image: ['Neon cyberpunk street food stall, rainy night, 35mm', 'Minimal logo of a paper plane, flat vector', 'Watercolor portrait of a Bengal tiger'],
  video: ['Drone shot over Himalayan peaks at sunrise, 8s', 'Slow-motion splash of colors during Holi', 'Product spin of a matte black sneaker'],
  music: ['Lo-fi beat for studying, 60 seconds', 'Upbeat Bollywood-style jingle for an ad', 'Ambient soundtrack for meditation'],
  '3d': ['Low-poly treasure chest game asset', 'Stylized rocket ship toy', 'Cartoon mushroom house'],
  website: ['Portfolio site for a wedding photographer', 'Landing page for an AI note-taking app', 'Restaurant website with menu and booking'],
  app: ['Expense splitter for roommates', 'Pomodoro timer with stats', 'Habit tracker with streaks'],
  game: ['Snake game with neon visuals', 'Flappy-style game with a paper plane', 'Memory card matching game'],
  chat: ['Explain quantum computing like I am 12', 'Plan a 5-day Kerala itinerary', 'Write a polite follow-up email'],
  story: ['A sci-fi short story set in 2150 Bengaluru', 'Screenplay scene: two rivals meet at a chai stall', 'Bedtime story about a brave little elephant'],
  code: ['Python script to rename photos by date', 'React hook for debounced search', 'SQL to find top customers by revenue'],
  research: ['Latest breakthroughs in solid-state batteries', 'Compare UPI and card payment fees in India', 'State of AI regulation in the EU'],
};

export function StudioPage() {
  const { me, reload } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { items } = useModels();
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState(params.get('mode') ?? 'auto');
  const [modelId, setModelId] = useState(params.get('model') ?? '');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [gen, setGen] = useState<Generation | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | undefined>(undefined);
  const plan = me!.user.plan;

  useEffect(() => () => window.clearTimeout(poll.current), []);
  useEffect(() => setQuote(null), [prompt, mode, modelId]);

  const isText = TEXT_MODES.includes(mode);
  const locked = (m: string) => m !== 'auto' && !isText && !TEXT_MODES.includes(m) && !plan.modalities.includes(m);

  const track = (id: string) => {
    poll.current = window.setTimeout(async () => {
      try {
        const g = await api<Generation>(`/generations/${id}`);
        setGen(g);
        if (TERMINAL.includes(g.status)) void reload(); else track(id);
      } catch { track(id); }
    }, 2000);
  };

  const go = async () => {
    setError(null);
    setBusy(true);
    try {
      if (isText) {
        const conv = await api<{ id: string }>('/chat/conversations', { method: 'POST', json: { mode, ...(modelId ? { modelId } : {}) } });
        nav(`/chat/${conv.id}`, { state: { send: prompt } });
        return;
      }
      if (!quote) {
        setQuote(await api<Quote>('/generations/estimate', {
          method: 'POST', json: { prompt, ...(mode !== 'auto' ? { modality: mode } : {}), ...(modelId ? { preferredModelId: modelId } : {}) },
        }));
        return;
      }
      const g = await api<Generation>('/generations', { method: 'POST', json: { prompt, quoteToken: quote.quoteToken }, idempotencyKey: crypto.randomUUID() });
      setGen(g);
      setQuote(null);
      void reload();
      track(g.id);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const useModel = (m: CatalogModel) => {
    setMode(m.categories[0] ?? 'auto');
    setModelId(m.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const featured = useMemo(() => items.filter((m) => m.featured && !m.isFree).slice(0, 12), [items]);
  const free = useMemo(() => items.filter((m) => m.isFree).slice(0, 12), [items]);
  const media = useMemo(() => items.filter((m) => m.categories.some((c) => c === 'video' || c === 'image')).slice(0, 12), [items]);
  const insufficient = quote ? quote.maxCredits > me!.balance.total : false;
  const cta = isText ? `Start ${MODALITY_LABELS[mode]}` : quote ? (insufficient ? 'Not enough credits' : `Generate · ~${quote.estimatedCredits} credits`) : 'Estimate cost';

  return (
    <div className="stack">
      <section className="hero">
        <span className="pill"><Icon name="sparkles" size={14} /> {items.length || 'All'} AI models · one prompt</span>
        <h1 style={{ marginTop: 14 }}>Create <span className="gradient-text">anything</span> with AI</h1>
        <p>Images, videos, music, 3D, websites, apps, games, stories, code and research, in one place.</p>

        <div className="composer">
          <textarea value={prompt} maxLength={4000} onChange={(e) => setPrompt(e.target.value)} aria-label="Prompt"
            placeholder={IDEAS[mode]?.[0] ? `Try: ${IDEAS[mode]![0]}` : 'Describe what you want to create…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && prompt.trim().length >= 3) void go(); }} />
          <div className="chips scroll" role="radiogroup" aria-label="What to create" style={{ padding: '0 6px' }}>
            {MODES.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? 'chip active' : 'chip'}
                disabled={locked(m)} title={locked(m) ? `Upgrade to unlock ${MODALITY_LABELS[m]}` : undefined}
                onClick={() => { setMode(m); setModelId(''); }}>
                {m === 'auto' ? <><Icon name="sparkles" size={15} /> Auto</> : <><Icon name={CATEGORY_META[m]!.icon} size={15} /> {CATEGORY_META[m]!.label}</>}
                {locked(m) ? ' 🔒' : ''}
              </button>
            ))}
          </div>
          <div className="composer-bar">
            {mode !== 'auto' && <ModelPicker category={mode} value={modelId} onChange={setModelId} />}
            <span className="grow" />
            <span className="muted tiny hide-mobile">Ctrl/⌘ + Enter</span>
            <button className="primary lg" onClick={go} disabled={busy || prompt.trim().length < 3 || insufficient}>
              <Icon name={isText ? 'send' : 'bolt'} size={18} /> {busy ? 'Working…' : cta}
            </button>
          </div>
        </div>
        <div className="suggestions">
          {(IDEAS[mode] ?? IDEAS.auto!).map((s) => <button key={s} onClick={() => setPrompt(s)}>{s}</button>)}
        </div>
        {error && (
          <p className="error" role="alert" style={{ marginTop: 12 }}>
            {error.message}{' '}
            {['plan_upgrade_required', 'insufficient_credits', 'storage_full'].includes(error.code) && <Link to="/billing">Upgrade or buy credits →</Link>}
          </p>
        )}
      </section>

      {quote && (
        <section className="card glow stack" aria-live="polite" style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}>
          <div className="row between">
            <h2><Icon name={CATEGORY_META[quote.modality]?.icon ?? 'sparkles'} /> {MODALITY_LABELS[quote.modality]}</h2>
            <span className="pill">~{quote.estimatedCredits} credits</span>
          </div>
          <dl className="facts">
            <dt>Model</dt><dd>{quote.provider.label}</dd>
            {quote.params.durationSec && (<><dt>Duration</dt><dd>{quote.params.durationSec}s</dd></>)}
            <dt>Reserved</dt><dd>{quote.maxCredits} credits (unused credits are refunded)</dd>
            {quote.fallbacks.length > 0 && (<><dt>Backup</dt><dd>{quote.fallbacks.map((f) => f.label).join(', ')}</dd></>)}
            <dt>Licence</dt><dd className="small">{quote.licenseNote}</dd>
          </dl>
          <p className="muted small">Looks right? Press <strong>Generate</strong> above.</p>
        </section>
      )}

      {gen && (
        <section className="card stack" aria-live="polite" style={{ maxWidth: 860, margin: '0 auto', width: '100%' }}>
          <div className="row between">
            <h2>{MODALITY_LABELS[gen.modality]}</h2>
            <span className={`status ${gen.status}`}>{gen.status}</span>
          </div>
          {!TERMINAL.includes(gen.status) && <><div className="progress" aria-label="Generating" /><p className="muted small">Long videos can take a few minutes; you can leave this page and find it in your Library.</p></>}
          {gen.error && <p className="error">{gen.error}</p>}
          {gen.assets.map((a) => <AssetPreview key={a.id} asset={a} />)}
          {gen.status === 'succeeded' && <p className="muted small">Charged {gen.chargedCredits} credits via {gen.model}. {gen.licenseNote}</p>}
        </section>
      )}

      <div className="section-head"><h2>What will you make today?</h2></div>
      <div className="feature-tiles">
        {Object.entries(CATEGORY_META).map(([k, v]) => (
          <button key={k} className="tile" style={{ ['--tile' as string]: v.color }} onClick={() => { setMode(k); setModelId(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
            <Icon name={v.icon} size={26} />
            <span>{v.label}<br /><small>{v.blurb}</small></span>
          </button>
        ))}
        <Link className="tile" to="/agents" style={{ ['--tile' as string]: '#22d3ee' }}>
          <Icon name="bot" size={26} /><span>Agents<br /><small>Build your own AI assistants</small></span>
        </Link>
      </div>

      {[{ title: 'Top models', list: featured }, { title: 'Image & video models', list: media }, { title: 'Free models', list: free }].map((r) => r.list.length > 0 && (
        <section key={r.title}>
          <div className="section-head"><h2>{r.title}</h2><Link to="/explore">See all →</Link></div>
          <div className="rail">{r.list.map((m) => <ModelCard key={m.id} m={m} onUse={useModel} />)}</div>
        </section>
      ))}
    </div>
  );
}
