import { useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { VerifyBanner } from '../pages/AccountLinks';
import { Icon, IconDefs } from './Icon';

const MAIN = [
  { to: '/', label: 'Studio', icon: 'sparkles', end: true },
  { to: '/explore', label: 'Explore AI', icon: 'globe' },
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/agents', label: 'Agents', icon: 'bot' },
  { to: '/research', label: 'Research', icon: 'telescope' },
];
const MORE = [
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/billing', label: 'Plans & credits', icon: 'wallet' },
  { to: '/invite', label: 'Invite & earn', icon: 'gift' },
  { to: '/developer', label: 'Developer API', icon: 'key' },
];

export function Layout({ children }: { children: ReactNode }) {
  const { me, logout } = useAuth();
  const [sheet, setSheet] = useState(false);
  const loc = useLocation();
  const admin = me?.user.role === 'admin';
  const nav = (items: typeof MAIN) => items.map((i) => (
    <NavLink key={i.to} to={i.to} end={'end' in i ? i.end : false} onClick={() => setSheet(false)}>
      <Icon name={i.icon} /> {i.label}
    </NavLink>
  ));

  return (
    <div className="shell">
      <IconDefs />
      <div className="aurora" />
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="brand"><span className="logo">✦</span> Creator Studio</Link>
        <nav className="nav" style={{ marginTop: 14 }}>
          {nav(MAIN)}
          <div className="label">Workspace</div>
          {nav(MORE)}
          {admin && <><div className="label">Owner</div>{nav([{ to: '/admin', label: 'Admin & profit', icon: 'chart' }])}</>}
        </nav>
        {me && (
          <div className="credit-card stack tight">
            <span className="muted small">Credits</span>
            <strong>{me.balance.total.toLocaleString('en-IN')}</strong>
            <span className="muted tiny">{me.user.plan.name} plan</span>
            <Link to="/billing" className="btn primary">Upgrade</Link>
            <button className="ghost small" onClick={logout}><Icon name="logout" size={16} /> Log out</button>
          </div>
        )}
      </aside>

      <div style={{ minWidth: 0 }}>
        <header className="topbar">
          <Link to="/" className="brand"><span className="logo">✦</span> <span>Creator Studio</span></Link>
          <span className="grow" />
          {me ? (
            <Link to="/billing" className="pill" title="Available credits"><Icon name="bolt" size={14} /> {me.balance.total.toLocaleString('en-IN')}</Link>
          ) : (
            <><Link to="/login" className="btn ghost">Log in</Link><Link to="/register" className="btn primary">Start free</Link></>
          )}
        </header>
        {me && me.user.verificationRequired && !me.user.emailVerified && <VerifyBanner />}
        <main className="content" key={loc.pathname.split('/')[1]}>{children}</main>
      </div>

      {me && (
        <nav className="tabbar" aria-label="Main">
          {MAIN.slice(0, 4).map((i) => (
            <NavLink key={i.to} to={i.to} end={i.end}><Icon name={i.icon} size={22} />{i.label.replace(' AI', '')}</NavLink>
          ))}
          <button onClick={() => setSheet(true)} aria-haspopup="dialog"><Icon name="menu" size={22} />More</button>
        </nav>
      )}
      {sheet && (
        <>
          <div className="sheet-backdrop" onClick={() => setSheet(false)} />
          <div className="sheet" role="dialog" aria-label="More">
            {[...MAIN.slice(4), ...MORE, ...(admin ? [{ to: '/admin', label: 'Admin & profit', icon: 'chart' }] : [])].map((i) => (
              <Link key={i.to} to={i.to} onClick={() => setSheet(false)}><Icon name={i.icon} /> {i.label}</Link>
            ))}
            <Link to="/" onClick={() => { setSheet(false); void logout(); }}><Icon name="logout" /> Log out</Link>
          </div>
        </>
      )}
    </div>
  );
}
