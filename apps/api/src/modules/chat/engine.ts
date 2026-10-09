import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { tx } from '../../db/pool.js';
import { AppError, insufficientCredits, limitExceeded } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { verificationEnforced } from '../../lib/mailer.js';
import { getPlan } from '../billing/plans.js';
import { getBalance, holdCredits } from '../billing/wallet.js';
import { loadCatalog, type CatalogRow } from '../catalog/catalog.js';
import { finishGeneration, type GenerationRow } from '../generations/service.js';
import { usdToCredits } from '../orchestrator/router.js';
import { moderatePrompt } from '../providers/adapters/openai.js';
import { textCostUsd } from '../providers/adapters/openrouter.js';
import { ProviderError, TEXT_MODES, type TextMode } from '../providers/types.js';
import { textModels, textProvider, type ChatMessage, type TextUsage } from '../text/providers.js';
import { searchConfigured, sourcesBlock, webSearch, type SearchResult } from '../text/search.js';

/** Catalog category a text mode needs. Agents run on any chat model. */
const categoryFor = (mode: TextMode) => (mode === 'agent' ? 'chat' : mode);

export const MAX_OUTPUT: Record<TextMode, number> = { chat: 2000, story: 4000, code: 4000, research: 2000, agent: 2000 };
const MIN_OUTPUT = 256;
const estTokens = (s: string) => Math.ceil(s.length / 4);

/** Explicit model if allowed, else the best default: free models first for the Free plan, paid first otherwise. */
export async function resolveTextModel(mode: TextMode, planId: string, modelId?: string | null): Promise<CatalogRow> {
  await loadCatalog();
  const category = categoryFor(mode);
  const usable = textModels().filter((r) => r.categories.includes(category));
  if (modelId) {
    const hit = usable.find((r) => r.id === modelId);
    if (!hit) throw new AppError(400, 'model_unavailable', 'That model is not available for this mode');
    return hit;
  }
  return (await rankTextModels(mode, planId))[0]!;
}

/** Usable models for a mode, best first: free models first for the Free plan, paid first otherwise. */
export async function rankTextModels(mode: TextMode, planId: string): Promise<CatalogRow[]> {
  await loadCatalog();
  const category = categoryFor(mode);
  const usable = textModels().filter((r) => r.categories.includes(category));
  if (usable.length === 0) throw new AppError(503, 'no_provider_available', `No ${category} model is available right now`);
  const preferFree = planId === 'free';
  return [...usable].sort((a, b) =>
    (preferFree ? Number(b.is_free) - Number(a.is_free) : Number(a.is_free) - Number(b.is_free))
    || Number(b.featured) - Number(a.featured) || b.quality - a.quality);
}

export interface Reservation {
  gen: GenerationRow;
  row: CatalogRow;
  mode: TextMode;
  maxTokens: number;
  search: boolean;
}

/**
 * Checks limits and moderation, then reserves the worst-case credits for one text turn.
 * Throws AppError before anything is streamed, so the caller can still answer with plain JSON.
 */
