import { config } from '../../config.js';
import { cachedCatalog, type CatalogRow } from '../catalog/catalog.js';
import { openrouterHeaders } from '../providers/adapters/openrouter.js';
import { providerFetch } from '../providers/http.js';
import { ProviderError } from '../providers/types.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TextUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider-reported cost when available (OpenRouter); otherwise computed from token prices. */
  costUsd?: number;
}

export type TextEvent = { type: 'delta'; text: string } | { type: 'done'; usage: TextUsage };

export interface TextProvider {
  id: string;
  isConfigured(): boolean;
  stream(model: string, messages: ChatMessage[], opts: { maxTokens: number; signal: AbortSignal }): AsyncGenerator<TextEvent>;
}

/** Parses an SSE body into {event, data} records. Ignores comments (lines starting with ':'). */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data: string[] = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** OpenAI-compatible streaming (OpenRouter and OpenAI share the wire format). */
async function* openAiCompatible(
  name: string, url: string, headers: Record<string, string>, body: Record<string, unknown>, signal: AbortSignal,
): AsyncGenerator<TextEvent> {
  const res = await providerFetch(name, url, { method: 'POST', headers, signal, body: JSON.stringify({ ...body, stream: true }) });
  if (!res.body) throw new ProviderError(`${name}: empty stream`, 'retriable');
  let usage: TextUsage = { inputTokens: 0, outputTokens: 0 };
  for await (const { data } of sseEvents(res.body)) {
    if (data === '[DONE]') break;
    let chunk: {
      choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string; code?: number | string };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) {
      throw new ProviderError(`${name}: ${chunk.error.message ?? 'stream error'}`, String(chunk.error.code) === '400' ? 'rejected' : 'retriable');
    }
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason === 'content_filter') throw new ProviderError(`${name}: blocked by content filter`, 'rejected');
    const text = choice?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (chunk.usage) {
      usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0, costUsd: chunk.usage.cost };
    }
  }
  yield { type: 'done', usage };
}

const openrouter: TextProvider = {
  id: 'openrouter',
  isConfigured: () => Boolean(config.OPENROUTER_API_KEY),
  stream: (model, messages, { maxTokens, signal }) => openAiCompatible('openrouter', 'https://openrouter.ai/api/v1/chat/completions',
    openrouterHeaders(), { model, messages, max_tokens: maxTokens, usage: { include: true } }, signal),
};

