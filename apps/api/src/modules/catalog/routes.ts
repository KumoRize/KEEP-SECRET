import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { usdToCredits } from '../orchestrator/router.js';
import { breaker } from '../providers/circuitBreaker.js';
import { configuredModels, getAdapter, providerSettings } from '../providers/registry.js';
import { textModels } from '../text/providers.js';
import { CATEGORIES, invalidateCatalog, loadCatalog, syncOpenRouter, type Category, type CatalogRow } from './catalog.js';

export interface PublicModel {
  id: string;
  provider: string;
  label: string;
  description: string;
  categories: Category[];
  tags: string[];
  isFree: boolean;
  featured: boolean;
  quality: number;
  contextLength: number | null;
  maxDurationSec: number | null;
  /** Human-readable price: "Free", "~12 credits / image", "~40 credits / second", "~3 credits / reply". */
  priceHint: string;
  creditsPerUnit: number;
  unit: 'image' | 'second' | 'reply' | 'run';
  commercialUse: boolean;
  licenseNote: string;
  dataNote: string;
}

// A "reply" is ~1,000 words out (1,333 tokens) for ~500 tokens in: the unit people understand.
function price(p: CatalogRow['pricing'], isFree: boolean): Pick<PublicModel, 'priceHint' | 'creditsPerUnit' | 'unit'> {
  if (isFree) return { priceHint: 'Free', creditsPerUnit: 0, unit: 'reply' };
  if (p.perImage !== undefined) { const c = usdToCredits(p.perImage); return { priceHint: `~${c} credits / image`, creditsPerUnit: c, unit: 'image' }; }
  if (p.perSecond !== undefined) { const c = usdToCredits(p.perSecond); return { priceHint: `~${c} credits / second`, creditsPerUnit: c, unit: 'second' }; }
  if (p.inputPerMTok !== undefined || p.outputPerMTok !== undefined) {
    const usd = (500 * (p.inputPerMTok ?? 0) + 1333 * (p.outputPerMTok ?? 0)) / 1e6;
    const c = usd > 0 ? usdToCredits(usd) : 0;
    return { priceHint: c ? `~${c} credits / reply` : 'Free', creditsPerUnit: c, unit: 'reply' };
  }
  const c = usdToCredits(p.perRun ?? 0);
  return { priceHint: `~${c} credits / run`, creditsPerUnit: c, unit: 'run' };
}

const toPublic = (r: CatalogRow): PublicModel => ({
  id: r.id, provider: r.provider_id, label: r.label, description: r.description, categories: r.categories, tags: r.tags,
  isFree: r.is_free, featured: r.featured, quality: r.quality, contextLength: r.context_length, maxDurationSec: r.max_duration_sec,
  ...price(r.pricing, r.is_free), commercialUse: r.commercial_use, licenseNote: r.license_note, dataNote: r.data_note,
});

/** Everything a user can actually run right now: catalog rows with a configured provider, plus built-ins. */
export async function availableModels(): Promise<PublicModel[]> {
  const [catalog, settings] = await Promise.all([loadCatalog(), providerSettings()]);
  const out = new Map<string, PublicModel>();
  for (const r of textModels()) out.set(r.id, toPublic(r));
  for (const r of catalog) {
    if (!r.enabled || out.has(r.id) || !getAdapter(r.provider_id)?.isConfigured()) continue;
    out.set(r.id, toPublic(r));
  }
  // Built-in media models (OpenAI images, Stability, Replicate, ElevenLabs, mock) from adapters.
  for (const m of configuredModels()) {
    const baseId = m.id.split('#')[0]!;
    if (out.has(baseId) || settings.get(m.providerId)?.enabled === false || breaker.isOpen(m.providerId)) continue;
    const usd = m.estimateCostUsd('', { durationSec: m.modality === 'video' || m.modality === 'music' ? 1 : undefined });
    const unit = m.modality === 'video' || m.modality === 'music' ? 'second' : m.modality === 'image' ? 'image' : 'run';
    const c = m.free ? 0 : usdToCredits(usd);
    out.set(baseId, {
      id: baseId, provider: m.providerId, label: m.label, description: '', categories: [m.modality], tags: [], isFree: Boolean(m.free),
      featured: false, quality: m.quality, contextLength: null, maxDurationSec: m.maxDurationSec ?? null,
      priceHint: c ? `~${c} credits / ${unit}` : 'Free', creditsPerUnit: c, unit, commercialUse: m.license.commercialUse,
      licenseNote: m.license.note, dataNote: '',
    });
  }
  return [...out.values()].filter((m) => settings.get(m.provider)?.enabled !== false)
    .sort((a, b) => Number(b.featured) - Number(a.featured) || b.quality - a.quality || a.label.localeCompare(b.label));
}

export const catalogRoutes = Router();

