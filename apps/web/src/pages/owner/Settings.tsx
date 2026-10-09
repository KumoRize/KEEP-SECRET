import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, ApiError } from '../../api';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Settings = Record<string, any>;
const PLAN_FIELDS: [string, string][] = [
  ['priceInr', '₹ / month'], ['monthlyCredits', 'Credits / month'], ['dailyGenerations', 'Media / day'], ['dailyMessages', 'Messages / day'],
  ['maxConcurrent', 'Parallel jobs'], ['maxVideoSeconds', 'Max video s'], ['maxMusicSeconds', 'Max music s'], ['storageGb', 'Storage GB'],
];

export function SettingsPanel({ focus }: { focus?: string }) {
  const [data, setData] = useState<{ settings: Settings; defaults: Settings } | null>(null);
  const [states, setStates] = useState<Record<string, string>>({});
  const load = () => api<{ settings: Settings; defaults: Settings }>('/owner/settings').then(setData).catch(() => undefined);
  useEffect(() => {
    void load();
    api<{ states: Record<string, string> }>('/billing/profile').then((r) => setStates(r.states)).catch(() => undefined);
  }, []);
  if (!data) return <div className="skeleton" />;
  const s = data.settings;

  return (
    <div className="stack">
      <Section id="site" title="Site switches" value={s.site} focus={focus} onSaved={load}>
        {(v, set) => (
          <>
            <Toggle label="Sign-ups open" checked={v.signupsOpen} onChange={(b) => set({ ...v, signupsOpen: b })} />
            <Toggle label="Maintenance mode (customers see a holding page; you keep access)" checked={v.maintenance} onChange={(b) => set({ ...v, maintenance: b })} />
            <label>Maintenance message<input maxLength={300} value={v.maintenanceMessage} onChange={(e) => set({ ...v, maintenanceMessage: e.target.value })} /></label>
            <label>Announcement banner (empty = hidden)<input maxLength={300} placeholder="e.g. New: Veo 3.1 video with sound!" value={v.announcement} onChange={(e) => set({ ...v, announcement: e.target.value })} /></label>
            <Toggle label="Require email verification (only enforced once email sending is connected)" checked={v.requireEmailVerification} onChange={(b) => set({ ...v, requireEmailVerification: b })} />
            <Toggle label="Prompt moderation (uses OpenAI's free moderation when an OpenAI key is set)" checked={v.moderationEnabled} onChange={(b) => set({ ...v, moderationEnabled: b })} />
          </>
        )}
      </Section>

      <Section id="pricing" title="Pricing & margins" value={s.pricing} focus={focus} onSaved={load}>
        {(v, set) => {
          const costPerCredit = v.inrPerCreditCost / v.priceMarkup;
          return (
            <>
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
                <Num label="Markup on AI cost (×)" step={0.1} value={v.priceMarkup} onChange={(n) => set({ ...v, priceMarkup: n })} />
                <Num label="₹ per credit (list)" step={0.01} value={v.inrPerCreditCost} onChange={(n) => set({ ...v, inrPerCreditCost: n })} />
                <Num label="USD → INR" step={0.1} value={v.usdInr} onChange={(n) => set({ ...v, usdInr: n })} />
                <Num label="Web search cost (USD)" step={0.001} value={v.searchCostUsd} onChange={(n) => set({ ...v, searchCostUsd: n })} />
              </div>
              <p className="small">Each credit costs you about <strong>₹{costPerCredit.toFixed(3)}</strong> in AI fees. Margin on credits that get used:</p>
              <div className="scroll-x">
                <table className="table">
                  <thead><tr><th>Plan / pack</th><th>₹ per credit</th><th>Gross margin</th></tr></thead>
                  <tbody>
                    {[...Object.entries(s.plans).filter(([id]) => id !== 'free').map(([, p]: [string, any]) => ({ name: p.name, price: p.priceInr, credits: p.monthlyCredits })),
                      ...s.packs.map((p: any) => ({ name: p.name, price: p.priceInr, credits: p.credits }))].map((r) => {
                      const per = r.price / Math.max(1, r.credits);
                      const m = (per - costPerCredit) / per;
                      return <tr key={r.name}><td>{r.name}</td><td>₹{per.toFixed(3)}</td><td className={m >= 0 ? 'pos' : 'neg'}>{Math.round(m * 100)}%</td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </>
          );
        }}
      </Section>

      <Section id="plans" title="Plans" value={s.plans} focus={focus} onSaved={load}
        note="Changing a paid plan's monthly price also needs a matching Razorpay plan: create it in Razorpay and paste its id under Razorpay plans.">
        {(v, set) => (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Plan</th>{PLAN_FIELDS.map(([, l]) => <th key={l}>{l}</th>)}</tr></thead>
              <tbody>
                {Object.entries(v).map(([id, p]: [string, any]) => (
                  <tr key={id}>
                    <td><input style={{ minWidth: 110 }} value={p.name} aria-label={`${id} name`} onChange={(e) => set({ ...v, [id]: { ...p, name: e.target.value } })} /></td>
                    {PLAN_FIELDS.map(([f, l]) => (
                      <td key={f}><input type="number" className="narrow" min={0} value={p[f]} aria-label={`${id} ${l}`} disabled={id === 'free' && f === 'priceInr'}
                        onChange={(e) => set({ ...v, [id]: { ...p, [f]: Number(e.target.value) } })} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section id="packs" title="Credit packs" value={s.packs} focus={focus} onSaved={load}>
        {(v, set) => (
          <>
            {v.map((p: any, i: number) => (
              <div key={i} className="row wrap">
                <input style={{ maxWidth: 140 }} value={p.id} aria-label="Pack id" onChange={(e) => set(v.map((x: any, j: number) => (j === i ? { ...x, id: e.target.value } : x)))} />
                <input className="grow" value={p.name} aria-label="Pack name" onChange={(e) => set(v.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <Num label="Credits" value={p.credits} onChange={(n) => set(v.map((x: any, j: number) => (j === i ? { ...x, credits: n } : x)))} />
                <Num label="₹ price" value={p.priceInr} onChange={(n) => set(v.map((x: any, j: number) => (j === i ? { ...x, priceInr: n } : x)))} />
                <button className="ghost danger" onClick={() => set(v.filter((_: any, j: number) => j !== i))}>Remove</button>
              </div>
            ))}
            {v.length < 10 && <button onClick={() => set([...v, { id: `pack_${Date.now() % 100000}`, name: 'New pack', credits: 1000, priceInr: 399 }])}>+ Add pack</button>}
          </>
        )}
      </Section>

      <Section id="referral" title="Referral rewards" value={s.referral} focus={focus} onSaved={load}>
        {(v, set) => (
          <div className="row wrap">
            <Num label="Inviter gets (credits)" value={v.referrerCredits} onChange={(n) => set({ ...v, referrerCredits: n })} />
            <Num label="Friend gets (credits)" value={v.refereeCredits} onChange={(n) => set({ ...v, refereeCredits: n })} />
          </div>
        )}
      </Section>

      <Section id="business" title="Business & GST" value={s.business} focus={focus} onSaved={load}
        note="Printed on every invoice. Confirm the SAC code and GST rate with your CA.">
        {(v, set) => (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            <label>App name<input value={v.appName} onChange={(e) => set({ ...v, appName: e.target.value })} /></label>
            <label>Email "from"<input value={v.mailFrom} placeholder="Studio <no-reply@yourdomain.com>" onChange={(e) => set({ ...v, mailFrom: e.target.value })} /></label>
            <label>Legal name<input value={v.sellerLegalName} onChange={(e) => set({ ...v, sellerLegalName: e.target.value })} /></label>
            <label>Address<input value={v.sellerAddress} onChange={(e) => set({ ...v, sellerAddress: e.target.value })} /></label>
            <label>State<select value={v.sellerStateCode} onChange={(e) => set({ ...v, sellerStateCode: e.target.value })}>{Object.entries(states).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
            <label>GSTIN (empty if not registered)<input value={v.sellerGstin} maxLength={15} onChange={(e) => set({ ...v, sellerGstin: e.target.value.toUpperCase() })} /></label>
            <label>SAC code<input value={v.gstSacCode} maxLength={6} onChange={(e) => set({ ...v, gstSacCode: e.target.value })} /></label>
            <Num label="GST rate %" value={v.gstRatePercent} onChange={(n) => set({ ...v, gstRatePercent: n })} />
            <label>Invoice prefix<input value={v.invoicePrefix} maxLength={4} onChange={(e) => set({ ...v, invoicePrefix: e.target.value.toUpperCase() })} /></label>
            <Toggle label="Prices include GST" checked={v.pricesIncludeGst} onChange={(b) => set({ ...v, pricesIncludeGst: b })} />
          </div>
        )}
      </Section>

      <Section id="automation" title="Automation" value={s.automation} focus={focus} onSaved={load}>
        {(v, set) => (
          <>
            <Toggle label="Send me a daily report (email + Slack/Discord if connected)" checked={v.dailyReport} onChange={(b) => set({ ...v, dailyReport: b })} />
            <label style={{ maxWidth: 220 }}>Report time (IST)
              <select value={v.reportHourIst} onChange={(e) => set({ ...v, reportHourIst: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
              </select>
            </label>
            <Toggle label="Automatically disable models that lose money (otherwise I just get an alert)" checked={v.autoDisableLossMakers} onChange={(b) => set({ ...v, autoDisableLossMakers: b })} />
          </>
        )}
      </Section>

      <Section id="razorpayPlans" title="Razorpay subscription plans" value={s.razorpayPlans} focus={focus} onSaved={load}
        note="In Razorpay: Subscriptions > Plans > Create plan (monthly, same price as here). Paste each plan id.">
        {(v, set) => (
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
            {Object.keys(s.plans).filter((p) => p !== 'free').map((p) => (
              <label key={p}>{s.plans[p].name} (₹{s.plans[p].priceInr})<input placeholder="plan_XXXXXXXX" value={v[p] ?? ''} onChange={(e) => set({ ...v, [p]: e.target.value.trim() })} /></label>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ id, title, value, note, focus, onSaved, children }: {
  id: string; title: string; value: any; note?: string; focus?: string; onSaved: () => void; children: (v: any, set: (v: any) => void) => ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => { if (focus === id) ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, [focus, id]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  const save = async () => {
    try {
      await api(`/owner/settings/${id}`, { method: 'PUT', json: draft });
      setMsg({ ok: true, text: 'Saved. Live for everyone now.' });
      onSaved();
    } catch (e) {
      const err = e as ApiError;
      setMsg({ ok: false, text: (err.details as { path: string; message: string }[] | undefined)?.map((d) => `${d.path}: ${d.message}`).join(' · ') || err.message });
    }
  };
  const reset = async () => {
    if (!window.confirm(`Reset "${title}" to defaults?`)) return;
    await api(`/owner/settings/${id}`, { method: 'DELETE' });
    setMsg({ ok: true, text: 'Reset to defaults.' });
    onSaved();
  };
  return (
    <section ref={ref} className={`card stack${focus === id ? ' glow' : ''}`}>
      <div className="row between wrap"><h2>{title}</h2>{dirty && <span className="badge hot">Unsaved</span>}</div>
      {note && <p className="muted small">{note}</p>}
      {children(draft, setDraft)}
      <div className="row wrap">
        <button className="primary" disabled={!dirty} onClick={save}>Save</button>
        {dirty && <button className="ghost" onClick={() => setDraft(value)}>Discard</button>}
        <span className="grow" />
        <button className="ghost small" onClick={reset}>Reset to default</button>
      </div>
      {msg && <p className={`small ${msg.ok ? 'ok' : 'error'}`} role="status">{msg.text}</p>}
    </section>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (b: boolean) => void }) {
  return (
    <label className="row" style={{ flexDirection: 'row', fontWeight: 500, alignItems: 'center' }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

function Num({ label, value, onChange, step = 1 }: { label: string; value: number; onChange: (n: number) => void; step?: number }) {
  return <label style={{ maxWidth: 200 }}>{label}<input type="number" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}
