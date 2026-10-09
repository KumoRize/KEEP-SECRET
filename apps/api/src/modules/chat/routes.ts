import { Router, type Response } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { parse } from '../../middleware/validate.js';
import { getBalance } from '../billing/wallet.js';
import { TEXT_MODES, type TextMode } from '../providers/types.js';
import type { ChatMessage } from '../text/providers.js';
import { executeTurn, reserveTurn, resolveTextModel } from './engine.js';
import { agentPrompt, MODE_PROMPTS } from './prompts.js';

export const chatRoutes = Router();
chatRoutes.use(requireAuth);

interface Conversation { id: string; user_id: string; mode: TextMode; agent_id: string | null; model_id: string | null; title: string }
interface Agent { id: string; owner_id: string; name: string; instructions: string; model_id: string | null; tools: string[]; visibility: string }

const HISTORY_MESSAGES = 20;
const HISTORY_CHARS = 48_000;

chatRoutes.get('/conversations', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.mode, c.title, c.model_id, c.agent_id, a.name AS agent_name, c.updated_at
       FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id
      WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 100`,
    [req.user!.id],
  );
  res.json({ items: rows });
});

chatRoutes.post('/conversations', async (req, res) => {
  const b = parse(z.object({
    mode: z.enum(TEXT_MODES).default('chat'),
    agentId: z.uuid().optional(),
    modelId: z.string().max(200).optional(),
  }), req.body);
  let agent: Agent | undefined;
  if (b.mode === 'agent' || b.agentId) {
    if (!b.agentId) throw notFound('Agent not found');
    agent = (await pool.query<Agent>(
      `SELECT * FROM agents WHERE id = $1 AND (owner_id = $2 OR visibility = 'public')`, [b.agentId, req.user!.id],
    )).rows[0];
    if (!agent) throw notFound('Agent not found');
    if (agent.owner_id !== req.user!.id) await pool.query('UPDATE agents SET uses = uses + 1 WHERE id = $1', [agent.id]);
  }
  const mode: TextMode = agent ? 'agent' : b.mode;
  if (b.modelId) await resolveTextModel(mode, req.user!.plan_id, b.modelId); // validates availability
  const { rows } = await pool.query(
    `INSERT INTO conversations (user_id, mode, agent_id, model_id, title) VALUES ($1,$2,$3,$4,$5) RETURNING id, mode, title, model_id, agent_id, updated_at`,
    [req.user!.id, mode, agent?.id ?? null, b.modelId ?? agent?.model_id ?? null, agent ? `Chat with ${agent.name}` : 'New conversation'],
  );
  res.status(201).json(rows[0]);
});

chatRoutes.get('/conversations/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { rows: [conv] } = await pool.query(
    `SELECT c.id, c.mode, c.title, c.model_id, c.agent_id, a.name AS agent_name, a.starter_prompts
       FROM conversations c LEFT JOIN agents a ON a.id = c.agent_id WHERE c.id = $1 AND c.user_id = $2`,
    [id, req.user!.id],
  );
  if (!conv) throw notFound('Conversation not found');
  const { rows: messages } = await pool.query(
    'SELECT id, role, content, citations, model_id, created_at FROM messages WHERE conversation_id = $1 ORDER BY id', [id],
  );
  res.json({ ...conv, messages });
});

chatRoutes.patch('/conversations/:id', async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().min(1).max(120).optional(), modelId: z.string().max(200).nullable().optional() }), req.body);
  const { rows } = await pool.query(
    `UPDATE conversations SET title = COALESCE($3, title), model_id = CASE WHEN $4 THEN $5 ELSE model_id END, updated_at = now()
      WHERE id = $1 AND user_id = $2 RETURNING id, title, model_id`,
    [parse(z.uuid(), req.params.id), req.user!.id, b.title ?? null, b.modelId !== undefined, b.modelId ?? null],
  );
  if (!rows[0]) throw notFound('Conversation not found');
  res.json(rows[0]);
});

chatRoutes.delete('/conversations/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [parse(z.uuid(), req.params.id), req.user!.id]);
  if (!rowCount) throw notFound('Conversation not found');
  res.status(204).end();
});

function sse(res: Response) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering (nginx)
  res.flushHeaders();
  return (event: string, data: unknown) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/**
 * Sends a message and streams the reply as Server-Sent Events:
 * `meta` (model, reserved credits), `sources` (research/agents), `delta` (text), then `done` or `error`.
 * Validation, limits and the credit hold happen before streaming, so those failures are plain JSON errors.
 */
chatRoutes.post('/conversations/:id/messages', rateLimit({ name: 'chat', limit: 30, windowSec: 60 }), async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({ content: z.string().trim().min(1).max(12_000), modelId: z.string().max(200).optional() }), req.body);
  const user = req.user!;
  const { rows: [conv] } = await pool.query<Conversation>('SELECT * FROM conversations WHERE id = $1 AND user_id = $2', [id, user.id]);
  if (!conv) throw notFound('Conversation not found');
  const agent = conv.agent_id
    ? (await pool.query<Agent>(`SELECT * FROM agents WHERE id = $1 AND (owner_id = $2 OR visibility = 'public')`, [conv.agent_id, user.id])).rows[0]
    : undefined;
  if (conv.mode === 'agent' && !agent) throw notFound('This agent is no longer available');

  const row = await resolveTextModel(conv.mode, user.plan_id, b.modelId ?? conv.model_id ?? agent?.model_id);
  const system = agent ? agentPrompt(agent) : MODE_PROMPTS[conv.mode as Exclude<TextMode, 'agent'>];

  // Most recent history that fits the budget, oldest first.
  const { rows: past } = await pool.query<{ role: 'user' | 'assistant'; content: string }>(
    'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT $2', [id, HISTORY_MESSAGES],
  );
  const history: ChatMessage[] = [];
  let chars = system.length + b.content.length;
  for (const m of past) {
    if (chars + m.content.length > HISTORY_CHARS) break;
    chars += m.content.length;
    history.unshift({ role: m.role, content: m.content });
  }
  const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, { role: 'user', content: b.content }];
  const search = conv.mode === 'research' || Boolean(agent?.tools.includes('web_search'));

  const reservation = await reserveTurn({ userId: user.id, mode: conv.mode, row, promptChars: chars, userText: b.content, search });
  await pool.query(
    'INSERT INTO messages (conversation_id, role, content, model_id, generation_id) VALUES ($1, $2, $3, $4, $5)',
    [id, 'user', b.content, row.id, reservation.gen.id],
  );

  const send = sse(res);
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  send('meta', {
    model: { id: row.id, label: row.label, isFree: row.is_free, dataNote: row.data_note },
    reservedCredits: reservation.gen.held_credits, search,
  });

  const result = await executeTurn(reservation, messages, b.content, {
    signal: abort.signal,
    onSources: (s) => send('sources', s.map((x, i) => ({ n: i + 1, title: x.title, url: x.url }))),
    onDelta: (text) => send('delta', { text }),
  });

  let messageId: number | null = null;
  if (result.text) {
    const { rows: [m] } = await pool.query<{ id: number }>(
      `INSERT INTO messages (conversation_id, role, content, citations, model_id, generation_id) VALUES ($1,'assistant',$2,$3,$4,$5) RETURNING id`,
      [id, result.status === 'canceled' ? `${result.text}\n\n_(stopped)_` : result.text, JSON.stringify(result.citations), row.id, reservation.gen.id],
    );
    messageId = m!.id;
  }
  await pool.query(
    `UPDATE conversations SET updated_at = now(), model_id = COALESCE(model_id, $3),
       title = CASE WHEN $4 THEN $5 ELSE title END
     WHERE id = $1 AND user_id = $2`,
    [id, user.id, row.id, history.length === 0, b.content.replace(/\s+/g, ' ').slice(0, 60)],
  );
  if (result.status === 'failed') send('error', { message: result.error, credits: result.credits });
  else send('done', { messageId, credits: result.credits, citations: result.citations, warning: result.error, balance: await getBalance(user.id) });
  res.end();
});
