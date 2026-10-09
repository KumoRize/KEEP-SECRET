import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { KeysPanel } from './owner/Keys';
import { SettingsPanel } from './owner/Settings';
import { SetupPanel } from './owner/Setup';
import { api, authHeaders, isOwner } from '../api';
import { CATEGORY_META, Icon } from '../components/Icon';

interface Stats {
  days: number;
  users: { total: number; paying: number; new: number };
  revenueInr: number;
  payments: number;
  providerCostInr: number;
  grossProfitInr: number;
  marginPct: number | null;
  mrrInr: number;
  arpuInr: number;
  outstandingCredits: number;
  outstandingCostInr: number;
  referrals: { rewards: number; credits: number };
  activeSubscriptions: { plan_id: string; n: number }[];
  providerCosts: { provider_id: string; modality: string; generations: number; credits: number; cost_usd: number; cost_inr: number; credit_value_inr: number }[];
}
interface Provider {
  id: string; name: string; configured: boolean; enabled: boolean; priority: number;
  circuit: { failures: number; open: boolean }; models: { id: string; modality: string; label: string; commercialUse: boolean }[];
}
interface User { id: string; email: string; role: 'user' | 'admin' | 'owner'; plan_id: string; status: string; credits: number }
interface CatalogRow {
  id: string; provider_id: string; model: string; categories: string[]; label: string; is_free: boolean; enabled: boolean;
  featured: boolean; quality: number; pricing: Record<string, number>; source: string;
}

