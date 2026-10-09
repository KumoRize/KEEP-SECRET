import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { alert, captureError } from '../../lib/monitoring.js';
import { usdToCredits } from '../orchestrator/router.js';
import { breaker } from '../providers/circuitBreaker.js';
import { loadCatalog } from '../catalog/catalog.js';
import { findModel, getAdapter, providerSettings } from '../providers/registry.js';
import {
  ProviderError, type GenerationParams, type GenerationRequest, type Modality, type ProviderAdapter, type ProviderModel, type ProviderResult,
} from '../providers/types.js';
import { storage } from '../storage/storage.js';
import { finishGeneration, type GenerationRow } from './service.js';

type Candidate = GenerationRow['candidates'][number];
type Attempt = GenerationRow['attempts'][number];

/** Delay before the next status check of a long-running job: 5s, growing to at most 30s. */
export const pollDelayMs = (pollCount: number) => Math.min(5000 * 1.5 ** pollCount, 30_000);

/**
 * Claims either a new job or a waiting long-running job whose next status check is due.
 * Waiting jobs stay 'running' with no lock, so they hold no worker slot between checks.
 */
export async function claimNext(): Promise<GenerationRow | null> {
  const { rows } = await pool.query<GenerationRow>(
    `UPDATE generations SET status = 'running', started_at = COALESCE(started_at, now()), locked_at = now()
      WHERE id = (
        SELECT id FROM generations
         WHERE status = 'queued' OR (status = 'running' AND locked_at IS NULL AND next_poll_at <= now())
         ORDER BY COALESCE(next_poll_at, created_at) FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  return rows[0] ?? null;
}

const request = (gen: GenerationRow): GenerationRequest => ({
  generationId: gen.id, prompt: gen.prompt, modality: gen.modality as Modality, params: gen.params as GenerationParams,
});

const asProviderError = (err: unknown) =>
  err instanceof ProviderError ? err : new ProviderError(String((err as Error)?.message ?? err), 'retriable');

/** Overall deadline for a generation, counted from when a worker first picked it up. */
const pastDeadline = (gen: GenerationRow) =>
  gen.started_at !== null && Date.now() - new Date(gen.started_at).getTime() > config.JOB_TIMEOUT_SEC * 1000;

const signalFor = () => AbortSignal.timeout(Math.min(config.JOB_TIMEOUT_SEC, 120) * 1000);

/**
 * Advances one claimed generation by one step. Synchronous models run to completion; long-running
 * models are submitted (or polled) and then released until their next check is due. Failures fall
 * through to the next candidate; content refusals end the job. Every terminal path settles credits.
 */
export async function processGeneration(gen: GenerationRow): Promise<GenerationRow | null> {
  await loadCatalog(); // catalog-backed models (fal, OpenRouter) must be resolvable
  const attempts: Attempt[] = [...gen.attempts];

  // 1) A long-running job is waiting on the provider: check on it.
  if (gen.external_id) {
    const cand = gen.candidates[gen.candidate_index]!;
    const model = findModel(cand.modelId);
    const adapter = getAdapter(cand.providerId);
    const started = Date.now();
    let result: ProviderResult;
    try {
      if (!model || !adapter?.poll) throw new ProviderError(`${cand.providerId}: provider no longer available`, 'unavailable');
      if (pastDeadline(gen)) throw new ProviderError(`${cand.providerId}: timed out after ${config.JOB_TIMEOUT_SEC}s`, 'retriable');
      const res = await adapter.poll(model, gen.external_id, request(gen), signalFor());
      if (res.status === 'pending') return wait(gen, gen.external_id, gen.candidate_index, gen.poll_count + 1, attempts);
      if (res.result.files.length === 0) throw new ProviderError(`${cand.providerId}: no output`, 'retriable');
      result = res.result;
    } catch (err) {
      const outcome = await recordFailure(gen, cand, asProviderError(err), attempts, started);
      if (outcome.stopped) return outcome.row;
      return tryCandidates(gen, gen.candidate_index + 1, attempts);
    }
    // Outside the try: storage or DB errors after the provider finished must not trigger a paid fallback.
    breaker.recordSuccess(cand.providerId);
    attempts.push({ modelId: cand.modelId, ok: true, ms: Date.now() - started });
    return complete(gen, cand, model!, result, attempts);
  }
  // 2) New job (or resuming the chain after a long-running candidate failed).
  return tryCandidates(gen, gen.candidate_index, attempts);
}

async function tryCandidates(gen: GenerationRow, from: number, attempts: Attempt[]): Promise<GenerationRow | null> {
  const settings = await providerSettings();
  for (let i = from; i < gen.candidates.length; i++) {
    const cand = gen.candidates[i]!;
    const model = findModel(cand.modelId);
    const adapter = getAdapter(cand.providerId);
    if (!model || !adapter || settings.get(cand.providerId)?.enabled === false || breaker.isOpen(cand.providerId)) {
      attempts.push({ modelId: cand.modelId, ok: false, error: 'skipped: unavailable', ms: 0 });
      continue;
    }
    if (pastDeadline(gen)) {
      attempts.push({ modelId: cand.modelId, ok: false, error: `skipped: past the ${config.JOB_TIMEOUT_SEC}s deadline`, ms: 0 });
      break;
    }
    const started = Date.now();
    let result: ProviderResult;
    try {
      if (model.async && adapter.submit && adapter.poll) {
        const { externalId } = await adapter.submit(model, request(gen), signalFor());
        return wait(gen, externalId, i, 0, attempts);
      }
      result = await runSync(adapter, model, gen);
    } catch (err) {
      const outcome = await recordFailure(gen, cand, asProviderError(err), attempts, started);
      if (outcome.stopped) return outcome.row;
      continue;
    }
    breaker.recordSuccess(cand.providerId);
    attempts.push({ modelId: cand.modelId, ok: true, ms: Date.now() - started });
    return complete(gen, cand, model, result, attempts);
  }
  const last = [...attempts].reverse().find((a) => !a.ok)?.error ?? 'No provider available';
  return settle(gen, { status: 'failed', charge: 0, error: `All providers failed. Credits refunded. Last error: ${last.slice(0, 200)}`, attempts });
}

async function runSync(adapter: ProviderAdapter, model: ProviderModel, gen: GenerationRow): Promise<ProviderResult> {
  if (!adapter.run) throw new ProviderError(`${adapter.id}: no synchronous run for ${model.id}`, 'unavailable');
  const result = await adapter.run(model, request(gen), AbortSignal.timeout(config.JOB_TIMEOUT_SEC * 1000));
  if (result.files.length === 0) throw new ProviderError(`${adapter.id}: no output`, 'retriable');
  return result;
}

/** Logs a failed attempt. A content refusal ends the job (settled and refunded); anything else falls through. */
async function recordFailure(
  gen: GenerationRow, cand: Candidate, pe: ProviderError, attempts: Attempt[], started: number,
): Promise<{ stopped: true; row: GenerationRow | null } | { stopped: false }> {
  attempts.push({ modelId: cand.modelId, ok: false, error: pe.message.slice(0, 300), ms: Date.now() - started });
  logger.warn({ generationId: gen.id, provider: cand.providerId, kind: pe.kind, err: pe.message }, 'provider attempt failed');
  if (pe.kind === 'rejected') {
    // Safety/policy refusals are final: never route around a provider's content decision.
    const row = await settle(gen, {
      status: 'failed', charge: 0, error: 'The provider declined this request (content policy or invalid input). Credits refunded.', attempts,
    });
    return { stopped: true, row };
  }
  breaker.recordFailure(cand.providerId, pe.kind === 'unavailable');
  return { stopped: false };
}

/** Releases the job until its next status check; it holds no worker slot meanwhile. */
async function wait(gen: GenerationRow, externalId: string, index: number, pollCount: number, attempts: Attempt[]) {
  const { rows } = await pool.query<GenerationRow>(
    `UPDATE generations SET external_id = $2, candidate_index = $3, poll_count = $4, attempts = $5,
            next_poll_at = now() + make_interval(secs => $6), locked_at = NULL
      WHERE id = $1 AND status = 'running' RETURNING *`,
    [gen.id, externalId, index, pollCount, JSON.stringify(attempts), pollDelayMs(pollCount) / 1000],
  );
  return rows[0] ?? null;
}

async function complete(gen: GenerationRow, cand: Candidate, model: ProviderModel, result: ProviderResult, attempts: Attempt[]) {
  const costUsd = result.costUsd ?? cand.costUsd;
  // Charge the actual cost when the provider reports usage, never more than the quoted hold.
  const charge = Math.min(gen.held_credits, result.costUsd !== undefined ? usdToCredits(costUsd) : cand.credits);
  const stored = await Promise.all(result.files.map(async (f) => {
    const key = `u/${gen.user_id}/g/${gen.id}/${randomUUID()}-${f.filename.replace(/\//g, '_')}`;
    await storage.put(key, f.data, f.contentType);
    return { key, ...f };
  }));
  return tx(async (c) => {
    const done = await finishGeneration(c, gen.id, ['running'], {
      status: 'succeeded', charge, providerId: cand.providerId, model: model.model, costUsd, licenseNote: cand.licenseNote, attempts,
    });
    if (!done) return null; // reaped meanwhile; credits already refunded
    for (const f of stored) {
      await c.query(
        'INSERT INTO assets (user_id, generation_id, storage_key, filename, content_type, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)',
        [gen.user_id, gen.id, f.key, f.filename, f.contentType, f.data.length],
      );
    }
    return done;
  });
}

