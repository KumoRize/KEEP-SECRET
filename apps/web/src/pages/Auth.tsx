import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await login(email, password);
      else await register(email, password, name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        <p className="muted">Images, video, 3D, websites, apps, games and music from one prompt.</p>
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
        <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Sign up free'}</button>
        {mode === 'login'
          ? <p className="muted"><Link to="/forgot-password">Forgot password?</Link> · New here? <Link to="/register">Create an account</Link></p>
          : <p className="muted">Have an account? <Link to="/login">Log in</Link></p>}
      </form>
    </div>
  );
}
