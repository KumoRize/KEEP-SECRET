import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/password/forgot', { method: 'POST', json: { email } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h1>Reset your password</h1>
        {sent ? (
          <p role="status">If an account exists for {email}, we've emailed a reset link. It expires in 1 hour.</p>
        ) : (
          <>
            <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary">Send reset link</button>
          </>
        )}
        <p className="muted"><Link to="/login">Back to log in</Link></p>
      </form>
    </div>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/auth/password/reset', { method: 'POST', json: { token: params.get('token') ?? '', password } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h1>Choose a new password</h1>
        {done ? (
          <p role="status">Password updated and all devices signed out. <Link to="/login">Log in</Link></p>
        ) : (
          <>
            <label>
              New password
              <input type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
            </label>
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary">Update password</button>
          </>
        )}
      </form>
    </div>
  );
}

export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { me, reload } = useAuth();
  const [state, setState] = useState<'working' | 'ok' | 'error'>('working');
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // Tokens are single use; StrictMode double-invokes effects in development.
    if (started.current) return;
    started.current = true;
    api('/auth/verify-email', { method: 'POST', json: { token: params.get('token') ?? '' } })
      .then(async () => {
        setState('ok');
        if (me) await reload();
      })
      .catch((err) => {
        setState('error');
        setError((err as Error).message);
      });
  }, [params, me, reload]);

  return (
    <div className="auth">
      <div className="card stack">
        <h1>Email verification</h1>
        {state === 'working' && <p className="muted">Verifying…</p>}
        {state === 'ok' && <p role="status">Your email is verified. <Link to="/">Start creating</Link></p>}
        {state === 'error' && <p className="error" role="alert">{error} You can request a new link from the app.</p>}
      </div>
    </div>
  );
}

export function VerifyBanner() {
  const [msg, setMsg] = useState('');
  const resend = async () => {
    try {
      await api('/auth/verify-email/resend', { method: 'POST' });
      setMsg('Sent. Check your inbox.');
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  return (
    <div className="banner" role="status">
      <span>Verify your email to start generating.</span>
      {msg ? <span className="muted">{msg}</span> : <button className="link" onClick={resend}>Resend email</button>}
    </div>
  );
}
