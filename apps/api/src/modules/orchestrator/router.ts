import { config } from '../../config.js';
import { AppError, forbidden } from '../../lib/errors.js';
import type { Plan } from '../billing/plans.js';
import { breaker } from '../providers/circuitBreaker.js';
import { loadCatalog } from '../catalog/catalog.js';
import { configuredModels, providerSettings } from '../providers/registry.js';
import type { GenerationParams, Modality, ProviderModel } from '../providers/types.js';

export interface Candidate {
  modelId: string;
  providerId: string;
  label: string;
  credits: number;
  costUsd: number;
  licenseNote: string;
}

export type Strategy = 'best' | 'cheapest';

export const MAX_FALLBACKS = 3;

export function usdToCredits(usd: number): number {
  return Math.max(1, Math.ceil((usd * config.USD_INR * config.PRICE_MARKUP) / config.INR_PER_CREDIT_COST));
}

export function assertModalityAllowed(modality: Modality, plan: Plan): void {
  if (!plan.modalities.includes(modality)) {
    throw new AppError(403, 'plan_upgrade_required', `${modality} generation is not included in the ${plan.name} plan`, { modality });
  }
}

/** Applies plan defaults and limits to duration-based requests. Throws if the plan does not allow it. */
export function normaliseParams(modality: Modality, params: GenerationParams, plan: Plan): GenerationParams {
  assertModalityAllowed(modality, plan);
  const out = { ...params };
  if (modality === 'video') {
    out.durationSec = out.durationSec ?? Math.min(5, plan.maxVideoSeconds);
    if (out.durationSec > plan.maxVideoSeconds) {
      throw forbidden(`Your ${plan.name} plan allows videos up to ${plan.maxVideoSeconds}s`);
    }
  } else if (modality === 'music') {
    out.durationSec = out.durationSec ?? Math.min(30, plan.maxMusicSeconds);
    if (out.durationSec > plan.maxMusicSeconds) {
      throw forbidden(`Your ${plan.name} plan allows tracks up to ${plan.maxMusicSeconds}s`);
    }
  } else {
    delete out.durationSec;
  }
  if (out.durationSec !== undefined && out.durationSec < 1) throw forbidden('Duration must be at least 1 second');
  return out;
}

export async function selectCandidates(opts: {
  plan: Plan;
  modality: Modality;
  prompt: string;
  params: GenerationParams;
  strategy?: Strategy;
  preferredModelId?: string;
}): Promise<Candidate[]> {
  const { plan, modality, prompt, params } = opts;
  assertModalityAllowed(modality, plan);
  const [settings] = await Promise.all([providerSettings(), loadCatalog()]);
  const eligible = configuredModels().filter((m: ProviderModel) => {
    const s = settings.get(m.providerId);
    if (m.modality !== modality || s?.enabled === false || breaker.isOpen(m.providerId)) return false;
    // Paid plans grant commercial rights, so only route to models whose terms allow commercial use.
    if (plan.commercialUse && !m.license.commercialUse) return false;
    if (params.durationSec && m.maxDurationSec && params.durationSec > m.maxDurationSec) return false;
    return true;
  });
  if (eligible.length === 0) {
    throw new AppError(503, 'no_provider_available', `No ${modality} provider is available right now. Please try again later.`);
  }
  const priced = eligible.map((m) => {
    const costUsd = m.estimateCostUsd(prompt, params);
    return { m, costUsd, credits: m.free ? 0 : usdToCredits(costUsd), priority: settings.get(m.providerId)?.priority ?? 100 };
  });
  priced.sort((a, b) =>
    a.priority - b.priority ||
    (opts.strategy === 'cheapest' ? a.credits - b.credits || b.m.quality - a.m.quality : b.m.quality - a.m.quality || a.credits - b.credits),
  );
  if (opts.preferredModelId) {
    // Catalog ids are per model; routing ids may carry a '#modality' suffix (multi-category text models).
    const idx = priced.findIndex((p) => p.m.id === opts.preferredModelId || p.m.id.split('#')[0] === opts.preferredModelId);
    if (idx > 0) priced.unshift(...priced.splice(idx, 1));
  }
  return priced.slice(0, MAX_FALLBACKS).map(({ m, costUsd, credits }) => ({
    modelId: m.id, providerId: m.providerId, label: m.label, credits, costUsd, licenseNote: m.license.note,
  }));
}
