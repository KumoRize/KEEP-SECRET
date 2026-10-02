import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { usdToCredits } from '../orchestrator/router.js';
import { breaker } from '../providers/circuitBreaker.js';
import { findModel, getAdapter, providerSettings } from '../providers/registry.js';
import { ProviderError, type GenerationParams, type Modality, type ProviderResult } from '../providers/types.js';
import { storage } from '../storage/storage.js';
import { finishGeneration, type GenerationRow } from './service.js';

export async function claimNext(): Promise<GenerationRow | null> {
  const { rows } = await pool.query<GenerationRow>(
    `UPDATE generations SET status = 'running', started_at = now(), locked_at = now()
      WHERE id = (SELECT id FROM generations WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`,
  );
  return rows[0] ?? null;
}

/** Runs one claimed generation through its candidate chain with fallback, then settles credits. */
export async function processGeneration(gen: GenerationRow): Promise<GenerationRow | null> {
  const attempts: GenerationRow['attempts'] = [];
  const settings = await providerSettings();
  let lastError = 'No provider available';

  for (const cand of gen.candidates) {
    const model = findModel(cand.modelId);
    const adapter = getAdapter(cand.providerId);
    if (!model || !adapter || settings.get(cand.providerId)?.enabled === false || breaker.isOpen(cand.providerId)) {
      attempts.push({ modelId: cand.modelId, ok: false, error: 'skipped: unavailable', ms: 0 });
      continue;
    }
    const started = Date.now();
    let result: ProviderResult;
    try {
      result = await adapter.run(model, {
        generationId: gen.id, prompt: gen.prompt, modality: gen.modality as Modality, params: gen.params as GenerationParams,
      }, AbortSignal.timeout(config.JOB_TIMEOUT_SEC * 1000));
      if (result.files.length === 0) throw new ProviderError(`${cand.providerId}: no output`, 'retriable');
    } catch (err) {
      const pe = err instanceof ProviderError ? err : new ProviderError(String((err as Error).message ?? err), 'retriable');
      attempts.push({ modelId: cand.modelId, ok: false, error: pe.message.slice(0, 300), ms: Date.now() - started });
      lastError = pe.message;
      logger.warn({ generationId: gen.id, provider: cand.providerId, kind: pe.kind, err: pe.message }, 'provider attempt failed');
      if (pe.kind === 'rejected') {
        // Safety/policy refusals are final: never route around a provider's content decision.
        return settle(gen, { status: 'failed', charge: 0, error: 'The provider declined this request (content policy or invalid input). Credits refunded.', attempts });
      }
      breaker.recordFailure(cand.providerId, pe.kind === 'unavailable');
      continue;
    }
    breaker.recordSuccess(cand.providerId);
    attempts.push({ modelId: cand.modelId, ok: true, ms: Date.now() - started });

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
  return settle(gen, { status: 'failed', charge: 0, error: `All providers failed. Credits refunded. Last error: ${lastError.slice(0, 200)}`, attempts });
}

function settle(gen: GenerationRow, outcome: Parameters<typeof finishGeneration>[3]) {
  return tx((c) => finishGeneration(c, gen.id, ['running'], outcome));
}

/** Fails and refunds jobs whose worker died mid-run. */
export async function reapStale(): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM generations WHERE status = 'running' AND locked_at < now() - make_interval(secs => $1)`,
    [config.JOB_TIMEOUT_SEC + 120],
  );
  let n = 0;
  for (const { id } of rows) {
    const done = await tx((c) => finishGeneration(c, id, ['running'], { status: 'failed', charge: 0, error: 'Generation timed out. Credits refunded.' }));
    if (done) n++;
  }
  return n;
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
        logger.error({ err }, 'worker loop error');
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  for (let i = 0; i < concurrency; i++) loops.push(loop());
  const reaper = setInterval(() => reapStale().catch((err) => logger.error({ err }, 'reaper failed')), 60_000);
  logger.info({ concurrency }, 'worker started');
  return {
    stop: async () => {
      running = false;
      clearInterval(reaper);
      await Promise.all(loops);
    },
  };
}
