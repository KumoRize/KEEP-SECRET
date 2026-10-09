import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { CATEGORY_META, Icon } from '../components/Icon';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const [params] = useSearchParams();
  const ref = params.get('ref') ?? (() => { try { return localStorage.getItem('ref'); } catch { return null; } })();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Remember the invite code if the visitor browses around before signing up.
  if (params.get('ref')) { try { localStorage.setItem('ref', params.get('ref')!); } catch { /* storage unavailable */ } }

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name, ref ?? undefined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="aurora" />
      <div className="stack" style={{ width: '100%', maxWidth: 420 }}>
        <div className="stack tight" style={{ textAlign: 'center', alignItems: 'center' }}>
          <span className="logo" style={{ width: 48, height: 48, fontSize: 22, borderRadius: 14 }}>✦</span>
          <h1>{mode === 'login' ? <>Welcome <span className="gradient-text">back</span></> : <>One prompt. <span className="gradient-text">Every AI.</span></>}</h1>
          <div className="chips" style={{ justifyContent: 'center' }}>
            {['image', 'video', 'music', 'website', 'story', 'code'].map((k) => <span key={k} className="badge"><Icon name={CATEGORY_META[k]!.icon} size={12} />&nbsp;{CATEGORY_META[k]!.label}</span>)}
          </div>
        </div>
        <form className="card glow stack" onSubmit={submit}>
          {mode === 'register' && ref && <p className="pill" style={{ alignSelf: 'flex-start' }}><Icon name="gift" size={14} /> Invited! Bonus credits after your first purchase</p>}
          {mode === 'register' && (
            <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
          )}
          <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label>
            Password
            <input type="password" required minLength={mode === 'register' ? 10 : 1} value={password}
              onChange={(e) => setPassword(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary lg" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create free account'}</button>
          {mode === 'login'
            ? <p className="muted small"><Link to="/forgot-password">Forgot password?</Link> · New here? <Link to="/register">Create an account</Link></p>
            : <p className="muted small">Free plan includes 60 credits a month and free AI models. Have an account? <Link to="/login">Log in</Link></p>}
          <p className="muted tiny"><Link to="/explore">Browse all AI models →</Link></p>
        </form>
      </div>
    </div>
  );
}