export async function reserveTurn(opts: {
  userId: string; mode: TextMode; row: CatalogRow; promptChars: number; userText: string; search: boolean;
}): Promise<Reservation> {
  const { userId, mode, row, search } = opts;
  if (search && !searchConfigured()) throw new AppError(503, 'search_unavailable', 'Web search is not configured yet');
  if (config.MODERATION_ENABLED) {
    const mod = await moderatePrompt(opts.userText).catch(() => ({ flagged: false, categories: [] as string[] }));
    if (mod.flagged) throw new AppError(422, 'content_policy', 'This message violates our content policy', { categories: mod.categories });
  }
  const ctx = row.context_length ?? 32_000;
  const inTok = Math.ceil(opts.promptChars / 4) + (search ? 1200 : 0) + 50;
  const fullTokens = Math.max(MIN_OUTPUT, Math.min(MAX_OUTPUT[mode], ctx - inTok - 64));
  const searchUsd = search ? config.SEARCH_COST_USD : 0;
  const creditsFor = (outTok: number) => {
    const usd = textCostUsd(row, inTok, outTok) + searchUsd;
    return usd > 0 ? usdToCredits(usd) : 0;
  };

  const { gen, maxTokens } = await tx(async (c) => {
    const { rows: [u] } = await c.query<{ plan_id: string; status: string; email_verified_at: Date | null }>(
      'SELECT plan_id, status, email_verified_at FROM users WHERE id = $1 FOR UPDATE', [userId],
    );
    if (!u || u.status !== 'active') throw new AppError(403, 'account_inactive', 'Account is not active');
    if (verificationEnforced() && !u.email_verified_at) {
      throw new AppError(403, 'email_not_verified', 'Verify your email address first');
    }
    const plan = getPlan(u.plan_id);
    const { rows: [n] } = await c.query<{ today: number }>(
      `SELECT count(*)::int AS today FROM generations
        WHERE user_id = $1 AND modality = ANY($2) AND created_at >= date_trunc('day', now())`,
      [userId, TEXT_MODES],
    );
    if (n!.today >= plan.dailyMessages) {
      throw limitExceeded(`Daily limit of ${plan.dailyMessages} messages reached on the ${plan.name} plan`, { limit: plan.dailyMessages });
    }
    // Reserve the worst case, but if the balance can't cover a full-length reply, shorten the reply
    // to what it can cover rather than refusing outright.
    let maxTokens = fullTokens;
    let held = creditsFor(maxTokens);
    const { total } = await getBalance(userId, c);
    if (held > total) {
      const perOutTok = (row.pricing.outputPerMTok ?? 0) / 1e6;
      const budgetUsd = (total * config.INR_PER_CREDIT_COST) / (config.USD_INR * config.PRICE_MARKUP) - textCostUsd(row, inTok, 0) - searchUsd;
      const affordable = perOutTok > 0 ? Math.floor(budgetUsd / perOutTok) : 0;
      if (affordable < MIN_OUTPUT) throw insufficientCredits(creditsFor(MIN_OUTPUT), total);
      maxTokens = Math.min(fullTokens, affordable);
      held = Math.min(creditsFor(maxTokens), total);
    }
    const estUsd = textCostUsd(row, inTok, maxTokens) + searchUsd;
    const { rows: [g] } = await c.query<GenerationRow>(
      `INSERT INTO generations (user_id, prompt, modality, params, candidates, held_credits, idempotency_key, status, started_at, locked_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'running',now(),now()) RETURNING *`,
      [userId, opts.userText.slice(0, 4000), mode, { maxTokens, search },
        JSON.stringify([{ modelId: row.id, providerId: row.provider_id, label: row.label, credits: held, costUsd: estUsd, licenseNote: row.license_note }]),
        held, `text:${randomUUID()}`],
    );
    const hold = await holdCredits(c, userId, held, g!.id);
    const { rows: [updated] } = await c.query<GenerationRow>(
      'UPDATE generations SET hold_subscription = $2, hold_purchased = $3 WHERE id = $1 RETURNING *',
      [g!.id, hold.subscription, hold.purchased],
    );
    return { gen: updated!, maxTokens };
  });
  return { gen, row, mode, maxTokens, search };
}

export interface TurnResult {
  text: string;
  citations: { n: number; title: string; url: string }[];
  credits: number;
  status: 'succeeded' | 'failed' | 'canceled';
  error?: string;
}

/**
 * Runs a reserved turn: optional web search, streaming generation, then settlement.
 * Every exit path settles the hold exactly once (charged actual cost, or refunded).
 */
