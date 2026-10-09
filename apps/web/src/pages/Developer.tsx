import { useEffect, useState } from 'react';
import { api } from '../api';
import { Icon } from '../components/Icon';

interface Key { id: string; name: string; prefix: string; last_used_at: string | null; created_at: string }

export function DeveloperPage() {
  const [keys, setKeys] = useState<Key[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const origin = window.location.origin;
  const load = () => api<{ items: Key[] }>('/developer/keys').then((r) => setKeys(r.items)).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  const create = async () => {
    setMsg('');
    try {
      const r = await api<{ key: string }>('/developer/keys', { method: 'POST', json: { name: name || 'My key' } });
      setFresh(r.key); setName(''); void load();
    } catch (e) { setMsg((e as Error).message); }
  };
  const revoke = async (k: Key) => {
    if (!window.confirm(`Revoke "${k.name}"? Apps using it stop working immediately.`)) return;
    await api(`/developer/keys/${k.id}`, { method: 'DELETE' });
    void load();
  };

  const example = `# 1) Estimate (shows the credit cost before anything runs)
curl -s ${origin}/api/v1/generations/estimate \\
  -H "Authorization: Bearer $CREATOR_KEY" -H "Content-Type: application/json" \\
  -d '{"prompt":"A neon logo for a chai cafe"}'

# 2) Generate with the returned quoteToken (idempotent per key)
curl -s ${origin}/api/v1/generations \\
  -H "Authorization: Bearer $CREATOR_KEY" -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"prompt":"A neon logo for a chai cafe","quoteToken":"<from step 1>"}'

# 3) Poll until status is succeeded; asset URLs are in the response
curl -s ${origin}/api/v1/generations/<id> -H "Authorization: Bearer $CREATOR_KEY"

# Chat / story / code / research (Server-Sent Events stream)
curl -N ${origin}/api/v1/chat/conversations/<conversationId>/messages \\
  -H "Authorization: Bearer $CREATOR_KEY" -H "Content-Type: application/json" \\
  -d '{"content":"Write a haiku about monsoon"}'

# Every model you can call
curl -s ${origin}/api/v1/catalog/models`;

  return (
    <div className="stack">
      <div className="hero" style={{ textAlign: 'left' }}>
        <span className="pill"><Icon name="key" size={14} /> Developer API</span>
        <h1 style={{ marginTop: 12 }}>Build on <span className="gradient-text">every model</span> with one key</h1>
        <p>Same credits, same models, same safety checks, from your own apps and scripts.</p>
      </div>

      <section className="card stack">
        <h2>API keys</h2>
        <div className="row wrap">
          <input className="grow" placeholder="Key name, e.g. My website" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" onClick={create}><Icon name="plus" size={16} /> Create key</button>
        </div>
        {fresh && (
          <div className="stack tight">
            <p className="small"><strong>Copy this key now.</strong> It won't be shown again.</p>
            <div className="row"><code className="secret grow">{fresh}</code><button onClick={() => navigator.clipboard?.writeText(fresh)}><Icon name="copy" size={16} /> Copy</button></div>
          </div>
        )}
        {msg && <p className="error">{msg}</p>}
        <div className="scroll-x">
          <table className="table">
            <thead><tr><th>Name</th><th>Key</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>{k.name}</td><td><code>{k.prefix}…</code></td>
                  <td className="muted">{k.last_used_at ? new Date(k.last_used_at).toLocaleString('en-IN') : 'Never'}</td>
                  <td><button className="ghost danger" onClick={() => revoke(k)}>Revoke</button></td>
                </tr>
              ))}
              {keys.length === 0 && <tr><td colSpan={4} className="muted">No keys yet.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="muted tiny">Keys act as your account and spend your credits. Admin features are never available through keys. Keep keys server-side.</p>
      </section>

      <section className="card stack">
        <h2>Quick start</h2>
        <div className="codebox"><pre>{example}</pre></div>
      </section>
    </div>
  );
}
