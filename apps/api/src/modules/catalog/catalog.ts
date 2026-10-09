import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

export const CATEGORIES = ['image', 'video', '3d', 'music', 'website', 'app', 'game', 'chat', 'story', 'code', 'research'] as const;
export type Category = (typeof CATEGORIES)[number];
export const TEXT_CATEGORIES: Category[] = ['chat', 'story', 'code', 'research'];

export interface Pricing {
  inputPerMTok?: number;
  outputPerMTok?: number;
  perImage?: number;
  perSecond?: number;
  perRun?: number;
}

export interface InputOptions {
  /** fal image models: 'image_size' (flux family) or 'aspect_ratio'. */
  sizeParam?: 'image_size' | 'aspect_ratio';
  /** How the model wants duration: 5 | "5" | "5s". */
  durationFormat?: 'number' | 'string' | 'suffix_s';
  allowedDurations?: number[];
  /** Fixed extra input merged into every request, e.g. {"generate_audio": false}. */
  extra?: Record<string, unknown>;
}

export interface CatalogRow {
  id: string;
  provider_id: string;
  model: string;
  categories: Category[];
  label: string;
  description: string;
  tags: string[];
  is_free: boolean;
  enabled: boolean;
  featured: boolean;
  quality: number;
  pricing: Pricing;
  input_options: InputOptions;
  context_length: number | null;
  max_duration_sec: number | null;
  commercial_use: boolean;
  license_note: string;
  data_note: string;
  source: 'default' | 'sync' | 'manual';
}

const CACHE_MS = 30_000;
let cache: { at: number; rows: CatalogRow[] } | null = null;
let inflight: Promise<CatalogRow[]> | null = null;

