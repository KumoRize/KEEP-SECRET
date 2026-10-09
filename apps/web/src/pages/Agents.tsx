import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { Icon } from '../components/Icon';
import { ModelPicker } from '../components/ModelPicker';

interface Agent {
  id: string; name: string; description: string; instructions?: string; model_id: string | null; tools: string[];
  starter_prompts: string[]; visibility?: 'private' | 'public'; uses: number; creator?: string;
}
interface Draft { name: string; description: string; instructions: string; modelId: string; tools: string[]; starterPrompts: string; visibility: 'private' | 'public' }

const EMPTY: Draft = { name: '', description: '', instructions: '', modelId: '', tools: [], starterPrompts: '', visibility: 'private' };
const IDEAS = ['A YouTube script writer for tech reviews', 'A strict but kind JEE physics tutor', 'A legal-notice explainer in simple Hindi and English', 'A startup pitch-deck critic', 'A daily news briefer with sources'];

export function AgentsPage() {
  const { reload } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'mine' | 'discover'>('mine');
  const [mine, setMine] = useState<Agent[]>([]);
  const [publicAgents, setPublic] = useState<Agent[]>([]);
  const [q, setQ] = useState('');
  const [idea, setIdea] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const [m, p] = await Promise.all([
      api<{ items: Agent[] }>('/agents'),
      api<{ items: Agent[] }>(`/agents/public${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    ]);
    setMine(m.items);
    setPublic(p.items);
  }, [q]);
  useEffect(() => { void load().catch(() => undefined); }, [load]);

  const generate = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api<{ draft: { name: string; description: string; instructions: string; starterPrompts: string[]; tools: string[] }; credits: number }>(
        '/agents/generate', { method: 'POST', json: { description: idea } });
      setDraft({ ...EMPTY, ...r.draft, starterPrompts: r.draft.starterPrompts.join('\n') });
      setEditing(null);
      setMsg(r.credits ? `Generated for ${r.credits} credits. Review and save.` : 'Generated. Review and save.');
      void reload();
    } catch (e) { setMsg((e as ApiError).message); } finally { setBusy(false); }
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    setBusy(true); setMsg('');
    const body = {
      name: draft.name, description: draft.description, instructions: draft.instructions, modelId: draft.modelId || null,
      tools: draft.tools, starterPrompts: draft.starterPrompts.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 6), visibility: draft.visibility,
    };
    try {
      await api(editing ? `/agents/${editing}` : '/agents', { method: editing ? 'PUT' : 'POST', json: body });
      setDraft(null); setEditing(null); setIdea('');
      setMsg('Agent saved.');
      await load();
    } catch (err) {
      const e2 = err as ApiError;
      setMsg((e2.details as { message: string }[] | undefined)?.map((d) => d.message).join('. ') || e2.message);
    } finally { setBusy(false); }
  };

  const chat = async (agentId: string) => {
    const c = await api<{ id: string }>('/chat/conversations', { method: 'POST', json: { agentId } });
    nav(`/chat/${c.id}`);
  };

  const edit = (a: Agent) => {
    setDraft({ name: a.name, description: a.description, instructions: a.instructions ?? '', modelId: a.model_id ?? '', tools: a.tools,
      starterPrompts: a.starter_prompts.join('\n'), visibility: a.visibility ?? 'private' });
    setEditing(a.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const remove = async (a: Agent) => {
    if (!window.confirm(`Delete "${a.name}"?`)) return;
    await api(`/agents/${a.id}`, { method: 'DELETE' });
    await load();
  };

  const card = (a: Agent, own: boolean) => (
    <article key={a.id} className="card model-card">
      <div className="row start">
        <div className="model-avatar" style={{ background: 'var(--grad)' }}><Icon name="bot" /></div>
        <div className="grow">
          <h3>{a.name}</h3>
          <div className="muted tiny">{own ? (a.visibility === 'public' ? 'Public' : 'Private') : `by ${a.creator}`} · {a.uses} chats{a.tools.includes('web_search') ? ' · web search' : ''}</div>
        </div>
      </div>
      <p className="model-desc">{a.description || 'No description'}</p>
      <div className="row">
        <button className="primary grow" onClick={() => chat(a.id)}><Icon name="chat" size={16} /> Chat</button>
        {own && <button onClick={() => edit(a)}>Edit</button>}
        {own && <button className="ghost icon danger" aria-label={`Delete ${a.name}`} onClick={() => remove(a)}><Icon name="trash" size={16} /></button>}
      </div>
    </article>
  );

  return (
    <div className="stack">
      <div className="hero" style={{ textAlign: 'left' }}>
        <span className="pill"><Icon name="bot" size={14} /> Agent studio</span>
        <h1 style={{ marginTop: 12 }}>Build your own <span className="gradient-text">AI agents</span></h1>
        <p>Describe an agent in one sentence. AI writes its instructions; you tweak, save, share and chat.</p>
      </div>

      <section className="card glow stack">
        <h2><Icon name="sparkles" /> Create with AI</h2>
        <div className="row wrap">
          <input className="grow" value={idea} onChange={(e) => setIdea(e.target.value)} maxLength={1000} placeholder="e.g. A friendly fitness coach who builds 4-week home workout plans" aria-label="Describe your agent" />
          <button className="primary" disabled={busy || idea.trim().length < 5} onClick={generate}>{busy ? 'Generating…' : 'Generate agent'}</button>
          <button onClick={() => { setDraft({ ...EMPTY }); setEditing(null); }}>Start blank</button>
        </div>
        <div className="chips">{IDEAS.map((i) => <button key={i} className="chip" onClick={() => setIdea(i)}>{i}</button>)}</div>
        {msg && <p role="status" className="small">{msg}</p>}
      </section>

      {draft && (
        <form className="card stack" onSubmit={save}>
          <h2>{editing ? 'Edit agent' : 'New agent'}</h2>
          <div className="grid two" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
            <label>Name<input required minLength={2} maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label>Model<ModelPicker category="chat" value={draft.modelId} onChange={(v) => setDraft({ ...draft, modelId: v })} /></label>
          </div>
          <label>Short description<input maxLength={300} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></label>
          <label>Instructions (system prompt)<textarea required minLength={10} rows={8} maxLength={8000} value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} /></label>
          <label>Starter prompts (one per line)<textarea rows={3} value={draft.starterPrompts} onChange={(e) => setDraft({ ...draft, starterPrompts: e.target.value })} /></label>
          <div className="row wrap">
            <label className="row" style={{ flexDirection: 'row', fontWeight: 500 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={draft.tools.includes('web_search')}
                onChange={(e) => setDraft({ ...draft, tools: e.target.checked ? ['web_search'] : [] })} /> Web search (live sources, small extra cost)
            </label>
            <span className="grow" />
            <div className="chips" role="radiogroup" aria-label="Visibility">
              {(['private', 'public'] as const).map((v) => (
                <button type="button" key={v} role="radio" aria-checked={draft.visibility === v} className={draft.visibility === v ? 'chip active' : 'chip'} onClick={() => setDraft({ ...draft, visibility: v })}>
                  {v === 'private' ? 'Private' : 'Public in gallery'}
                </button>
              ))}
            </div>
          </div>
          <p className="muted tiny">Public agents show their name and description in the gallery; instructions stay private.</p>
          <div className="row">
            <button className="primary" disabled={busy}>Save agent</button>
            <button type="button" className="ghost" onClick={() => { setDraft(null); setEditing(null); }}>Cancel</button>
          </div>
        </form>
      )}

      <div className="row wrap between">
        <div className="chips" role="tablist">
          <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'chip active' : 'chip'} onClick={() => setTab('mine')}>My agents <span className="count">{mine.length}</span></button>
          <button role="tab" aria-selected={tab === 'discover'} className={tab === 'discover' ? 'chip active' : 'chip'} onClick={() => setTab('discover')}>Discover <span className="count">{publicAgents.length}</span></button>
        </div>
        {tab === 'discover' && <input style={{ maxWidth: 280 }} placeholder="Search agents" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agents" />}
      </div>
      <div className="grid">
        {(tab === 'mine' ? mine : publicAgents).map((a) => card(a, tab === 'mine'))}
      </div>
      {(tab === 'mine' ? mine : publicAgents).length === 0 && <p className="center muted">{tab === 'mine' ? 'No agents yet. Generate one above.' : 'No public agents yet. Be the first to share one.'}</p>}
    </div>
  );
}
