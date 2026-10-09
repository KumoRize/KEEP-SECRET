import { Navigate, Route, Routes } from 'react-router-dom';
import { isStaff } from './api';
import { useAuth } from './auth';
import { useSite } from './lib/site';
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
import { MaintenancePage } from './pages/Maintenance';

export function App() {
  const { me, loading } = useAuth();
  const site = useSite();
  if (loading) return <div className="center muted"><div className="aurora" />Loading…</div>;
  // Maintenance: customers see a holding page; the owner and staff keep full access.
  if (site?.maintenance && !isStaff(me)) {
    return (
      <Routes>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="*" element={<MaintenancePage message={site.maintenanceMessage} />} />
      </Routes>
    );
  }
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
        {isStaff(me) && <Route path="/admin" element={<AdminPage />} />}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