/** DB-backed catalog rows (OpenRouter, fal, ...), cached briefly. Call before sync reads. */
export async function loadCatalog(force = false): Promise<CatalogRow[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  inflight ??= pool.query<CatalogRow>('SELECT * FROM catalog_models ORDER BY featured DESC, quality DESC, label')
    .then((r) => {
      cache = { at: Date.now(), rows: r.rows };
      return r.rows;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Last loaded rows, for synchronous callers (registry). Empty until the first load. */
export const cachedCatalog = (): CatalogRow[] => cache?.rows ?? [];

export function invalidateCatalog(): void {
  cache = null;
}

/** Snap a requested duration to what the model accepts: the largest allowed value not above it, else the smallest. */
export function snapDuration(requested: number, allowed?: number[]): number {
  if (!allowed?.length) return requested;
  const sorted = [...allowed].sort((a, b) => a - b);
  return [...sorted].reverse().find((d) => d <= requested) ?? sorted[0]!;
}

/**
 * Curated media defaults on fal.ai. IDs and duration rules were checked against fal's model pages
 * (Oct 2026); prices are conservative planning numbers. Verify both on fal.ai before launch and
 * edit them in Admin > Models. Inserted only if absent, so admin edits are never overwritten.
 */
const FAL_DEFAULTS: Omit<CatalogRow, 'enabled' | 'source' | 'context_length'>[] = [
  {
    id: 'fal:fal-ai/flux/schnell', provider_id: 'fal', model: 'fal-ai/flux/schnell', categories: ['image'],
    label: 'FLUX.1 [schnell]', description: 'Very fast, low-cost images. Great for drafts and ideation.',
    tags: ['fast', 'budget'], is_free: false, featured: true, quality: 6, pricing: { perImage: 0.003 },
    input_options: { sizeParam: 'image_size' }, max_duration_sec: null, commercial_use: true,
    license_note: 'FLUX.1 [schnell] via fal.ai; check fal and Black Forest Labs terms.', data_note: '',
  },
  {
    id: 'fal:fal-ai/flux/dev', provider_id: 'fal', model: 'fal-ai/flux/dev', categories: ['image'],
    label: 'FLUX.1 [dev]', description: 'High-quality, detailed images with strong prompt following.',
    tags: ['quality'], is_free: false, featured: true, quality: 8, pricing: { perImage: 0.025 },
    input_options: { sizeParam: 'image_size' }, max_duration_sec: null, commercial_use: true,
    license_note: 'FLUX.1 [dev] outputs via fal.ai; fal states commercial use is permitted through its API. Verify current terms.', data_note: '',
  },
  {
    id: 'fal:fal-ai/flux-pro/v1.1', provider_id: 'fal', model: 'fal-ai/flux-pro/v1.1', categories: ['image'],
    label: 'FLUX 1.1 [pro]', description: 'Premium photoreal and design-grade images.',
    tags: ['premium', 'photoreal'], is_free: false, featured: true, quality: 9, pricing: { perImage: 0.04 },
    input_options: { sizeParam: 'image_size' }, max_duration_sec: null, commercial_use: true,
    license_note: 'FLUX Pro via fal.ai; commercial use per fal / BFL terms.', data_note: '',
  },
  {
    id: 'fal:fal-ai/kling-video/v2.1/master/text-to-video', provider_id: 'fal', model: 'fal-ai/kling-video/v2.1/master/text-to-video',
    categories: ['video'], label: 'Kling 2.1 Master', description: 'Cinematic text-to-video with smooth motion.',
    tags: ['cinematic'], is_free: false, featured: true, quality: 8, pricing: { perSecond: 0.28 },
    input_options: { durationFormat: 'string', allowedDurations: [5, 10] }, max_duration_sec: 10, commercial_use: true,
    license_note: 'Kling via fal.ai; commercial use per fal / Kuaishou terms.', data_note: '',
  },
  {
    id: 'fal:fal-ai/veo3.1/fast', provider_id: 'fal', model: 'fal-ai/veo3.1/fast', categories: ['video'],
    label: 'Veo 3.1 Fast', description: "Google's Veo with native audio, faster and cheaper.",
    tags: ['audio', 'google'], is_free: false, featured: true, quality: 9, pricing: { perSecond: 0.15 },
    input_options: { durationFormat: 'suffix_s', allowedDurations: [4, 6, 8] }, max_duration_sec: 8, commercial_use: true,
    license_note: 'Veo via fal.ai; commercial use per fal / Google terms.', data_note: '',
  },
  {
    id: 'fal:fal-ai/veo3.1', provider_id: 'fal', model: 'fal-ai/veo3.1', categories: ['video'],
    label: 'Veo 3.1', description: "Google's top video model with native audio.",
    tags: ['audio', 'premium', 'google'], is_free: false, featured: false, quality: 10, pricing: { perSecond: 0.4 },
    input_options: { durationFormat: 'suffix_s', allowedDurations: [4, 6, 8] }, max_duration_sec: 8, commercial_use: true,
    license_note: 'Veo via fal.ai; commercial use per fal / Google terms.', data_note: '',
  },
];

export async function seedDefaultCatalog(): Promise<number> {
  let inserted = 0;
  for (const r of FAL_DEFAULTS) {
    const res = await pool.query(
      `INSERT INTO catalog_models (id, provider_id, model, categories, label, description, tags, is_free, featured, quality,
                                   pricing, input_options, max_duration_sec, commercial_use, license_note, data_note, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'default') ON CONFLICT (id) DO NOTHING`,
      [r.id, r.provider_id, r.model, r.categories, r.label, r.description, r.tags, r.is_free, r.featured, r.quality,
        r.pricing, r.input_options, r.max_duration_sec, r.commercial_use, r.license_note, r.data_note],
    );
    inserted += res.rowCount ?? 0;
  }
  if (inserted) invalidateCatalog();
  return inserted;
}

// ---- OpenRouter sync -------------------------------------------------------------------------

interface OpenRouterModel {
  id: string;
  name?: string;
  description?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}

// Families shown first in the explorer. Matching is by id prefix, so new versions are picked up.
const FEATURED_PREFIXES = ['anthropic/claude', 'openai/gpt', 'google/gemini', 'deepseek/', 'meta-llama/', 'qwen/', 'mistralai/', 'x-ai/grok', 'moonshotai/'];
const FREE_DATA_NOTE = 'Free model: the hosting provider may log or train on prompts. Avoid sharing private information.';

/** Maps one OpenRouter /models entry to a catalog row, or null if it is not a text-output model. */
export function mapOpenRouterModel(m: OpenRouterModel): Omit<CatalogRow, 'enabled'> | null {
  const out = m.architecture?.output_modalities ?? ['text'];
  if (!out.includes('text') || out.some((o) => o !== 'text')) return null;
  const inPrice = Number(m.pricing?.prompt ?? NaN);
  const outPrice = Number(m.pricing?.completion ?? NaN);
  if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice) || inPrice < 0 || outPrice < 0) return null;
  const isFree = m.id.endsWith(':free') || (inPrice === 0 && outPrice === 0);
  const ctx = m.context_length ?? null;
  const categories: Category[] = ['chat', 'story', 'code', 'research'];
  // Whole websites/apps/games need room for long single-file outputs.
  if ((ctx ?? 0) >= 32_000) categories.push('website', 'app', 'game');
  const featured = !isFree && FEATURED_PREFIXES.some((p) => m.id.startsWith(p));
  return {
    id: `openrouter:${m.id}`, provider_id: 'openrouter', model: m.id, categories,
    label: (m.name ?? m.id).replace(/\s*\(free\)\s*$/i, ''), description: (m.description ?? '').slice(0, 400),
    tags: isFree ? ['free'] : [], is_free: isFree, featured, quality: featured ? 8 : 5,
    pricing: { inputPerMTok: inPrice * 1e6, outputPerMTok: outPrice * 1e6 }, input_options: {},
    context_length: ctx, max_duration_sec: null, commercial_use: true,
    license_note: 'Via OpenRouter; output use is governed by the underlying model provider\'s terms.',
    data_note: isFree ? FREE_DATA_NOTE : '', source: 'sync',
  };
}

/**
 * Pulls OpenRouter's model list and upserts it. Prices and context are refreshed on every sync;
 * admin choices (enabled, featured, quality, label, categories) on existing rows are kept.
 */
export async function syncOpenRouter(fetchImpl: typeof fetch = fetch): Promise<{ upserted: number; skipped: number }> {
  if (!config.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  const res = await fetchImpl('https://openrouter.ai/api/v1/models', {
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`OpenRouter models: HTTP ${res.status}`);
  const { data } = (await res.json()) as { data?: OpenRouterModel[] };
  let upserted = 0;
  let skipped = 0;
  for (const m of data ?? []) {
    const row = mapOpenRouterModel(m);
    if (!row) { skipped++; continue; }
    await pool.query(
      `INSERT INTO catalog_models (id, provider_id, model, categories, label, description, tags, is_free, featured, quality,
                                   pricing, input_options, context_length, commercial_use, license_note, data_note, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'{}',$12,$13,$14,$15,'sync')
       ON CONFLICT (id) DO UPDATE SET pricing = EXCLUDED.pricing, context_length = EXCLUDED.context_length,
         is_free = EXCLUDED.is_free, data_note = EXCLUDED.data_note, description = EXCLUDED.description, updated_at = now()`,
      [row.id, row.provider_id, row.model, row.categories, row.label, row.description, row.tags, row.is_free, row.featured,
        row.quality, row.pricing, row.context_length, row.commercial_use, row.license_note, row.data_note],
    );
    upserted++;
  }
  invalidateCatalog();
  logger.info({ upserted, skipped }, 'openrouter catalog sync');
  return { upserted, skipped };
}
