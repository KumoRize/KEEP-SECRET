import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';

interface Referral { code: string; link: string; rewardCredits: number; friendCredits: number; signups: number; rewarded: number; credits: number }

export function InvitePage() {
  const [r, setR] = useState<Referral | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { api<Referral>('/referrals').then(setR).catch(() => undefined); }, []);
  if (!r) return <div className="skeleton" />;
  const share = `I'm creating images, videos, apps and more with AI on Creator Studio. Join with my link and get ${r.friendCredits} bonus credits: ${r.link}`;
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="hero" style={{ textAlign: 'left' }}>
        <span className="pill"><Icon name="gift" size={14} /> Invite & earn</span>
        <h1 style={{ marginTop: 12 }}>Give <span className="gradient-text">{r.friendCredits}</span>, get <span className="gradient-text">{r.rewardCredits}</span> credits</h1>
        <p>When a friend you invite makes their first purchase, you get {r.rewardCredits} credits and they get {r.friendCredits} bonus credits.</p>
      </div>
      <section className="card glow stack">
        <label>Your invite link
          <div className="row"><input readOnly value={r.link} onFocus={(e) => e.target.select()} />
            <button className="primary" onClick={() => { void navigator.clipboard?.writeText(r.link); setCopied(true); }}><Icon name={copied ? 'check' : 'copy'} size={16} /> {copied ? 'Copied' : 'Copy'}</button></div>
        </label>
        <div className="row wrap">
          <a className="btn" href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
          <a className="btn" href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(share)}`} target="_blank" rel="noopener noreferrer">Share on X</a>
          {'share' in navigator && <button onClick={() => navigator.share({ text: share }).catch(() => undefined)}>More…</button>}
        </div>
      </section>
      <div className="kpis">
        <div className="card kpi"><span className="muted small">Code</span><strong>{r.code}</strong></div>
        <div className="card kpi"><span className="muted small">Sign-ups</span><strong>{r.signups}</strong></div>
        <div className="card kpi"><span className="muted small">Rewarded</span><strong>{r.rewarded}</strong></div>
        <div className="card kpi"><span className="muted small">Credits earned</span><strong>{r.credits}</strong></div>
      </div>
    </div>
  );
}
