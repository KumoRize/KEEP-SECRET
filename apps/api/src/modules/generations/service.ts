import type { PoolClient } from 'pg';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { AppError, badRequest, conflict, limitExceeded, notFound } from '../../lib/errors.js';
import { getPlan } from '../billing/plans.js';
import { holdCredits, settleHold } from '../billing/wallet.js';
import { verifyQuote } from '../orchestrator/quote.js';
import { TEXT_MODES } from '../providers/types.js';

export interface GenerationRow {
  id: string;
  user_id: string;
  project_id: string | null;
  prompt: string;
  modality: string;
  params: Record<string, unknown>;
  candidates: { modelId: string; providerId: string; label: string; credits: number; costUsd: number; licenseNote: string }[];
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';
  held_credits: number;
  hold_subscription: number;
  hold_purchased: number;
  charged_credits: number | null;
  provider_id: string | null;
  model: string | null;
  provider_cost_usd_micros: number | null;
  attempts: { modelId: string; error?: string; ok: boolean; ms: number }[];
  license_note: string | null;
  error: string | null;
  external_id: string | null;
  candidate_index: number;
  poll_count: number;
  started_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}

export async function createGeneration(
  userId: string,
  input: { prompt: string; quoteToken: string; projectId?: string },
  idempotencyKey: string,
): Promise<{ generation: GenerationRow; created: boolean }> {
  const existing = await findByIdempotencyKey(userId, idempotencyKey);
  if (existing) return { generation: existing, created: false };

  const quote = verifyQuote(input.quoteToken, userId, input.prompt);

  try {
    const generation = await tx(async (c) => {
      // Lock the user row so concurrency/daily checks and the credit hold are serialised per user.
      const { rows: users } = await c.query<{ plan_id: string; status: string; email_verified_at: Date | null }>(
        'SELECT plan_id, status, email_verified_at FROM users WHERE id = $1 FOR UPDATE', [userId],
      );
      const user = users[0];
      if (!user || user.status !== 'active') throw new AppError(403, 'account_inactive', 'Account is not active');
      if (config.REQUIRE_EMAIL_VERIFICATION && !user.email_verified_at) {
        throw new AppError(403, 'email_not_verified', 'Verify your email address before generating');
      }
      const plan = getPlan(user.plan_id);
      if (!plan.modalities.includes(quote.modality)) {
        throw new AppError(403, 'plan_upgrade_required', `${quote.modality} is not included in your plan`);
      }

      const { rows: [counts] } = await c.query<{ active: number; today: number }>(
        `SELECT count(*) FILTER (WHERE status IN ('queued','running'))::int AS active,
                count(*) FILTER (WHERE created_at >= date_trunc('day', now()))::int AS today
           FROM generations WHERE user_id = $1 AND created_at >= now() - interval '2 days' AND modality <> ALL($2)`,
        [userId, TEXT_MODES],
      );
      if (counts!.active >= plan.maxConcurrent) {
        throw limitExceeded(`Your plan allows ${plan.maxConcurrent} generation(s) at a time`, { limit: plan.maxConcurrent });
      }
      if (counts!.today >= plan.dailyGenerations) {
        throw limitExceeded(`Daily limit of ${plan.dailyGenerations} generations reached`, { limit: plan.dailyGenerations });
      }
      // Checked before the job starts so we never pay a provider for output we cannot store.
      // One generation may overshoot the quota slightly; the next one is blocked.
      const { rows: [usage] } = await c.query<{ bytes: number }>(
        'SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM assets WHERE user_id = $1', [userId],
      );
      if (usage!.bytes >= plan.storageGb * 1024 ** 3) {
        throw new AppError(403, 'storage_full', `Storage limit of ${plan.storageGb} GB reached. Delete files or upgrade.`, {
          usedBytes: usage!.bytes, limitBytes: plan.storageGb * 1024 ** 3,
        });
      }
      if (input.projectId) {
        const { rowCount } = await c.query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [input.projectId, userId]);
        if (!rowCount) throw badRequest('Unknown project');
      }

      const { rows: [gen] } = await c.query<GenerationRow>(
        `INSERT INTO generations (user_id, project_id, prompt, modality, params, candidates, held_credits, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [userId, input.projectId ?? null, input.prompt.trim(), quote.modality, quote.params, JSON.stringify(quote.candidates), quote.hold, idempotencyKey],
      );
      const hold = await holdCredits(c, userId, quote.hold, gen!.id);
      const { rows: [updated] } = await c.query<GenerationRow>(
        'UPDATE generations SET hold_subscription = $2, hold_purchased = $3 WHERE id = $1 RETURNING *',
        [gen!.id, hold.subscription, hold.purchased],
      );
      return updated!;
    });
    await pool.query("SELECT pg_notify('generation_queued', $1)", [generation.id]);
    return { generation, created: true };
  } catch (err) {
    // A concurrent request with the same Idempotency-Key won the race.
    if ((err as { code?: string }).code === '23505') {
      const row = await findByIdempotencyKey(userId, idempotencyKey);
      if (row) return { generation: row, created: false };
    }
    throw err;
  }
}

async function findByIdempotencyKey(userId: string, key: string): Promise<GenerationRow | null> {
  const { rows } = await pool.query<GenerationRow>('SELECT * FROM generations WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
  return rows[0] ?? null;
}

export async function getGeneration(userId: string, id: string): Promise<GenerationRow> {
  const { rows } = await pool.query<GenerationRow>('SELECT * FROM generations WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rows[0]) throw notFound('Generation not found');
  return rows[0];
}

/**
 * Terminal transition with credit settlement. Guarded by the expected current status so that
 * a generation is settled exactly once even if the worker and reaper race.
 */
export async function finishGeneration(
  c: PoolClient,
  id: string,
  from: GenerationRow['status'][],
  outcome: { status: 'succeeded' | 'failed' | 'canceled'; charge: number; error?: string; providerId?: string; model?: string; costUsd?: number; licenseNote?: string; attempts?: GenerationRow['attempts'] },
): Promise<GenerationRow | null> {
  const { rows } = await c.query<GenerationRow>(
    `UPDATE generations SET status = $3, charged_credits = $4, error = $5, provider_id = COALESCE($6, provider_id),
            model = COALESCE($7, model), provider_cost_usd_micros = $8, license_note = $9,
            attempts = COALESCE($10, attempts), finished_at = now(), locked_at = NULL,
            external_id = NULL, next_poll_at = NULL
      WHERE id = $1 AND status = ANY($2) RETURNING *`,
    [
      id, from, outcome.status, outcome.charge, outcome.error ?? null, outcome.providerId ?? null, outcome.model ?? null,
      outcome.costUsd !== undefined ? Math.round(outcome.costUsd * 1e6) : null, outcome.licenseNote ?? null,
      outcome.attempts ? JSON.stringify(outcome.attempts) : null,
    ],
  );
  const gen = rows[0];
  if (!gen) return null;
  await settleHold(c, gen.user_id, gen.id, { subscription: gen.hold_subscription, purchased: gen.hold_purchased }, outcome.charge);
  return gen;
}

export async function cancelGeneration(userId: string, id: string): Promise<GenerationRow> {
  return tx(async (c) => {
    const { rows } = await c.query<GenerationRow>('SELECT * FROM generations WHERE id = $1 AND user_id = $2 FOR UPDATE', [id, userId]);
    if (!rows[0]) throw notFound('Generation not found');
    if (rows[0].status !== 'queued') throw conflict('Only queued generations can be canceled');
    return (await finishGeneration(c, id, ['queued'], { status: 'canceled', charge: 0, error: 'Canceled by user' }))!;
  });
}
