import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../api';
import { Icon } from '../../components/Icon';

interface KeyStatus { name: string; source: 'env' | 'dashboard' | 'none'; last4: string | null; updatedAt: string | null }

const GROUPS: { title: string; keys: { name: string; label: string; help: string; url: string }[] }[] = [
  { title: 'AI models', keys: [
    { name: 'OPENROUTER_API_KEY', label: 'OpenRouter', help: 'Hundreds of chat, writing and coding models, including free ones.', url: 'https://openrouter.ai/settings/keys' },
    { name: 'FAL_KEY', label: 'fal.ai', help: 'Image and video models (FLUX, Veo, Kling).', url: 'https://fal.ai/dashboard/keys' },
    { name: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude)', help: 'Optional direct Claude access.', url: 'https://console.anthropic.com/settings/keys' },
    { name: 'OPENAI_API_KEY', label: 'OpenAI', help: 'Optional: GPT Image and GPT models, plus free prompt moderation.', url: 'https://platform.openai.com/api-keys' },
    { name: 'STABILITY_API_KEY', label: 'Stability AI', help: 'Optional image provider.', url: 'https://platform.stability.ai/account/keys' },
    { name: 'REPLICATE_API_TOKEN', label: 'Replicate', help: 'Optional video/3D/music models (set model ids in server config).', url: 'https://replicate.com/account/api-tokens' },
    { name: 'ELEVENLABS_API_KEY', label: 'ElevenLabs', help: 'Optional music generation.', url: 'https://elevenlabs.io/app/settings/api-keys' },
  ] },
  { title: 'Web research', keys: [
    { name: 'TAVILY_API_KEY', label: 'Tavily', help: 'Web search for Research mode and agents.', url: 'https://app.tavily.com' },
    { name: 'BRAVE_SEARCH_API_KEY', label: 'Brave Search', help: 'Alternative web search.', url: 'https://api-dashboard.search.brave.com' },
  ] },
  { title: 'Payments (Razorpay)', keys: [
    { name: 'RAZORPAY_KEY_ID', label: 'Key ID', help: 'Dashboard > Account & Settings > API Keys.', url: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys' },
    { name: 'RAZORPAY_KEY_SECRET', label: 'Key Secret', help: 'Shown once when you generate the key.', url: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys' },
    { name: 'RAZORPAY_WEBHOOK_SECRET', label: 'Webhook secret', help: 'Create a webhook to /api/v1/webhooks/razorpay with payment.captured, order.paid and subscription.* events.', url: 'https://dashboard.razorpay.com/app/webhooks' },
  ] },
  { title: 'Email & alerts', keys: [
    { name: 'RESEND_API_KEY', label: 'Resend', help: 'Verification, password reset and your daily report. Verify your domain in Resend first.', url: 'https://resend.com/api-keys' },
    { name: 'ALERT_WEBHOOK_URL', label: 'Slack/Discord webhook', help: 'Instant alerts and the daily report in your chat app.', url: 'https://api.slack.com/messaging/webhooks' },
  ] },
];

export function KeysPanel({ focus }: { focus?: string }) {
  const [items, setItems] = useState<KeyStatus[]>([]);
  const [enc, setEnc] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});
  const [msgs, setMsgs] = useState<Record<string, { ok: boolean; text: string }>>({});
  const focusRef = useRef<HTMLInputElement | null>(null);

  const load = () => api<{ items: KeyStatus[]; encryptionAvailable: boolean }>('/owner/keys').then((r) => { setItems(r.items); setEnc(r.encryptionAvailable); }).catch(() => undefined);
  useEffect(() => { void load(); }, []);
  useEffect(() => { focusRef.current?.scrollIntoView({ block: 'center' }); focusRef.current?.focus(); }, [items.length, focus]);

  const say = (n: string, ok: boolean, text: string) => setMsgs((m) => ({ ...m, [n]: { ok, text } }));
  const save = async (name: string) => {
    try {
      const r = await api<{ test: { ok: boolean; message: string } }>(`/owner/keys/${name}`, { method: 'PUT', json: { value: values[name] ?? '' } });
      setValues((v) => ({ ...v, [name]: '' }));
      say(name, r.test.ok, r.test.message);
      void load();
    } catch (e) { say(name, false, (e as ApiError).message); }
  };
  const test = async (name: string) => {
    const r = await api<{ ok: boolean; message: string }>(`/owner/keys/${name}/test`, { method: 'POST' });
    say(name, r.ok, r.message);
  };
  const remove = async (name: string) => {
    if (!window.confirm(`Remove ${name}? Features using it stop working.`)) return;
    await api(`/owner/keys/${name}`, { method: 'DELETE' });
    say(name, true, 'Removed');
    void load();
  };

  return (
    <div className="stack">
      {!enc && (
        <div className="card flat" style={{ borderColor: 'var(--warn)' }}>
          <strong>One-time server step:</strong> ask your host to add <code>SETTINGS_ENCRYPTION_KEY</code> (generate with <code>openssl rand -hex 32</code>). After that you can paste every key here.
        </div>
      )}
      <p className="muted small">Keys are encrypted before they're saved and never shown again; you only see the last 4 characters. Keys set on the server are marked "server" and can only be changed there.</p>
      {GROUPS.map((g) => (
        <section key={g.title} className="card stack">
          <h2>{g.title}</h2>
          {g.keys.map((k) => {
            const st = items.find((i) => i.name === k.name);
            const m = msgs[k.name];
            return (
              <div key={k.name} className="stack tight" style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
                <div className="row wrap between">
                  <div>
                    <strong>{k.label}</strong>{' '}
                    {st?.source === 'env' && <span className="badge">Server · …{st.last4}</span>}
                    {st?.source === 'dashboard' && <span className="badge free">Saved · …{st.last4}</span>}
                    {st?.source === 'none' && <span className="badge">Not set</span>}
                    <div className="muted small">{k.help} <a href={k.url} target="_blank" rel="noopener noreferrer">Get key →</a></div>
                  </div>
                  {st && st.source !== 'none' && <div className="row"><button onClick={() => test(k.name)}>Test</button>{st.source === 'dashboard' && <button className="ghost danger" onClick={() => remove(k.name)}>Remove</button>}</div>}
                </div>
                {st?.source !== 'env' && (
                  <div className="row">
                    <input ref={k.name === focus ? focusRef : undefined} type="password" autoComplete="off" spellCheck={false} disabled={!enc}
                      placeholder={st?.source === 'dashboard' ? 'Paste a new key to replace' : 'Paste key'} aria-label={`${k.label} key`}
                      value={values[k.name] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [k.name]: e.target.value }))} />
                    <button className="primary" disabled={!enc || (values[k.name] ?? '').trim().length < 4} onClick={() => save(k.name)}>Save</button>
                  </div>
                )}
                {m && <p className={`small ${m.ok ? 'ok' : 'error'}`} role="status">{m.text}</p>}
              </div>
            );
          })}
        </section>
      ))}
    </div>
  );
}