const openai: TextProvider = {
  id: 'openai',
  isConfigured: () => Boolean(config.OPENAI_API_KEY),
  stream: (model, messages, { maxTokens, signal }) => openAiCompatible('openai', 'https://api.openai.com/v1/chat/completions',
    { Authorization: `Bearer ${config.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    { model, messages, max_completion_tokens: maxTokens, stream_options: { include_usage: true } }, signal),
};

const anthropic: TextProvider = {
  id: 'anthropic',
  isConfigured: () => Boolean(config.ANTHROPIC_API_KEY),
  async *stream(model, messages, { maxTokens, signal }) {
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const res = await providerFetch('anthropic', 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'x-api-key': config.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: maxTokens, stream: true, system: system || undefined,
        messages: messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.body) throw new ProviderError('anthropic: empty stream', 'retriable');
    const usage: TextUsage = { inputTokens: 0, outputTokens: 0 };
    for await (const { event, data } of sseEvents(res.body)) {
      const ev = JSON.parse(data) as {
        message?: { usage?: { input_tokens?: number } };
        delta?: { type?: string; text?: string; stop_reason?: string };
        usage?: { output_tokens?: number };
        error?: { message?: string; type?: string };
      };
      if (event === 'error') throw new ProviderError(`anthropic: ${ev.error?.message ?? 'stream error'}`, 'retriable');
      if (event === 'message_start') usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
      if (event === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) yield { type: 'delta', text: ev.delta.text };
      if (event === 'message_delta') {
        usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
        if (ev.delta?.stop_reason === 'refusal') throw new ProviderError('anthropic: request refused', 'rejected');
      }
    }
    yield { type: 'done', usage };
  },
};

/** Offline provider for development and tests; streams a deterministic reply. */
const mock: TextProvider = {
  id: 'mock',
  isConfigured: () => config.ENABLE_MOCK_PROVIDER,
  async *stream(model, messages) {
    const last = messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    if (last.includes('[mock:fail]')) throw new ProviderError('mock: simulated outage', 'retriable');
    if (last.includes('[mock:reject]')) throw new ProviderError('mock: content rejected', 'rejected');
    const system = messages.find((m) => m.role === 'system')?.content ?? '';
    // Agent-generator requests expect JSON back.
    const reply = system.includes('AGENT_SPEC_JSON')
      ? JSON.stringify({
        name: 'Mock Helper', description: 'A helpful mock agent.', instructions: `You help with: ${last.slice(0, 200)}`,
        starterPrompts: ['What can you do?', 'Give me a plan'], tools: ['web_search'],
      })
      : `Mock reply from ${model}. ${/\[\d\]/.test(system) ? 'According to the sources [1], ' : ''}You said: ${last.slice(0, 200)}`;
    for (const word of reply.split(/(?<= )/)) yield { type: 'delta', text: word };
    const inputTokens = Math.ceil(messages.reduce((n, m) => n + m.content.length, 0) / 4);
    yield { type: 'done', usage: { inputTokens, outputTokens: Math.ceil(reply.length / 4) } };
  },
};

const PROVIDERS: Record<string, TextProvider> = { openrouter, openai, anthropic, mock };
export const textProvider = (id: string): TextProvider | undefined => PROVIDERS[id];

/** Built-in text models from direct provider keys (not stored in the DB catalog). */
function builtinTextRows(): CatalogRow[] {
  const base = {
    tags: [], enabled: true, input_options: {}, max_duration_sec: null, commercial_use: true, data_note: '', source: 'default' as const,
    categories: ['chat', 'story', 'code', 'research'] as CatalogRow['categories'],
  };
  const rows: CatalogRow[] = [];
  if (config.ANTHROPIC_API_KEY) {
    rows.push({ ...base, id: `anthropic:${config.ANTHROPIC_MODEL}`, provider_id: 'anthropic', model: config.ANTHROPIC_MODEL,
      label: `Claude (${config.ANTHROPIC_MODEL})`, description: 'Anthropic Claude via direct API: writing, coding and analysis.',
      is_free: false, featured: true, quality: 9, pricing: { inputPerMTok: 3, outputPerMTok: 15 }, context_length: 200_000,
      license_note: 'Anthropic Commercial Terms: customer owns outputs.' });
  }
  if (config.OPENAI_API_KEY) {
    rows.push({ ...base, id: `openai:${config.OPENAI_CODE_MODEL}`, provider_id: 'openai', model: config.OPENAI_CODE_MODEL,
      label: `OpenAI ${config.OPENAI_CODE_MODEL}`, description: 'OpenAI model via direct API.',
      is_free: false, featured: true, quality: 8, pricing: { inputPerMTok: 2, outputPerMTok: 8 }, context_length: 128_000,
      license_note: 'OpenAI Services Agreement: customer owns output.' });
  }
  if (config.ENABLE_MOCK_PROVIDER) {
    rows.push({ ...base, id: 'mock:chat-free', provider_id: 'mock', model: 'mock-chat-free', label: 'Mock Free Chat',
      description: 'Development model (free).', tags: ['free'], is_free: true, featured: true, quality: 3, pricing: {},
      context_length: 32_000, license_note: 'Synthetic output.', data_note: 'Free model: test only.' });
    rows.push({ ...base, id: 'mock:chat-pro', provider_id: 'mock', model: 'mock-chat-pro', label: 'Mock Pro Chat',
      description: 'Development model (paid).', is_free: false, featured: true, quality: 7,
      pricing: { inputPerMTok: 3, outputPerMTok: 15 }, context_length: 128_000, license_note: 'Synthetic output.' });
  }
  return rows;
}

/** All usable text models: DB catalog rows whose provider is configured, plus built-ins. */
export function textModels(): CatalogRow[] {
  const db = cachedCatalog().filter((r) => r.enabled && r.categories.some((c) => ['chat', 'story', 'code', 'research'].includes(c))
    && PROVIDERS[r.provider_id]?.isConfigured());
  return [...builtinTextRows(), ...db];
}
