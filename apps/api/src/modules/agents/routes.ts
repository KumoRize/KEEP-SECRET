import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { AppError, notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { parse } from '../../middleware/validate.js';
import { completeOnce, resolveTextModel } from '../chat/engine.js';

export const agentRoutes = Router();
agentRoutes.use(requireAuth);

export const AGENT_TOOLS = ['web_search'] as const;

const agentBody = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).default(''),
  instructions: z.string().trim().min(10).max(8000),
  modelId: z.string().max(200).nullable().default(null),
  tools: z.array(z.enum(AGENT_TOOLS)).max(5).default([]),
  starterPrompts: z.array(z.string().trim().min(1).max(200)).max(6).default([]),
  visibility: z.enum(['private', 'public']).default('private'),
});

const COLUMNS = `id, owner_id, name, description, instructions, model_id, tools, starter_prompts, visibility, uses, created_at, updated_at`;

agentRoutes.get('/', async (req, res) => {
  const { rows } = await pool.query(`SELECT ${COLUMNS} FROM agents WHERE owner_id = $1 ORDER BY updated_at DESC`, [req.user!.id]);
  res.json({ items: rows });
});

/** Public gallery; instructions stay private to the creator. */
agentRoutes.get('/public', async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).optional() }), req.query);
  const { rows } = await pool.query(
    `SELECT a.id, a.name, a.description, a.tools, a.starter_prompts, a.uses, a.model_id, split_part(u.email, '@', 1) AS creator
       FROM agents a JOIN users u ON u.id = a.owner_id
      WHERE a.visibility = 'public' AND ($1::text IS NULL OR a.name ILIKE '%' || $1 || '%' OR a.description ILIKE '%' || $1 || '%')
      ORDER BY a.uses DESC, a.created_at DESC LIMIT 60`,
    [q.q ?? null],
  );
  res.json({ items: rows });
});

agentRoutes.post('/', async (req, res) => {
  const b = parse(agentBody, req.body);
  if (b.modelId) await resolveTextModel('agent', req.user!.plan_id, b.modelId);
  const { rows } = await pool.query(
    `INSERT INTO agents (owner_id, name, description, instructions, model_id, tools, starter_prompts, visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLUMNS}`,
    [req.user!.id, b.name, b.description, b.instructions, b.modelId, b.tools, b.starterPrompts, b.visibility],
  );
  res.status(201).json(rows[0]);
});

agentRoutes.put('/:id', async (req, res) => {
  const b = parse(agentBody, req.body);
  if (b.modelId) await resolveTextModel('agent', req.user!.plan_id, b.modelId);
  const { rows } = await pool.query(
    `UPDATE agents SET name = $3, description = $4, instructions = $5, model_id = $6, tools = $7, starter_prompts = $8,
            visibility = $9, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING ${COLUMNS}`,
    [parse(z.uuid(), req.params.id), req.user!.id, b.name, b.description, b.instructions, b.modelId, b.tools, b.starterPrompts, b.visibility],
  );
  if (!rows[0]) throw notFound('Agent not found');
  res.json(rows[0]);
});

agentRoutes.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM agents WHERE id = $1 AND owner_id = $2', [parse(z.uuid(), req.params.id), req.user!.id]);
  if (!rowCount) throw notFound('Agent not found');
  res.status(204).end();
});

const GENERATOR_SYSTEM = `You design AI agents. Given a short description, reply with ONLY a JSON object (no prose,
no code fences) matching AGENT_SPEC_JSON:
{"name": string (2-40 chars), "description": string (<=200 chars), "instructions": string (detailed system prompt:
role, goals, step-by-step method, output format, tone, what to refuse), "starterPrompts": string[] (3-4 example
user messages), "tools": string[] (subset of ["web_search"]; include it only if the agent needs current information)}`;

const draftSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(300).catch(''),
  instructions: z.string().trim().min(10).max(8000),
  starterPrompts: z.array(z.string().trim().min(1).max(200)).max(6).catch([]),
  tools: z.array(z.string()).catch([]).transform((t) => t.filter((x): x is (typeof AGENT_TOOLS)[number] => (AGENT_TOOLS as readonly string[]).includes(x))),
});

/** Agent generator: turns one sentence into a ready-to-save agent. Billed like one chat message. */
agentRoutes.post('/generate', rateLimit({ name: 'agent-gen', limit: 10, windowSec: 60 }), async (req, res) => {
  const { description } = parse(z.object({ description: z.string().trim().min(5).max(1000) }), req.body);
  const result = await completeOnce(req.user!.id, req.user!.plan_id, GENERATOR_SYSTEM, description);
  if (result.status !== 'succeeded') throw new AppError(502, 'generation_failed', result.error ?? 'Agent generation failed');
  const start = result.text.indexOf('{');
  const end = result.text.lastIndexOf('}');
  let draft: z.infer<typeof draftSchema>;
  try {
    draft = draftSchema.parse(JSON.parse(result.text.slice(start, end + 1)));
  } catch {
    throw new AppError(502, 'generation_failed', 'The model returned an invalid agent. Please try again.');
  }
  res.json({ draft, credits: result.credits });
});
