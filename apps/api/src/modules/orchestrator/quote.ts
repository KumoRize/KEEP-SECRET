import { config } from '../../config.js';
import { sha256, signPayload, verifyPayload } from '../../lib/crypto.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { getPlan } from '../billing/plans.js';
import { moderatePrompt } from '../providers/adapters/openai.js';
import type { GenerationParams, Modality } from '../providers/types.js';
import { detectIntent } from './intent.js';
import { normaliseParams, selectCandidates, type Candidate, type Strategy } from './router.js';

export interface QuotePayload {
  v: 1;
  uid: string;
  ph: string; // sha256(prompt)
  modality: Modality;
  params: GenerationParams;
  candidates: Candidate[];
  hold: number;
  exp: number;
}

export interface QuoteInput {
  prompt: string;
  modality?: Modality;
  params?: GenerationParams;
  strategy?: Strategy;
  preferredModelId?: string;
}

export interface QuoteResponse {
  quoteToken: string;
  modality: Modality;
  detected: { modality: Modality; confidence: number };
  params: GenerationParams;
  provider: { modelId: string; label: string };
  estimatedCredits: number;
  maxCredits: number;
  fallbacks: { modelId: string; label: string; credits: number }[];
  licenseNote: string;
  expiresAt: string;
}

export async function createQuote(user: { id: string; plan_id: string }, input: QuoteInput): Promise<QuoteResponse> {
  const prompt = input.prompt.trim();
  if (prompt.length < 3) throw badRequest('Prompt is too short');

  if (config.MODERATION_ENABLED) {
    const mod = await moderatePrompt(prompt).catch(() => ({ flagged: false, categories: [] as string[] }));
    if (mod.flagged) {
      throw new AppError(422, 'content_policy', 'This prompt violates our content policy', { categories: mod.categories });
    }
  }

  const plan = getPlan(user.plan_id);
  const detected = detectIntent(prompt);
  const modality = input.modality ?? detected.modality;
  // Explicit params win over values parsed from the prompt.
  const baseParams = modality === detected.modality ? detected.params : {};
  const params = normaliseParams(modality, { ...baseParams, ...input.params }, plan);
  const candidates = await selectCandidates({
    plan, modality, prompt, params, strategy: input.strategy, preferredModelId: input.preferredModelId,
  });
  const primary = candidates[0]!;
  // Hold enough to cover any fallback; the unused difference is refunded after generation.
  const hold = Math.max(...candidates.map((c) => c.credits));
  const exp = Math.floor(Date.now() / 1000) + config.QUOTE_TTL_SEC;
  const payload: QuotePayload = { v: 1, uid: user.id, ph: sha256(prompt), modality, params, candidates, hold, exp };

  return {
    quoteToken: signPayload(config.QUOTE_SECRET, payload),
    modality,
    detected: { modality: detected.modality, confidence: detected.confidence },
    params,
    provider: { modelId: primary.modelId, label: primary.label },
    estimatedCredits: primary.credits,
    maxCredits: hold,
    fallbacks: candidates.slice(1).map((c) => ({ modelId: c.modelId, label: c.label, credits: c.credits })),
    licenseNote: primary.licenseNote,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

export function verifyQuote(token: string, userId: string, prompt: string): QuotePayload {
  const q = verifyPayload<QuotePayload>(config.QUOTE_SECRET, token);
  if (!q || q.v !== 1) throw badRequest('Invalid quote');
  if (q.uid !== userId) throw badRequest('Quote belongs to another user');
  if (q.exp < Date.now() / 1000) throw new AppError(410, 'quote_expired', 'Quote expired, please re-estimate');
  if (q.ph !== sha256(prompt.trim())) throw badRequest('Prompt changed since the quote was issued');
  return q;
}