/** Public (no auth) so the marketing site can show the model universe. */
catalogRoutes.get('/models', async (req, res) => {
  const q = parse(z.object({
    category: z.enum(CATEGORIES).optional(),
    free: z.enum(['true', 'false']).optional(),
    q: z.string().max(100).optional(),
  }), req.query);
  let items = await availableModels();
  if (q.category) items = items.filter((m) => m.categories.includes(q.category!));
  if (q.free) items = items.filter((m) => m.isFree === (q.free === 'true'));
  if (q.q) {
    const needle = q.q.toLowerCase();
    items = items.filter((m) => `${m.label} ${m.id} ${m.description} ${m.tags.join(' ')}`.toLowerCase().includes(needle));
  }
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const m of await availableModels()) for (const c of m.categories) counts[c] = (counts[c] ?? 0) + 1;
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ items, counts, total: items.length });
});

// ---- Admin -----------------------------------------------------------------------------------

export const adminCatalogRoutes = Router();
adminCatalogRoutes.use(requireAuth, requireAdmin);

adminCatalogRoutes.get('/', async (_req, res) => {
  res.json({ items: await loadCatalog(true) });
});

const pricingSchema = z.object({
  inputPerMTok: z.number().min(0).optional(), outputPerMTok: z.number().min(0).optional(),
  perImage: z.number().min(0).optional(), perSecond: z.number().min(0).optional(), perRun: z.number().min(0).optional(),
}).refine((p) => Object.keys(p).length > 0, 'At least one price is required');

const rowSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9-]{2,30}$/),
  model: z.string().trim().min(2).max(200),
  categories: z.array(z.enum(CATEGORIES)).min(1),
  label: z.string().trim().min(2).max(120),
  description: z.string().max(400).default(''),
  tags: z.array(z.string().max(30)).max(10).default([]),
  isFree: z.boolean().default(false),
  enabled: z.boolean().default(true),
  featured: z.boolean().default(false),
  quality: z.number().int().min(1).max(10).default(5),
  pricing: pricingSchema,
  inputOptions: z.object({
    sizeParam: z.enum(['image_size', 'aspect_ratio']).optional(),
    durationFormat: z.enum(['number', 'string', 'suffix_s']).optional(),
    allowedDurations: z.array(z.number().int().min(1).max(600)).max(20).optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  }).default({}),
  contextLength: z.number().int().positive().nullable().default(null),
  maxDurationSec: z.number().int().positive().nullable().default(null),
  commercialUse: z.boolean().default(true),
  licenseNote: z.string().max(400).default(''),
  dataNote: z.string().max(400).default(''),
});

adminCatalogRoutes.post('/', async (req, res) => {
  const b = parse(rowSchema, req.body);
  const id = `${b.providerId}:${b.model}`;
  const { rowCount } = await pool.query(
    `INSERT INTO catalog_models (id, provider_id, model, categories, label, description, tags, is_free, enabled, featured, quality, pricing,
       input_options, context_length, max_duration_sec, commercial_use, license_note, data_note, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'manual') ON CONFLICT (id) DO NOTHING`,
    [id, b.providerId, b.model, b.categories, b.label, b.description, b.tags, b.isFree, b.enabled, b.featured, b.quality, b.pricing,
      b.inputOptions, b.contextLength, b.maxDurationSec, b.commercialUse, b.licenseNote, b.dataNote],
  );
  if (!rowCount) throw badRequest('A model with this provider and id already exists');
  invalidateCatalog();
  res.status(201).json({ id });
});

adminCatalogRoutes.patch('/:id', async (req, res) => {
  const id = parse(z.string().max(260), req.params.id);
  const b = parse(rowSchema.partial().omit({ providerId: true, model: true }), req.body);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const map: Record<string, string> = {
    categories: 'categories', label: 'label', description: 'description', tags: 'tags', isFree: 'is_free', enabled: 'enabled',
    featured: 'featured', quality: 'quality', pricing: 'pricing', inputOptions: 'input_options', contextLength: 'context_length',
    maxDurationSec: 'max_duration_sec', commercialUse: 'commercial_use', licenseNote: 'license_note', dataNote: 'data_note',
  };
  for (const [k, col] of Object.entries(map)) {
    const v = (b as Record<string, unknown>)[k];
    if (v !== undefined) { vals.push(v); sets.push(`${col} = $${vals.length}`); }
  }
  if (!sets.length) throw badRequest('Nothing to update');
  const { rowCount } = await pool.query(`UPDATE catalog_models SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
  if (!rowCount) throw notFound('Model not found');
  invalidateCatalog();
  res.json({ ok: true });
});

adminCatalogRoutes.delete('/:id', async (req, res) => {
  const { rowCount } = await pool.query(`DELETE FROM catalog_models WHERE id = $1`, [parse(z.string().max(260), req.params.id)]);
  if (!rowCount) throw notFound('Model not found');
  invalidateCatalog();
  res.status(204).end();
});

adminCatalogRoutes.post('/sync/openrouter', async (_req, res) => {
  const result = await syncOpenRouter().catch((err: Error) => {
    throw new AppError(502, 'sync_failed', `OpenRouter sync failed: ${err.message}`);
  });
  res.json(result);
});
