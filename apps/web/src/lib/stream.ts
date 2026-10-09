import { authHeaders, tryRefresh } from '../api';

export interface StreamHandlers {
  onMeta?: (d: { model: { id: string; label: string; isFree: boolean; dataNote: string }; reservedCredits: number; search: boolean }) => void;
  onSources?: (d: { n: number; title: string; url: string }[]) => void;
  onDelta?: (text: string) => void;
  onDone?: (d: { messageId: number | null; credits: number; citations: { n: number; title: string; url: string }[]; warning?: string; balance: { total: number } }) => void;
  onError?: (message: string, code?: string) => void;
}

/** POSTs a chat message and consumes the SSE reply (EventSource can't POST or send auth headers). */
export async function streamMessage(conversationId: string, body: { content: string; modelId?: string }, h: StreamHandlers, signal: AbortSignal, retry = true): Promise<void> {
  const res = await fetch(`/api/v1/chat/conversations/${conversationId}/messages`, {
    method: 'POST', signal, credentials: 'same-origin',
    headers: { ...authHeaders(), 'Content-Type': 'application/json', 'X-Requested-With': '1' },
    body: JSON.stringify(body),
  });
  if (res.status === 401 && retry && (await tryRefresh())) return streamMessage(conversationId, body, h, signal, false);
  if (!res.ok || !res.body) {
    const e = (await res.json().catch(() => ({}))).error ?? {};
    h.onError?.(e.message ?? `Request failed (${res.status})`, e.code);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: (.+)$/m.exec(block)?.[1];
      const raw = /^data: (.+)$/m.exec(block)?.[1];
      if (!event || !raw) continue;
      const data = JSON.parse(raw);
      if (event === 'meta') h.onMeta?.(data);
      else if (event === 'sources') h.onSources?.(data);
      else if (event === 'delta') h.onDelta?.(data.text);
      else if (event === 'done') h.onDone?.(data);
      else if (event === 'error') h.onError?.(data.message);
    }
  }
}
