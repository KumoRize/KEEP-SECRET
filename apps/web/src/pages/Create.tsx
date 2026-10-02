import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, MODALITY_LABELS, type Generation, type Quote } from '../api';
import { useAuth } from '../auth';
import { AssetPreview } from '../components/AssetPreview';

const TERMINAL = ['succeeded', 'failed', 'canceled'];

export function CreatePage() {
  const { me, reload } = useAuth();
  const [prompt, setPrompt] = useState('');
  const [modality, setModality] = useState<string>('auto');
  const [strategy, setStrategy] = useState<'best' | 'cheapest'>('best');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [gen, setGen] = useState<Generation | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(poll.current), []);
  // Any edit invalidates the quote, since price and routing depend on the prompt.
  useEffect(() => setQuote(null), [prompt, modality, strategy]);

  const estimate = async () => {
    setBusy(true);
    setError(null);
    try {
      setQuote(await api<Quote>('/generations/estimate', {
        method: 'POST', json: { prompt, strategy, ...(modality !== 'auto' ? { modality } : {}) },
      }));
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const track = (id: string) => {
    poll.current = window.setTimeout(async () => {
      try {
        const g = await api<Generation>(`/generations/${id}`);
        setGen(g);
        if (TERMINAL.includes(g.status)) void reload();
        else track(id);
      } catch {
        track(id);
      }
    }, 2000);
  };

  const generate = async () => {
    if (!quote) return;
    setBusy(true);
    setError(null);
    try {
      const g = await api<Generation>('/generations', {
        method: 'POST', json: { prompt, quoteToken: quote.quoteToken }, idempotencyKey: crypto.randomUUID(),
      });
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

  const plan = me!.user.plan;
  const insufficient = quote ? quote.maxCredits > me!.balance.total : false;

  return (
    <div className="stack">
      <section className="card stack">
        <h1>What do you want to create?</h1>
        <textarea rows={4} maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. A 10 second cinematic video of monsoon rain over Mumbai" aria-label="Prompt" />
        <div className="chips" role="radiogroup" aria-label="Output type">
          {['auto', ...Object.keys(MODALITY_LABELS)].map((m) => {
            const locked = m !== 'auto' && !plan.modalities.includes(m);
            return (
              <button key={m} type="button" role="radio" aria-checked={modality === m}
                className={modality === m ? 'chip active' : 'chip'} disabled={locked}
                title={locked ? `Upgrade to unlock ${MODALITY_LABELS[m]}` : undefined} onClick={() => setModality(m)}>
                {m === 'auto' ? 'Auto' : MODALITY_LABELS[m]}{locked ? ' 🔒' : ''}
              </button>
            );
          })}
        </div>
        <div className="row">
          <select value={strategy} onChange={(e) => setStrategy(e.target.value as 'best' | 'cheapest')} aria-label="Routing">
            <option value="best">Best quality</option>
            <option value="cheapest">Lowest cost</option>
          </select>
          <button className="primary grow" onClick={estimate} disabled={busy || prompt.trim().length < 3}>Estimate cost</button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error.message}{' '}
            {['plan_upgrade_required', 'insufficient_credits', 'storage_full'].includes(error.code) && <Link to="/billing">Upgrade or buy credits</Link>}
            {error.code === 'email_not_verified' && 'Check your inbox, or use "Resend email" at the top of the page.'}
          </p>
        )}
      </section>

      {quote && (
        <section className="card stack" aria-live="polite">
          <div className="row between">
            <h2>{MODALITY_LABELS[quote.modality]}</h2>
            <span className="pill">{quote.estimatedCredits} credits</span>
          </div>
          <dl className="facts">
            <dt>Model</dt><dd>{quote.provider.label}</dd>
            {quote.params.durationSec && (<><dt>Duration</dt><dd>{quote.params.durationSec}s</dd></>)}
            <dt>Reserved</dt><dd>{quote.maxCredits} credits (unused credits are refunded)</dd>
            {quote.fallbacks.length > 0 && (<><dt>Fallbacks</dt><dd>{quote.fallbacks.map((f) => f.label).join(', ')}</dd></>)}
            <dt>Licence</dt><dd>{quote.licenseNote}</dd>
          </dl>
          {modality === 'auto' && quote.detected.confidence < 0.5 && (
            <p className="muted">Not sure this is right? Pick an output type above.</p>
          )}
          <button className="primary" onClick={generate} disabled={busy || insufficient}>
            {insufficient ? 'Not enough credits' : `Generate for ~${quote.estimatedCredits} credits`}
          </button>
        </section>
      )}

      {gen && (
        <section className="card stack" aria-live="polite">
          <div className="row between">
            <h2>{MODALITY_LABELS[gen.modality]}</h2>
            <span className={`status ${gen.status}`}>{gen.status}</span>
          </div>
          {!TERMINAL.includes(gen.status) && <div className="progress" aria-label="Generating" />}
          {gen.error && <p className="error">{gen.error}</p>}
          {gen.assets.map((a) => <AssetPreview key={a.id} asset={a} />)}
          {gen.status === 'succeeded' && (
            <p className="muted">Charged {gen.chargedCredits} credits via {gen.model}. {gen.licenseNote}</p>
          )}
        </section>
      )}
    </div>
  );
}
