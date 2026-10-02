import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AdminPage } from './pages/Admin';
import { AuthPage } from './pages/Auth';
import { BillingPage } from './pages/Billing';
import { CreatePage } from './pages/Create';
import { LibraryPage } from './pages/Library';

export function App() {
  const { me, loading, logout } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!me) {
    return (
      <Routes>
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="*" element={<AuthPage mode="login" />} />
      </Routes>
    );
  }
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">Creator Studio</strong>
        <span className="pill" title="Available credits">{me.balance.total.toLocaleString('en-IN')} credits</span>
        <button className="link" onClick={logout}>Log out</button>
      </header>
      <main className="content">
        <Routes>
          <Route path="/" element={<CreatePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/billing" element={<BillingPage />} />
          {me.user.role === 'admin' && <Route path="/admin" element={<AdminPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end>Create</NavLink>
        <NavLink to="/library">Library</NavLink>
        <NavLink to="/billing">Billing</NavLink>
        {me.user.role === 'admin' && <NavLink to="/admin">Admin</NavLink>}
      </nav>
    </div>
  );
}
