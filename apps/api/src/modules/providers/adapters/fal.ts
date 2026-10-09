import { config } from '../../../config.js';
import { cachedCatalog, snapDuration, type CatalogRow } from '../../catalog/catalog.js';
import { downloadBinary, providerFetch } from '../http.js';
import type { GenerationRequest, Modality, PollResult, ProviderAdapter, ProviderModel } from '../types.js';
import { ProviderError } from '../types.js';

/**
 * fal.ai queue API: submit returns ready-made status/response URLs, which we store and use
 * verbatim (they differ from the submit path for some model variants). Models come from the catalog.
 */
const headers = () => ({ Authorization: `Key ${config.FAL_KEY}`, 'Content-Type': 'application/json' });
const MEDIA: Modality[] = ['image', 'video', '3d', 'music'];
const SIZES: Record<string, string> = { '1:1': 'square_hd', '16:9': 'landscape_16_9', '9:16': 'portrait_16_9', '4:3': 'landscape_4_3', '3:4': 'portrait_4_3' };
const EXT: Record<string, string> = { image: 'png', video: 'mp4', '3d': 'glb', music: 'mp3' };

export function catalogToModel(row: CatalogRow, modality: Modality): ProviderModel {
  const p = row.pricing;
  return {
    id: row.id, providerId: row.provider_id, model: row.model, modality, label: row.label, quality: row.quality,
    maxDurationSec: row.max_duration_sec ?? undefined, async: true,
    license: { commercialUse: row.commercial_use, note: row.license_note },
    estimateCostUsd: (_prompt, params) => {
      if (p.perImage !== undefined) return p.perImage;
      if (p.perSecond !== undefined) return p.perSecond * snapDuration(params.durationSec ?? 5, row.input_options.allowedDurations);
      return p.perRun ?? 0;
    },
  };
}

export function falInput(row: CatalogRow, req: GenerationRequest): Record<string, unknown> {
  const o = row.input_options;
  const input: Record<string, unknown> = { prompt: req.prompt, ...(o.extra ?? {}) };
  const ar = req.params.aspectRatio;
  if (req.modality === 'image') {
    if (ar) input[o.sizeParam ?? 'image_size'] = (o.sizeParam ?? 'image_size') === 'image_size' ? SIZES[ar] : ar;
  } else if (req.modality === 'video') {
    const d = snapDuration(req.params.durationSec ?? 5, o.allowedDurations);
    input.duration = o.durationFormat === 'suffix_s' ? `${d}s` : o.durationFormat === 'string' ? String(d) : d;
    if (ar) input.aspect_ratio = ar;
  } else if (req.params.durationSec) {
    input.duration = req.params.durationSec;
  }
  return input;
}

function firstMediaUrl(v: unknown): string | undefined {
  if (typeof v === 'string') return /^https:\/\//.test(v) ? v : undefined;
  if (Array.isArray(v)) return v.map(firstMediaUrl).find(Boolean);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    // Prefer the conventional shapes: { images: [{url}] }, { video: {url} }, { audio: {url} }, { url }.
    for (const k of ['images', 'image', 'video', 'audio', 'model_mesh', 'url']) {
      const hit = firstMediaUrl(o[k]);
      if (hit) return hit;
    }
    return Object.values(o).map(firstMediaUrl).find(Boolean);
  }
  return undefined;
}

const rowFor = (id: string) => cachedCatalog().find((r) => r.id === id && r.provider_id === 'fal');

export const falAdapter: ProviderAdapter = {
  id: 'fal',
  name: 'fal.ai',
  isConfigured: () => Boolean(config.FAL_KEY),
  models: () => cachedCatalog()
    .filter((r) => r.provider_id === 'fal' && r.enabled)
    .flatMap((r) => r.categories.filter((c) => MEDIA.includes(c as Modality)).map((c) => catalogToModel(r, c as Modality))),
  async submit(model, req, signal) {
    const row = rowFor(model.id);
    if (!row) throw new ProviderError(`fal: ${model.id} no longer in catalog`, 'unavailable');
    const res = await providerFetch('fal', `https://queue.fal.run/${row.model}`, {
      method: 'POST', headers: headers(), signal, body: JSON.stringify(falInput(row, req)),
    });
    const json = (await res.json()) as { request_id?: string; status_url?: string; response_url?: string };
    if (!json.request_id || !json.status_url || !json.response_url) throw new ProviderError('fal: incomplete submit response', 'retriable');
    if (!json.status_url.startsWith('https://') || !json.response_url.startsWith('https://')) throw new ProviderError('fal: bad queue URLs', 'retriable');
    return { externalId: JSON.stringify({ s: json.status_url, r: json.response_url }) };
  },
  async poll(model, externalId, req, signal): Promise<PollResult> {
    const { s, r } = JSON.parse(externalId) as { s: string; r: string };
    const status = (await (await providerFetch('fal', s, { headers: headers(), signal })).json()) as { status?: string; error?: string };
    if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return { status: 'pending' };
    if (status.status !== 'COMPLETED') throw new ProviderError(`fal: ${status.status ?? 'unknown status'} ${status.error ?? ''}`.trim(), 'retriable');
    let result: unknown;
    try {
      result = await (await providerFetch('fal', r, { headers: headers(), signal })).json();
    } catch (err) {
      // fal returns 422 for inputs its own safety checker or validator rejects.
      if (err instanceof ProviderError && err.status === 422) throw new ProviderError(`fal: request rejected: ${err.message}`, 'rejected');
      throw err;
    }
    if ((result as { has_nsfw_concepts?: boolean[] })?.has_nsfw_concepts?.some(Boolean)) {
      throw new ProviderError('fal: output blocked by safety checker', 'rejected');
    }
    const url = firstMediaUrl(result);
    if (!url) throw new ProviderError('fal: no media URL in result', 'retriable');
    const { data, contentType } = await downloadBinary('fal', url, signal);
    return { status: 'done', result: { files: [{ filename: `output.${EXT[model.modality] ?? 'bin'}`, contentType, data }] } };
  },
};