const inr = (n: number) => `${n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
// Staff admins only see support tools; everything about money, keys and settings is the owner's.
const TABS = [
  { id: 'setup', label: 'Setup', icon: 'check', owner: true },
  { id: 'profit', label: 'Profit', icon: 'chart', owner: true },
  { id: 'settings', label: 'Settings', icon: 'sparkles', owner: true },
  { id: 'keys', label: 'API keys', icon: 'key', owner: true },
  { id: 'models', label: 'Models', icon: 'globe', owner: false },
  { id: 'providers', label: 'Providers', icon: 'bolt', owner: true },
  { id: 'users', label: 'Users', icon: 'shield', owner: false },
  { id: 'invoices', label: 'GST export', icon: 'wallet', owner: true },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function AdminPage() {
  const { me } = useAuth();
  const owner = isOwner(me);
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => owner || !t.owner);
  const requested = params.get('tab') as TabId | null;
  const tab: TabId = tabs.some((t) => t.id === requested) ? requested! : tabs[0]!.id;
  const focus = params.get('focus') ?? undefined;
  const setTab = (id: string, f?: string) => setParams(f ? { tab: id, focus: f } : { tab: id });
  return (
    <div className="stack">
      <div className="row wrap between">
        <h1>{owner ? 'Owner' : 'Staff'} <span className="gradient-text">dashboard</span></h1>
        <div className="chips scroll" role="tablist">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'chip active' : 'chip'} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={15} /> {t.label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'setup' && <SetupPanel go={setTab} />}
      {tab === 'profit' && <Profit />}
      {tab === 'settings' && <SettingsPanel focus={focus} />}
      {tab === 'keys' && <KeysPanel focus={focus} />}
      {tab === 'models' && <Models owner={owner} />}
      {tab === 'providers' && <Providers />}
      {tab === 'users' && <Users owner={owner} />}
      {tab === 'invoices' && <InvoiceExport />}
    </div>
  );
}

function Profit() {
  const [days, setDays] = useState(30);
  const [s, setS] = useState<Stats | null>(null);
  useEffect(() => { api<Stats>(`/admin/stats?days=${days}`).then(setS).catch(() => undefined); }, [days]);
  if (!s) return <div className="skeleton" />;
  return (
    <div className="stack">
      <div className="chips">
        {[7, 30, 90, 365].map((d) => <button key={d} className={days === d ? 'chip active' : 'chip'} onClick={() => setDays(d)}>{d === 365 ? '1 year' : `${d} days`}</button>)}
      </div>
      <div className="kpis">
        <div className="card kpi glow"><span className="muted small">Revenue</span><strong>{inr(s.revenueInr)}</strong><span className="muted tiny">{s.payments} payments</span></div>
        <div className="card kpi"><span className="muted small">Provider cost</span><strong>{inr(s.providerCostInr)}</strong><span className="muted tiny">AI API spend</span></div>
        <div className="card kpi glow"><span className="muted small">Gross profit</span><strong className={s.grossProfitInr >= 0 ? 'pos' : 'neg'}>{inr(s.grossProfitInr)}</strong><span className="muted tiny">{s.marginPct === null ? 'no revenue yet' : `${s.marginPct}% margin`}</span></div>
        <div className="card kpi"><span className="muted small">MRR</span><strong>{inr(s.mrrInr)}</strong><span className="muted tiny">{s.activeSubscriptions.reduce((a, b) => a + b.n, 0)} active subscriptions</span></div>
        <div className="card kpi"><span className="muted small">Users</span><strong>{s.users.total.toLocaleString('en-IN')}</strong><span className="muted tiny">+{s.users.new} new · {s.users.paying} paying</span></div>
        <div className="card kpi"><span className="muted small">ARPU (paying)</span><strong>{inr(s.arpuInr)}</strong></div>
        <div className="card kpi"><span className="muted small">Unspent credits</span><strong>{s.outstandingCredits.toLocaleString('en-IN')}</strong><span className="muted tiny">≈ {inr(s.outstandingCostInr)} cost if all used</span></div>
        <div className="card kpi"><span className="muted small">Referral rewards</span><strong>{s.referrals.rewards}</strong><span className="muted tiny">{s.referrals.credits} credits given</span></div>
      </div>
      <section className="card stack">
        <h2>Cost and earnings by model family</h2>
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Provider</th><th>Type</th><th>Jobs</th><th>Credits</th><th>Credit value</th><th>Cost</th><th>Margin</th></tr></thead>
            <tbody>
              {s.providerCosts.map((r) => {
                const margin = r.credit_value_inr - r.cost_inr;
                return (
                  <tr key={`${r.provider_id}-${r.modality}`}>
                    <td>{r.provider_id}</td><td>{r.modality}</td><td>{r.generations}</td><td>{r.credits}</td>
                    <td>{inr(r.credit_value_inr)}</td><td>{inr(r.cost_inr)}</td>
                    <td className={margin >= 0 ? 'pos' : 'neg'}>{inr(margin)}</td>
                  </tr>
                );
              })}
              {s.providerCosts.length === 0 && <tr><td colSpan={7} className="muted">No paid generations in this period.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted tiny">Credit value uses list price per credit; plan discounts lower realised revenue, which the Revenue tile reflects exactly.</p>
      </section>
    </div>
  );
}

function Models({ owner }: { owner: boolean }) {
  const [rows, setRows] = useState<CatalogRow[]>([]);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => api<{ items: CatalogRow[] }>('/admin/catalog').then((r) => setRows(r.items)).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);

  const patch = async (r: CatalogRow, body: Partial<{ enabled: boolean; featured: boolean }>) => {
    await api(`/admin/catalog/${encodeURIComponent(r.id)}`, { method: 'PATCH', json: body });
    void load();
  };
  const sync = async () => {
    setMsg('Syncing OpenRouter…');
    try {
      const r = await api<{ upserted: number; skipped: number }>('/admin/catalog/sync/openrouter', { method: 'POST' });
      setMsg(`Synced ${r.upserted} models (${r.skipped} non-text skipped).`);
      void load();
    } catch (e) { setMsg((e as Error).message); }
  };
  const add = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const unit = String(f.get('unit'));
    const price = Number(f.get('price'));
    try {
      await api('/admin/catalog', {
        method: 'POST',
        json: {
          providerId: f.get('provider'), model: f.get('model'), label: f.get('label'), categories: [f.get('category')],
          pricing: { [unit]: price }, isFree: price === 0, description: f.get('description') || '',
        },
      });
      setAdding(false); setMsg('Model added.'); void load();
    } catch (err) { setMsg((err as Error).message); }
  };

  const shown = rows.filter((r) => !q || `${r.label} ${r.id}`.toLowerCase().includes(q.toLowerCase()));
  const priceText = (p: Record<string, number>) => Object.entries(p).map(([k, v]) => `${k}: $${v}`).join(', ');
  return (
    <div className="stack">
      <div className="row wrap">
        <input className="grow" placeholder="Search catalog" value={q} onChange={(e) => setQ(e.target.value)} />
        {owner && <button onClick={sync}><Icon name="refresh" size={16} /> Sync OpenRouter</button>}
        {owner && <button className="primary" onClick={() => setAdding(!adding)}><Icon name="plus" size={16} /> Add model</button>}
      </div>
      {msg && <p className="small" role="status">{msg}</p>}
      {adding && (
        <form className="card stack" onSubmit={add}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
            <label>Provider<select name="provider" defaultValue="fal"><option value="fal">fal.ai</option><option value="openrouter">OpenRouter</option></select></label>
            <label>Provider model id<input name="model" required placeholder="fal-ai/kling-video/v3/pro/text-to-video" /></label>
            <label>Display name<input name="label" required /></label>
            <label>Category<select name="category">{Object.entries(CATEGORY_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
            <label>Price unit<select name="unit"><option value="perImage">USD per image</option><option value="perSecond">USD per second</option><option value="perRun">USD per run</option><option value="outputPerMTok">USD per 1M output tokens</option></select></label>
            <label>Provider price (USD)<input name="price" type="number" step="0.0001" min="0" required /></label>
          </div>
          <label>Description<input name="description" maxLength={400} /></label>
          <p className="muted tiny">Check the model id and price on the provider's model page. Video duration rules and extra inputs can be set via the API (inputOptions).</p>
          <div className="row"><button className="primary">Add</button><button type="button" className="ghost" onClick={() => setAdding(false)}>Cancel</button></div>
        </form>
      )}
      <div className="card scroll-x">
        <table className="table">
          <thead><tr><th>Model</th><th>Categories</th><th>Price (provider)</th><th>Source</th><th>Featured</th><th>Enabled</th></tr></thead>
          <tbody>
            {shown.slice(0, 300).map((r) => (
              <tr key={r.id}>
                <td><strong>{r.label}</strong><br /><span className="muted tiny">{r.id}</span> {r.is_free && <span className="badge free">Free</span>}</td>
                <td className="small">{r.categories.join(', ')}</td>
                <td className="small">{priceText(r.pricing)}</td>
                <td className="muted small">{r.source}</td>
                <td><input type="checkbox" style={{ width: 'auto' }} disabled={!owner} checked={r.featured} onChange={(e) => patch(r, { featured: e.target.checked })} aria-label={`Feature ${r.label}`} /></td>
                <td><input type="checkbox" style={{ width: 'auto' }} disabled={!owner} checked={r.enabled} onChange={(e) => patch(r, { enabled: e.target.checked })} aria-label={`Enable ${r.label}`} /></td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="muted">No catalog models. Set OPENROUTER_API_KEY / FAL_KEY, then sync.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Providers() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const load = useCallback(() => api<{ items: Provider[] }>('/admin/providers').then((r) => setProviders(r.items)).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);
  const update = async (p: Provider, patch: Partial<Pick<Provider, 'enabled' | 'priority'>>) => {
    await api(`/admin/providers/${p.id}`, { method: 'PUT', json: { enabled: p.enabled, priority: p.priority, ...patch } });
    void load();
  };
  return (
    <div className="card scroll-x">
      <table className="table">
        <thead><tr><th>Provider</th><th>Status</th><th>Priority</th><th>Models</th><th /></tr></thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{!p.configured ? <span className="muted">No key</span> : p.circuit.open ? <span className="neg">Paused (failing)</span> : p.enabled ? <span className="pos">Live</span> : 'Disabled'}</td>
              <td><input type="number" className="narrow" defaultValue={p.priority} aria-label={`${p.name} priority`}
                onBlur={(e) => Number(e.target.value) !== p.priority && update(p, { priority: Number(e.target.value) })} /></td>
              <td className="small">{p.models.length} models</td>
              <td><button onClick={() => update(p, { enabled: !p.enabled })}>{p.enabled ? 'Disable' : 'Enable'}</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted tiny">Lower priority numbers are tried first. Paused providers recover automatically after 60 seconds.</p>
    </div>
  );
}

function Users({ owner }: { owner: boolean }) {
  const [users, setUsers] = useState<User[]>([]);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api<{ items: User[] }>(`/admin/users?${new URLSearchParams(q ? { q } : {})}`).then((r) => setUsers(r.items)).catch(() => undefined), [q]);
  useEffect(() => { void load(); }, [load]);
  const adjust = async (u: User) => {
    const amount = Number(window.prompt(`Credit adjustment for ${u.email} (negative to debit)`));
    if (!Number.isInteger(amount) || amount === 0) return;
    const reason = window.prompt('Reason (audited)') ?? '';
    try { await api(`/admin/users/${u.id}/credits`, { method: 'POST', json: { amount, reason } }); void load(); } catch (e) { setMsg((e as Error).message); }
  };
  const setRole = async (u: User, role: 'user' | 'admin') => {
    try { await api(`/admin/users/${u.id}`, { method: 'PATCH', json: { role } }); void load(); } catch (e) { setMsg((e as Error).message); }
  };
  const toggle = async (u: User) => {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', json: { status: u.status === 'active' ? 'suspended' : 'active' } });
    void load();
  };
  return (
    <div className="stack">
      <input placeholder="Search email" value={q} onChange={(e) => setQ(e.target.value)} />
      {msg && <p className="error">{msg}</p>}
      <div className="card scroll-x">
        <table className="table">
          <thead><tr><th>Email</th><th>Role</th><th>Plan</th><th>Credits</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}{u.status !== 'active' && <span className="status failed"> suspended</span>}</td>
                <td>{u.role === 'owner' ? <span className="badge pro">Owner</span> : u.role === 'admin' ? <span className="badge">Staff</span> : 'Customer'}</td>
                <td>{u.plan_id}</td><td>{u.credits}</td>
                <td className="row">
                  {u.role !== 'owner' && (owner || u.role === 'user') && <button onClick={() => adjust(u)}>Credits</button>}
                  {u.role !== 'owner' && (owner || u.role === 'user') && <button onClick={() => toggle(u)}>{u.status === 'active' ? 'Suspend' : 'Restore'}</button>}
                  {owner && u.role === 'user' && <button onClick={() => setRole(u, 'admin')}>Make staff</button>}
                  {owner && u.role === 'admin' && <button className="ghost" onClick={() => setRole(u, 'user')}>Remove staff</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoiceExport() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(today.slice(0, 8) + '01');
  const [to, setTo] = useState(today);
  const [err, setErr] = useState('');
  // Fetched with the bearer token, then saved via a blob URL (a plain link cannot send auth headers).
  const download = async () => {
    setErr('');
    try {
      const res = await fetch(`/api/v1/admin/invoices.csv?from=${from}&to=${to}`, { headers: authHeaders() });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement('a'), { href: url, download: `invoices-${from}-to-${to}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="card stack">
      <h2>GST invoices export</h2>
      <div className="row wrap">
        <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="primary" style={{ alignSelf: 'flex-end' }} onClick={download}>Download CSV</button>
      </div>
      {err && <p className="error">{err}</p>}
      <p className="muted tiny">For your CA to prepare GSTR-1.</p>
    </div>
  );
}
