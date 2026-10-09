import { useCallback, useEffect, useState } from 'react';
import { api, authHeaders } from '../api';

interface Stats {
  users: { total: number; paying: number };
  revenueInr: number;
  generationsByStatus: { status: string; n: number }[];
  providerCosts: { provider_id: string; modality: string; generations: number; credits: number; cost_usd: number }[];
}
interface Provider {
  id: string; name: string; configured: boolean; enabled: boolean; priority: number;
  circuit: { failures: number; open: boolean }; models: { id: string; modality: string; label: string; commercialUse: boolean }[];
}
interface User { id: string; email: string; plan_id: string; status: string; credits: number }

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
    <div className="card row wrap">
      <label>From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      <button onClick={download}>Download CSV</button>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

export function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const [s, p, u] = await Promise.all([
      api<Stats>('/admin/stats?days=30'),
      api<{ items: Provider[] }>('/admin/providers'),
      api<{ items: User[] }>(`/admin/users?${new URLSearchParams(q ? { q } : {})}`),
    ]);
    setStats(s);
    setProviders(p.items);
    setUsers(u.items);
  }, [q]);
  useEffect(() => { void load(); }, [load]);

  const updateProvider = async (p: Provider, patch: Partial<Pick<Provider, 'enabled' | 'priority'>>) => {
    await api(`/admin/providers/${p.id}`, { method: 'PUT', json: { enabled: p.enabled, priority: p.priority, ...patch } });
    void load();
  };

  const adjust = async (u: User) => {
    const amount = Number(window.prompt(`Credit adjustment for ${u.email} (negative to debit)`));
    if (!Number.isInteger(amount) || amount === 0) return;
    const reason = window.prompt('Reason (audited)') ?? '';
    try {
      await api(`/admin/users/${u.id}/credits`, { method: 'POST', json: { amount, reason } });
      void load();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const toggleSuspend = async (u: User) => {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', json: { status: u.status === 'active' ? 'suspended' : 'active' } });
    void load();
  };

  const cost = stats?.providerCosts.reduce((s, r) => s + r.cost_usd, 0) ?? 0;
  return (
    <div className="stack">
      <h1>Admin</h1>
      {msg && <p className="error">{msg}</p>}
      {stats && (
        <div className="grid kpis">
          <div className="card"><span className="muted small">Users</span><strong>{stats.users.total}</strong></div>
          <div className="card"><span className="muted small">Paying</span><strong>{stats.users.paying}</strong></div>
          <div className="card"><span className="muted small">Revenue (30d)</span><strong>₹{stats.revenueInr.toLocaleString('en-IN')}</strong></div>
          <div className="card"><span className="muted small">Provider cost (30d)</span><strong>${cost.toFixed(2)}</strong></div>
        </div>
      )}

      <h2>GST invoices export</h2>
      <InvoiceExport />

      <h2>Providers</h2>
      <div className="card">
        <table className="table">
          <thead><tr><th>Provider</th><th>Status</th><th>Priority</th><th>Models</th><th /></tr></thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{!p.configured ? 'No key' : p.circuit.open ? 'Circuit open' : p.enabled ? 'Enabled' : 'Disabled'}</td>
                <td><input type="number" className="narrow" defaultValue={p.priority} aria-label={`${p.name} priority`}
                  onBlur={(e) => Number(e.target.value) !== p.priority && updateProvider(p, { priority: Number(e.target.value) })} /></td>
                <td className="small">{p.models.map((m) => `${m.modality}${m.commercialUse ? '' : ' (non-commercial)'}`).join(', ') || '—'}</td>
                <td><button onClick={() => updateProvider(p, { enabled: !p.enabled })}>{p.enabled ? 'Disable' : 'Enable'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Cost by provider</h2>
      <div className="card">
        <table className="table">
          <thead><tr><th>Provider</th><th>Type</th><th>Jobs</th><th>Credits</th><th>Cost</th></tr></thead>
          <tbody>
            {stats?.providerCosts.map((r) => (
              <tr key={`${r.provider_id}-${r.modality}`}>
                <td>{r.provider_id}</td><td>{r.modality}</td><td>{r.generations}</td><td>{r.credits}</td><td>${r.cost_usd.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Users</h2>
      <input placeholder="Search email" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Email</th><th>Plan</th><th>Credits</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}{u.status !== 'active' && <span className="status failed"> suspended</span>}</td>
                <td>{u.plan_id}</td>
                <td>{u.credits}</td>
                <td className="row">
                  <button onClick={() => adjust(u)}>Credits</button>
                  <button onClick={() => toggleSuspend(u)}>{u.status === 'active' ? 'Suspend' : 'Restore'}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
