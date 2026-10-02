import { useEffect, useState } from 'react';
import { api, type Balance, type Plan } from '../api';
import { useAuth } from '../auth';

interface Pack { id: string; name: string; credits: number; priceInr: number }
interface LedgerRow { id: number; kind: string; delta: number; balance_after: number; note: string | null; created_at: string }
interface RazorpayResponse { razorpay_payment_id: string; razorpay_order_id?: string; razorpay_signature: string }
declare global {
  interface Window { Razorpay?: new (opts: object) => { open: () => void } }
}

function loadCheckout(): Promise<void> {
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load payment checkout'));
    document.body.appendChild(s);
  });
}

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function BillingPage() {
  const { me, reload } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [msg, setMsg] = useState('');

  const load = async () => {
    const [c, w] = await Promise.all([
      api<{ plans: Plan[]; packs: Pack[] }>('/billing/catalog'),
      api<{ balance: Balance; ledger: LedgerRow[] }>('/billing/wallet'),
    ]);
    setPlans(c.plans);
    setPacks(c.packs);
    setLedger(w.ledger);
  };
  useEffect(() => { void load(); }, []);

  const buyPack = async (packId: string) => {
    setMsg('');
    try {
      const order = await api<{ keyId: string; orderId: string; amount: number; currency: string }>('/billing/orders', { method: 'POST', json: { packId } });
      await loadCheckout();
      new window.Razorpay!({
        key: order.keyId, order_id: order.orderId, amount: order.amount, currency: order.currency, name: 'Creator Studio',
        prefill: { email: me!.user.email },
        handler: async (r: RazorpayResponse) => {
          await api('/billing/orders/verify', { method: 'POST', json: { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } });
          setMsg('Payment successful. Credits added.');
          await Promise.all([reload(), load()]);
        },
      }).open();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const subscribe = async (planId: string) => {
    setMsg('');
    try {
      const sub = await api<{ keyId: string; subscriptionId: string }>('/billing/subscriptions', { method: 'POST', json: { planId } });
      await loadCheckout();
      new window.Razorpay!({
        key: sub.keyId, subscription_id: sub.subscriptionId, name: 'Creator Studio', prefill: { email: me!.user.email },
        // Plan activation is confirmed server-side by the subscription.charged webhook.
        handler: () => {
          setMsg('Subscription started. Your plan updates within a minute.');
          window.setTimeout(() => void Promise.all([reload(), load()]), 5000);
        },
      }).open();
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  const current = me!.user.plan.id;
  return (
    <div className="stack">
      <section className="card stack">
        <h1>Credits</h1>
        <div className="row wrap">
          <span className="pill big">{me!.balance.total.toLocaleString('en-IN')} total</span>
          <span className="muted">{me!.balance.subscription} monthly · {me!.balance.purchased} purchased (never expire)</span>
        </div>
        {msg && <p role="status">{msg}</p>}
      </section>

      <h2>Plans</h2>
      <ul className="grid">
        {plans.map((p) => (
          <li key={p.id} className={`card stack ${p.id === current ? 'current' : ''}`}>
            <div className="row between"><strong>{p.name}</strong><span>{p.priceInr ? `${inr(p.priceInr)}/mo` : 'Free'}</span></div>
            <ul className="small">
              <li>{p.monthlyCredits.toLocaleString('en-IN')} credits / month</li>
              <li>{p.modalities.length === 7 ? 'All 7 creation types' : `${p.modalities.length} creation types`}</li>
              <li>{p.dailyGenerations} generations/day · {p.maxConcurrent} at a time</li>
              {p.maxVideoSeconds > 0 && <li>Video up to {p.maxVideoSeconds}s</li>}
              <li>{p.commercialUse ? 'Commercial use' : 'Personal use only'}</li>
            </ul>
            {p.id === current
              ? <span className="muted">Current plan</span>
              : p.priceInr > 0 && <button className="primary" onClick={() => subscribe(p.id)}>Choose {p.name}</button>}
          </li>
        ))}
      </ul>
      {current !== 'free' && (
        <button className="link" onClick={() => api('/billing/subscriptions/cancel', { method: 'POST' }).then(() => setMsg('Cancels at the end of this billing period.')).catch((e) => setMsg(e.message))}>
          Cancel subscription
        </button>
      )}

      <h2>Credit packs</h2>
      <ul className="grid">
        {packs.map((p) => (
          <li key={p.id} className="card row between">
            <span><strong>{p.name}</strong><br /><span className="muted small">One-time, never expires</span></span>
            <button onClick={() => buyPack(p.id)}>{inr(p.priceInr)}</button>
          </li>
        ))}
      </ul>

      <h2>History</h2>
      <div className="card">
        <table className="table">
          <thead><tr><th>Date</th><th>Type</th><th>Change</th><th>Balance</th></tr></thead>
          <tbody>
            {ledger.map((l) => (
              <tr key={l.id}>
                <td>{new Date(l.created_at).toLocaleDateString('en-IN')}</td>
                <td>{l.kind.replace(/_/g, ' ')}</td>
                <td className={l.delta >= 0 ? 'pos' : 'neg'}>{l.delta > 0 ? '+' : ''}{l.delta}</td>
                <td>{l.balance_after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