export async function executeTurn(
  r: Reservation, baseMessages: ChatMessage[], searchQuery: string,
  hooks: { onSources?: (s: SearchResult[]) => void; onDelta?: (t: string) => void; signal: AbortSignal },
): Promise<TurnResult> {
  const provider = textProvider(r.row.provider_id);
  let sources: SearchResult[] = [];
  let text = '';
  let usage: TextUsage | null = null;
  let failure: ProviderError | null = null;

  try {
    if (!provider?.isConfigured()) throw new ProviderError(`${r.row.provider_id}: not configured`, 'unavailable');
    let messages = baseMessages;
    if (r.search) {
      sources = await webSearch(searchQuery).catch((err) => {
        throw new ProviderError(`search: ${(err as Error).message}`, 'retriable');
      });
      hooks.onSources?.(sources);
      const block = sources.length
        ? `\n\nWeb sources (cite them inline as [1], [2], ...; do not invent sources; say so if they don't answer the question):\n\n${sourcesBlock(sources)}`
        : '\n\nWeb search returned no results; answer from general knowledge and say that no sources were found.';
      messages = [{ role: 'system', content: `${baseMessages[0]!.content}${block}` }, ...baseMessages.slice(1)];
    }
    for await (const ev of provider.stream(r.row.model, messages, { maxTokens: r.maxTokens, signal: hooks.signal })) {
      if (ev.type === 'delta') {
        text += ev.text;
        hooks.onDelta?.(ev.text);
      } else {
        usage = ev.usage;
      }
    }
  } catch (err) {
    failure = hooks.signal.aborted
      ? new ProviderError('stopped by user', 'retriable')
      : err instanceof ProviderError ? err : new ProviderError(String((err as Error)?.message ?? err), 'retriable');
    if (!hooks.signal.aborted) logger.warn({ generationId: r.gen.id, provider: r.row.provider_id, err: failure.message }, 'text turn failed');
  }

  // Cost: provider-reported when available; otherwise token prices. Partial output is still paid to the provider.
  const inTok = usage?.inputTokens || estTokens(baseMessages.map((m) => m.content).join('')) + (sources.length ? 1200 : 0);
  const outTok = usage?.outputTokens || estTokens(text);
  const produced = text.length > 0 || usage !== null;
  const costUsd = (produced ? (usage?.costUsd ?? textCostUsd(r.row, inTok, outTok)) : 0) + (r.search && sources.length ? config.SEARCH_COST_USD : 0);
  const charge = costUsd > 0 ? Math.min(r.gen.held_credits, usdToCredits(costUsd)) : 0;
  const status = failure ? (hooks.signal.aborted ? 'canceled' : produced ? 'succeeded' : 'failed') : 'succeeded';
  const error = failure && !produced
    ? (failure.kind === 'rejected' ? 'The model declined this request. Credits refunded.' : `Generation failed. Credits refunded. ${failure.message.slice(0, 160)}`)
    : failure ? `Stopped early: ${failure.message.slice(0, 160)}` : undefined;

  await tx((c) => finishGeneration(c, r.gen.id, ['running'], {
    status, charge, error, providerId: r.row.provider_id, model: r.row.model, costUsd, licenseNote: r.row.license_note,
  }));
  return { text, citations: sources.map((s, i) => ({ n: i + 1, title: s.title, url: s.url })), credits: charge, status, error };
}

/**
 * Single-shot completion (e.g. the agent generator). Falls back through the top 3 ranked models when one
 * fails without output; each failed attempt is refunded by executeTurn.
 */
export async function completeOnce(userId: string, planId: string, system: string, prompt: string): Promise<TurnResult> {
  let last: TurnResult | null = null;
  for (const row of (await rankTextModels('chat', planId)).slice(0, 3)) {
    const r = await reserveTurn({ userId, mode: 'chat', row, promptChars: system.length + prompt.length, userText: prompt, search: false });
    last = await executeTurn(r, [{ role: 'system', content: system }, { role: 'user', content: prompt }], '', { signal: AbortSignal.timeout(120_000) });
    if (last.status === 'succeeded') return last;
  }
  return last!;
}
