import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { ForgotPasswordPage, ResetPasswordPage, VerifyEmailPage } from './pages/AccountLinks';
import { AdminPage } from './pages/Admin';
import { AgentsPage } from './pages/Agents';
import { AuthPage } from './pages/Auth';
import { BillingPage } from './pages/Billing';
import { ChatPage } from './pages/Chat';
import { DeveloperPage } from './pages/Developer';
import { ExplorePage } from './pages/Explore';
import { InvitePage } from './pages/Invite';
import { LibraryPage } from './pages/Library';
import { StudioPage } from './pages/Studio';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <div className="center muted"><div className="aurora" />Loading…</div>;
  if (!me) {
    return (
      <Routes>
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route path="/forgot-password" element={<ForgotPasswordPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        {/* The model universe is public: useful for marketing and SEO. */}
        <Route path="/explore" element={<Layout><ExplorePage /></Layout>} />
        <Route path="*" element={<AuthPage mode="login" />} />
      </Routes>
    );
  }
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<StudioPage />} />
        <Route path="/explore" element={<ExplorePage />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:id" element={<ChatPage />} />
        <Route path="/research" element={<ChatPage defaultMode="research" />} />
        <Route path="/agents" element={<AgentsPage />} />
        <Route path="/library" element={<LibraryPage />} />
        <Route path="/billing" element={<BillingPage />} />
        <Route path="/invite" element={<InvitePage />} />
        <Route path="/developer" element={<DeveloperPage />} />
        <Route path="/verify-email" element={<VerifyEmailPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {me.user.role === 'admin' && <Route path="/admin" element={<AdminPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
