import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, MODALITY_LABELS } from '../api';
import { useAuth } from '../auth';
import { CATEGORY_META, Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ModelPicker } from '../components/ModelPicker';
import { streamMessage } from '../lib/stream';

interface Citation { n: number; title: string; url: string }
/** `key` stays stable while `id` changes from a temporary to the saved id, so the bubble isn't remounted. */
interface Message { id: number | string; key?: string; role: 'user' | 'assistant'; content: string; citations: Citation[]; credits?: number }
interface ConvSummary { id: string; mode: string; title: string; agent_name: string | null; updated_at: string }
interface ConvDetail { id: string; mode: string; title: string; model_id: string | null; agent_id: string | null; agent_name: string | null; starter_prompts: string[] | null; messages: Message[] }

const MODES = ['chat', 'story', 'code', 'research'] as const;
const STARTERS: Record<string, string[]> = {
  chat: ['Help me plan my week', 'Explain inflation simply', 'Draft a LinkedIn post about my new job'],
  story: ['A thriller set on a Mumbai local train', 'Write a 3-scene short film script', 'A fantasy world with floating cities'],
  code: ['Build a REST API in Express with validation', 'Explain this regex: ^\\d{3}-\\d{4}$', 'Write unit tests for a date parser'],
  research: ['What changed in India’s DPDP rules this year?', 'Best practices for RAG evaluation', 'EV adoption in India vs China'],
};

