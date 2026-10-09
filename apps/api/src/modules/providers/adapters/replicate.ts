import { config } from '../../../config.js';
import { downloadBinary, providerFetch } from '../http.js';
import type { GenerationRequest, Modality, PollResult, ProviderAdapter, ProviderModel } from '../types.js';
import { ProviderError } from '../types.js';

/**
 * Replicate hosts many third-party models, each with its own input schema, price and licence.
 * Model refs come from env (`owner/name` for official models or `owner/name:version`).
 * Prices below are conservative planning numbers; verify each model's page before launch.
 */
interface Slot {
  modality: Modality;
  ref: () => string | undefined;
  quality: number;
  maxDurationSec?: number;
  estimate: (durationSec: number) => number;
  input: (req: GenerationRequest) => Record<string, unknown>;
  ext: string;
}

const SLOTS: Slot[] = [
  {
    modality: 'video', ref: () => config.REPLICATE_VIDEO_MODEL, quality: 8, maxDurationSec: 10,
    estimate: (d) => 0.12 * d,
    input: (r) => ({ prompt: r.prompt, duration: r.params.durationSec ?? 5, aspect_ratio: r.params.aspectRatio ?? '16:9' }),
    ext: 'mp4',
  },
  {
    modality: '3d', ref: () => config.REPLICATE_3D_MODEL, quality: 7,
    estimate: () => 0.1,
    input: (r) => ({ prompt: r.prompt }),
    ext: 'glb',
  },
  {
    modality: 'music', ref: () => config.REPLICATE_MUSIC_MODEL, quality: 6, maxDurationSec: 300,
    estimate: (d) => 0.004 * d + 0.02,
    input: (r) => ({ prompt: r.prompt, duration: r.params.durationSec ?? 30 }),
    ext: 'mp3',
  },
];

const BASE = 'https://api.replicate.com/v1';
const headers = () => ({ Authorization: `Bearer ${config.REPLICATE_API_TOKEN}`, 'Content-Type': 'application/json' });

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string | null;
}

function slotModels(): ProviderModel[] {
  return SLOTS.flatMap((s) => {
    const ref = s.ref();
    if (!ref) return [];
    return [{
      id: `replicate:${ref}`,
      providerId: 'replicate',
      model: ref,
      modality: s.modality,
      label: `Replicate ${ref.split(':')[0]}`,
      quality: s.quality,
      maxDurationSec: s.maxDurationSec,
      async: true,
      license: {
        commercialUse: config.REPLICATE_COMMERCIAL_LICENSE_CONFIRMED,
        note: `Governed by the licence of ${ref} on Replicate; review before commercial use.`,
      },
      estimateCostUsd: (_p, params) => s.estimate(params.durationSec ?? s.maxDurationSec ?? 1),
    }];
  });
}

function firstUrl(output: unknown): string | undefined {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(firstUrl).find(Boolean);
  if (output && typeof output === 'object') return Object.values(output).map(firstUrl).find(Boolean);
  return undefined;
}

export const replicateAdapter: ProviderAdapter = {
  id: 'replicate',
  name: 'Replicate',
  isConfigured: () => Boolean(config.REPLICATE_API_TOKEN),
  models: slotModels,
  async submit(model, req, signal) {
    const slot = SLOTS.find((s) => s.modality === model.modality)!;
    const [name, version] = model.model.split(':');
    const url = version ? `${BASE}/predictions` : `${BASE}/models/${name}/predictions`;
    const body = version ? { version, input: slot.input(req) } : { input: slot.input(req) };
    const pred = (await (await providerFetch('replicate', url, {
      method: 'POST', headers: headers(), signal, body: JSON.stringify(body),
    })).json()) as Prediction;
    if (!pred.id) throw new ProviderError('replicate: no prediction id', 'retriable');
    return { externalId: pred.id };
  },
  async poll(model, externalId, _req, signal): Promise<PollResult> {
    const pred = (await (await providerFetch('replicate', `${BASE}/predictions/${encodeURIComponent(externalId)}`, {
      headers: headers(), signal,
    })).json()) as Prediction;
    if (pred.status === 'starting' || pred.status === 'processing') return { status: 'pending' };
    if (pred.status !== 'succeeded') {
      const msg = pred.error ?? pred.status;
      // Replicate reports safety-checker blocks as failed predictions with an NSFW/sensitive message.
      const kind = /nsfw|sensitive|safety|flagged/i.test(msg) ? 'rejected' : 'retriable';
      throw new ProviderError(`replicate: ${msg}`.slice(0, 300), kind);
    }
    const slot = SLOTS.find((s) => s.modality === model.modality)!;
    const out = firstUrl(pred.output);
    if (!out) throw new ProviderError('replicate: no output URL', 'retriable');
    const { data, contentType } = await downloadBinary('replicate', out, signal);
    return { status: 'done', result: { files: [{ filename: `output.${slot.ext}`, contentType, data }] } };
  },
};
