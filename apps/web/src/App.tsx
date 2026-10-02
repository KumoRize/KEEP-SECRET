import { Navigate, NavLink, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { AdminPage } from './pages/Admin';
import { ForgotPasswordPage, ResetPasswordPage, VerifyBanner, VerifyEmailPage } from './pages/AccountLinks';
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
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
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
      {!me.user.emailVerified && <VerifyBanner />}
      <main className="content">
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
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