export function ChatPage({ defaultMode }: { defaultMode?: 'research' }) {
  const { id } = useParams();
  const nav = useNavigate();
  const location = useLocation();
  const { reload } = useAuth();
  const [convs, setConvs] = useState<ConvSummary[]>([]);
  const [conv, setConv] = useState<ConvDetail | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<string>(defaultMode ?? 'chat');
  const [modelId, setModelId] = useState('');
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [history, setHistory] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const autoSent = useRef(false);

  const loadList = useCallback(() => api<{ items: ConvSummary[] }>('/chat/conversations').then((r) => setConvs(r.items)).catch(() => undefined), []);
  useEffect(() => { void loadList(); }, [loadList]);

  useEffect(() => {
    setError('');
    if (!id) { setConv(null); setMessages([]); setMode(defaultMode ?? 'chat'); return; }
    api<ConvDetail>(`/chat/conversations/${id}`).then((c) => {
      setConv(c);
      setMessages(c.messages);
      setMode(c.mode);
      setModelId(c.model_id ?? '');
    }).catch(() => nav('/chat', { replace: true }));
  }, [id, defaultMode, nav]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const send = useCallback(async (text: string, targetId?: string) => {
    const content = text.trim();
    if (!content || streaming) return;
    setError('');
    setInput('');
    let convId = targetId ?? id;
    if (!convId) {
      try {
        const c = await api<{ id: string }>('/chat/conversations', { method: 'POST', json: { mode, ...(modelId ? { modelId } : {}) } });
        convId = c.id;
        nav(`/chat/${c.id}`, { replace: true, state: { send: content } });
        return; // the conversation view sends it once loaded
      } catch (e) { setError((e as Error).message); return; }
    }
    const tmpId = `a-${Date.now()}`;
    setMessages((m) => [...m, { id: `u-${Date.now()}`, key: `u-${Date.now()}`, role: 'user', content, citations: [] }, { id: tmpId, key: tmpId, role: 'assistant', content: '', citations: [] }]);
    setStreaming(true);
    abort.current = new AbortController();
    const patch = (fn: (m: Message) => Message) => setMessages((all) => all.map((m) => (m.key === tmpId ? fn(m) : m)));
    try {
      await streamMessage(convId, { content, ...(modelId ? { modelId } : {}) }, {
        onMeta: (d) => setNote(d.model.dataNote ? `${d.model.label}: ${d.model.dataNote}` : `${d.model.label}${d.model.isFree ? ' · free' : ` · up to ${d.reservedCredits} credits reserved`}`),
        onSources: (s) => patch((m) => ({ ...m, citations: s })),
        onDelta: (t) => patch((m) => ({ ...m, content: m.content + t })),
        onDone: (d) => { patch((m) => ({ ...m, id: d.messageId ?? m.id, credits: d.credits, citations: d.citations.length ? d.citations : m.citations })); if (d.warning) setError(d.warning); },
        onError: (msg) => { setError(msg); setMessages((all) => all.filter((m) => !(m.key === tmpId && !m.content))); },
      }, abort.current.signal);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    } finally {
      setStreaming(false);
      void loadList();
      void reload();
    }
  }, [id, mode, modelId, nav, streaming, loadList, reload]);

  // Prompt handed over from the Studio or from conversation creation: send exactly once.
  useEffect(() => {
    const pending = (location.state as { send?: string } | null)?.send;
    if (id && conv?.id === id && pending && !autoSent.current) {
      autoSent.current = true;
      nav(location.pathname, { replace: true, state: null });
      void send(pending, id);
    }
  }, [id, conv, location, nav, send]);
  useEffect(() => { autoSent.current = false; }, [id]);

  const newChat = (m: string) => { setMode(m); setModelId(''); nav(m === 'research' ? '/research' : '/chat'); };
  const remove = async (cid: string) => {
    await api(`/chat/conversations/${cid}`, { method: 'DELETE' });
    if (cid === id) nav('/chat');
    void loadList();
  };

  const category = mode === 'agent' ? 'chat' : mode;
  const starters = conv?.starter_prompts?.length ? conv.starter_prompts : STARTERS[category] ?? [];
  const list = (
    <>
      <button className="primary" onClick={() => newChat(defaultMode ?? 'chat')}><Icon name="plus" size={18} /> New chat</button>
      {convs.length === 0 && <p className="muted small" style={{ padding: 8 }}>Your conversations appear here.</p>}
      {convs.map((c) => (
        <div key={c.id} className="row" style={{ gap: 4 }}>
          <button className={`conv-item grow${c.id === id ? ' active' : ''}`} onClick={() => { setHistory(false); nav(`/chat/${c.id}`); }}>
            <Icon name={c.mode === 'agent' ? 'bot' : CATEGORY_META[c.mode]?.icon ?? 'chat'} size={16} />
            <span>{c.title}</span>
          </button>
          <button className="ghost icon" aria-label={`Delete ${c.title}`} onClick={() => remove(c.id)}><Icon name="trash" size={15} /></button>
        </div>
      ))}
    </>
  );

  return (
    <div className="chat">
      <aside className="conv-list" aria-label="Conversations">{list}</aside>

      <section className="thread">
        <div className="thread-head">
          <button className="ghost icon" style={{ display: 'inline-flex' }} onClick={() => setHistory(true)} aria-label="Conversation history"><Icon name="menu" /></button>
          {conv?.agent_name ? (
            <span className="pill"><Icon name="bot" size={14} /> {conv.agent_name}</span>
          ) : !id ? (
            <div className="chips scroll" role="radiogroup" aria-label="Mode">
              {MODES.map((m) => (
                <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? 'chip active' : 'chip'} onClick={() => { setMode(m); setModelId(''); }}>
                  <Icon name={CATEGORY_META[m]!.icon} size={15} /> {CATEGORY_META[m]!.label}
                </button>
              ))}
            </div>
          ) : (
            <span className="pill"><Icon name={CATEGORY_META[mode]?.icon ?? 'chat'} size={14} /> {MODALITY_LABELS[mode]}</span>
          )}
          <span className="grow" />
          <div style={{ maxWidth: 320 }}><ModelPicker category={category} value={modelId} onChange={setModelId} /></div>
        </div>

        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="empty-chat">
              <div className="logo" style={{ width: 56, height: 56, fontSize: 26, borderRadius: 16 }}>✦</div>
              <h2>{conv?.agent_name ? `Chat with ${conv.agent_name}` : mode === 'research' ? 'Research with live web sources' : `${MODALITY_LABELS[mode]}: ask anything`}</h2>
              <p className="muted small">{CATEGORY_META[category]?.blurb}. Free models cost 0 credits.</p>
              <div className="chips">{starters.map((s) => <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>)}</div>
            </div>
          ) : messages.map((m, i) => (
            <div key={m.key ?? m.id} className={`msg ${m.role}`}>
              {m.role === 'assistant' && <div className="avatar">✦</div>}
              <div className="bubble">
                {m.role === 'assistant'
                  ? <Markdown text={m.content || '…'} streaming={streaming && i === messages.length - 1} />
                  : m.content}
                {m.citations.length > 0 && (
                  <div className="citations">
                    {m.citations.map((c) => <a key={c.n} href={c.url} target="_blank" rel="noopener noreferrer nofollow" title={c.url}>[{c.n}] {c.title}</a>)}
                  </div>
                )}
                {m.credits !== undefined && <div className="muted tiny" style={{ marginTop: 6 }}>{m.credits ? `${m.credits} credits` : 'free'}</div>}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>

        {error && <p className="error small" role="alert">{error} {/credit|limit|plan/i.test(error) && <Link to="/billing">Get more credits →</Link>}</p>}
        {note && !error && <p className="muted tiny">{note}</p>}
        <form className="composer-chat" onSubmit={(e) => { e.preventDefault(); void send(input); }}>
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={1} maxLength={12000} aria-label="Message"
            placeholder={mode === 'research' ? 'Ask a research question…' : mode === 'story' ? 'Describe the story or scene…' : mode === 'code' ? 'Describe the code you need…' : 'Message…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); } }} />
          {streaming
            ? <button type="button" className="icon" onClick={() => abort.current?.abort()} aria-label="Stop"><Icon name="stop" /></button>
            : <button type="submit" className="primary icon" disabled={!input.trim()} aria-label="Send"><Icon name="send" /></button>}
        </form>
      </section>

      {history && (
        <>
          <div className="sheet-backdrop" onClick={() => setHistory(false)} />
          <div className="sheet stack tight" role="dialog" aria-label="Conversations" style={{ maxHeight: '75dvh', overflowY: 'auto' }}>{list}</div>
        </>
      )}
    </div>
  );
}