function settle(gen: GenerationRow, outcome: Parameters<typeof finishGeneration>[3]) {
  return tx((c) => finishGeneration(c, gen.id, ['running'], outcome));
}

/**
 * Fails and refunds jobs that can no longer finish: a worker died mid-step (lock held too long),
 * or a long-running job is far past its deadline without being picked up.
 */
export async function reapStale(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM generations WHERE status = 'running' AND (
        locked_at < now() - make_interval(secs => $1)
        OR (locked_at IS NULL AND started_at < now() - make_interval(secs => $1 + 600)))`,
    [config.JOB_TIMEOUT_SEC + 120],
  );
  let n = 0;
  for (const { id } of rows) {
    const done = await tx((c) => finishGeneration(c, id, ['running'], { status: 'failed', charge: 0, error: 'Generation timed out. Credits refunded.' }));
    if (done) n++;
  }
  return n;
}

/** Alerts when jobs wait too long to start: workers are down, stuck or under-provisioned. */
export async function checkBacklog(maxWaitSec = 300): Promise<{ queued: number; oldestSec: number }> {
  const { rows: [r] } = await pool.query<{ queued: number; oldest_sec: number | null }>(
    `SELECT count(*)::int AS queued, EXTRACT(EPOCH FROM now() - min(created_at))::int AS oldest_sec
       FROM generations WHERE status = 'queued'`,
  );
  const oldestSec = r!.oldest_sec ?? 0;
  if (oldestSec > maxWaitSec) {
    await alert('backlog', `${r!.queued} generation(s) queued; the oldest has waited ${Math.round(oldestSec / 60)} min. Scale workers or check for a stuck provider.`);
  }
  return { queued: r!.queued, oldestSec };
}

export function startWorker(concurrency = config.WORKER_CONCURRENCY): { stop: () => Promise<void> } {
  let running = true;
  const loops: Promise<void>[] = [];
  const loop = async () => {
    while (running) {
      try {
        const gen = await claimNext();
        if (!gen) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        await processGeneration(gen);
      } catch (err) {
        captureError(err, { where: 'worker loop' });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  for (let i = 0; i < concurrency; i++) loops.push(loop());
  const reaper = setInterval(() => {
    reapStale()
      .then((n) => n > 0 && alert('reaper', `${n} generation(s) timed out and were refunded. Check provider status and worker health.`))
      .catch((err) => captureError(err, { where: 'reaper' }));
    checkBacklog().catch((err) => captureError(err, { where: 'backlog check' }));
  }, 60_000);
  logger.info({ concurrency }, 'worker started');
  return {
    stop: async () => {
      running = false;
      clearInterval(reaper);
      await Promise.all(loops);
    },
  };
}
