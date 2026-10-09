import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

interface Profile { legal_name: string; address: string; state_code: string | null; gstin: string | null }
interface Invoice { id: string; number: string; docType: string; issuedAt: string; description: string; totalPaise: number; taxPaise: number; htmlUrl: string }

const inr = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

export function BillingDetails() {
  const [states, setStates] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ legalName: '', address: '', stateCode: '', gstin: '' });
  const [msg, setMsg] = useState('');
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  useEffect(() => {
    api<{ profile: Profile; states: Record<string, string> }>('/billing/profile').then((r) => {
      setStates(r.states);
      setForm({ legalName: r.profile.legal_name, address: r.profile.address, stateCode: r.profile.state_code ?? '', gstin: r.profile.gstin ?? '' });
    }).catch(() => undefined);
    api<{ items: Invoice[] }>('/billing/invoices').then((r) => setInvoices(r.items)).catch(() => undefined);
  }, []);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setMsg('');
    try {
      await api('/billing/profile', {
        method: 'PUT',
        json: { legalName: form.legalName, address: form.address, stateCode: form.stateCode || null, gstin: form.gstin.trim() || null },
      });
      setMsg('Saved. Used on invoices for future payments.');
    } catch (err) {
      const e2 = err as ApiError;
      setMsg((e2.details as { message: string }[] | undefined)?.map((d) => d.message).join('. ') || e2.message);
    }
  };

  // Links are short-lived, so fetch a fresh one at click time rather than reusing the listed URL.
  const open = async (id: string) => {
    const inv = await api<Invoice>(`/billing/invoices/${id}`);
    window.open(inv.htmlUrl, '_blank', 'noopener');
  };

  return (
    <>
      <h2>Invoices</h2>
      <div className="card">
        {invoices.length === 0 ? <p className="muted">Invoices appear here after each payment.</p> : (
          <table className="table">
            <thead><tr><th>Number</th><th>Date</th><th>Total</th><th /></tr></thead>
            <tbody>
              {invoices.map((i) => (
                <tr key={i.id}>
                  <td>{i.number}</td>
                  <td>{new Date(i.issuedAt).toLocaleDateString('en-IN')}</td>
                  <td>{inr(i.totalPaise)}{i.taxPaise > 0 && <span className="muted small"> incl. {inr(i.taxPaise)} GST</span>}</td>
                  <td><button className="link" onClick={() => open(i.id)}>View / PDF</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Billing details</h2>
      <form className="card stack" onSubmit={save}>
        <p className="muted small">Optional. Businesses can add a GSTIN to claim input tax credit.</p>
        <label>Name on invoice<input value={form.legalName} maxLength={200} onChange={(e) => setForm({ ...form, legalName: e.target.value })} /></label>
        <label>Address<textarea rows={2} maxLength={500} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
        <label>
          State
          <select value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>
            <option value="">Not specified</option>
            {Object.entries(states).map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </label>
        <label>GSTIN (optional)<input value={form.gstin} maxLength={15} placeholder="e.g. 29ABCDE1234F1Z5" onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></label>
        {msg && <p role="status">{msg}</p>}
        <button className="primary">Save billing details</button>
      </form>
    </>
  );
}
