import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { parse } from '../../middleware/validate.js';
import { createQuote } from '../orchestrator/quote.js';
import { MODALITIES } from '../providers/types.js';
import { storage } from '../storage/storage.js';
import { cancelGeneration, createGeneration, getGeneration, type GenerationRow } from './service.js';

export const generationRoutes = Router();
generationRoutes.use(requireAuth);

const prompt = z.string().trim().min(3).max(4000);
const estimateSchema = z.object({
  prompt,
  modality: z.enum(MODALITIES).optional(),
  params: z.object({
    durationSec: z.number().int().min(1).max(600).optional(),
    aspectRatio: z.enum(['1:1', '16:9', '9:16', '4:3', '3:4']).optional(),
  }).optional(),
  strategy: z.enum(['best', 'cheapest']).optional(),
  preferredModelId: z.string().max(200).optional(),
});

generationRoutes.post('/estimate', rateLimit({ name: 'estimate', limit: 60, windowSec: 60 }), async (req, res) => {
  res.json(await createQuote(req.user!, parse(estimateSchema, req.body)));
});

export function serializeGeneration(g: GenerationRow, assets: { id: string; filename: string; content_type: string; size_bytes: number; url: string; previewUrl: string }[] = []) {
  return {
    id: g.id,
    projectId: g.project_id,
    prompt: g.prompt,
    modality: g.modality,
    params: g.params,
    status: g.status,
    heldCredits: g.held_credits,
    chargedCredits: g.charged_credits,
    provider: g.provider_id,
    model: g.model,
    licenseNote: g.license_note,
    error: g.error,
    createdAt: g.created_at,
    finishedAt: g.finished_at,
    assets,
  };
}

export async function assetsFor(generationIds: string[]) {
  if (generationIds.length === 0) return new Map<string, Awaited<ReturnType<typeof withUrls>>>();
  const { rows } = await pool.query<{ id: string; generation_id: string; storage_key: string; filename: string; content_type: string; size_bytes: number }>(
    'SELECT id, generation_id, storage_key, filename, content_type, size_bytes FROM assets WHERE generation_id = ANY($1) ORDER BY created_at',
    [generationIds],
  );
  const map = new Map<string, Awaited<ReturnType<typeof withUrls>>>();
  for (const id of generationIds) map.set(id, await withUrls(rows.filter((r) => r.generation_id === id)));
  return map;
}

async function withUrls(rows: { id: string; storage_key: string; filename: string; content_type: string; size_bytes: number }[]) {
  return Promise.all(rows.map(async (a) => ({
    id: a.id, filename: a.filename, content_type: a.content_type, size_bytes: a.size_bytes,
    url: await storage.url(a.storage_key, { filename: a.filename, contentType: a.content_type, inline: false }),
    previewUrl: await storage.url(a.storage_key, { filename: a.filename, contentType: a.content_type, inline: true }),
  })));
}

generationRoutes.post('/', rateLimit({ name: 'generate', limit: 20, windowSec: 60 }), async (req, res) => {
  const body = parse(z.object({ prompt, quoteToken: z.string().min(10).max(8000), projectId: z.uuid().optional() }), req.body);
  const key = req.header('idempotency-key');
  if (!key || key.length > 100) throw badRequest('Idempotency-Key header (max 100 chars) is required');
  const { generation, created } = await createGeneration(req.user!.id, body, key);
  res.status(created ? 202 : 200).json(serializeGeneration(generation));
});

generationRoutes.get('/', async (req, res) => {
  const q = parse(z.object({
    projectId: z.uuid().optional(),
    modality: z.enum(MODALITIES).optional(),
    before: z.iso.datetime().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }), req.query);
  const { rows } = await pool.query<GenerationRow>(
    `SELECT * FROM generations WHERE user_id = $1
       AND ($2::uuid IS NULL OR project_id = $2) AND ($3::text IS NULL OR modality = $3)
       AND ($4::timestamptz IS NULL OR created_at < $4)
     ORDER BY created_at DESC LIMIT $5`,
    [req.user!.id, q.projectId ?? null, q.modality ?? null, q.before ?? null, q.limit],
  );
  const assets = await assetsFor(rows.map((r) => r.id));
  res.json({ items: rows.map((g) => serializeGeneration(g, assets.get(g.id))) });
});

generationRoutes.get('/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const g = await getGeneration(req.user!.id, id);
  const assets = await assetsFor([g.id]);
  res.json(serializeGeneration(g, assets.get(g.id)));
});

generationRoutes.post('/:id/cancel', async (req, res) => {
  const g = await cancelGeneration(req.user!.id, parse(z.uuid(), req.params.id));
  res.json(serializeGeneration(g));
});
