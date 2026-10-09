import type { Request, Response } from 'express';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { safeEqual } from '../../lib/crypto.js';

/**
 * Prometheus text exposition for queue health and recent outcomes, read from Postgres so the
 * numbers are the same whichever API instance is scraped. Requires `Authorization: Bearer METRICS_TOKEN`.
 */
export async function metricsHandler(req: Request, res: Response): Promise<void> {
  const token = req.header('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!config.METRICS_TOKEN || !safeEqual(token, config.METRICS_TOKEN)) {
    res.status(404).end(); // indistinguishable from a missing route
    return;
  }
  const [{ rows: [q] }, { rows: outcomes }] = await Promise.all([
    pool.query<{ queued: number; waiting: number; active: number; oldest: number | null; held: number }>(
      `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE status = 'running' AND locked_at IS NULL)::int AS waiting,
              count(*) FILTER (WHERE status = 'running' AND locked_at IS NOT NULL)::int AS active,
              EXTRACT(EPOCH FROM now() - min(created_at) FILTER (WHERE status = 'queued'))::int AS oldest,
              COALESCE(sum(held_credits) FILTER (WHERE status IN ('queued','running')), 0)::bigint AS held
         FROM generations WHERE status IN ('queued', 'running')`,
    ),
    pool.query<{ status: string; provider: string; n: number; cost: number }>(
      `SELECT status, COALESCE(provider_id, 'none') AS provider, count(*)::int AS n,
              COALESCE(sum(provider_cost_usd_micros), 0)::bigint AS cost
         FROM generations WHERE finished_at >= now() - interval '1 hour' GROUP BY 1, 2`,
    ),
  ]);
  const lines = [
    '# HELP creator_generations_queued Jobs waiting for a worker.',
    '# TYPE creator_generations_queued gauge',
    `creator_generations_queued ${q!.queued}`,
    '# HELP creator_generations_waiting Long-running jobs waiting on a provider (no worker held).',
    '# TYPE creator_generations_waiting gauge',
    `creator_generations_waiting ${q!.waiting}`,
    '# HELP creator_generations_active Jobs currently held by a worker.',
    '# TYPE creator_generations_active gauge',
    `creator_generations_active ${q!.active}`,
    '# HELP creator_queue_oldest_seconds Age of the oldest queued job.',
    '# TYPE creator_queue_oldest_seconds gauge',
    `creator_queue_oldest_seconds ${q!.oldest ?? 0}`,
    '# HELP creator_credits_held Credits reserved by unfinished jobs.',
    '# TYPE creator_credits_held gauge',
    `creator_credits_held ${q!.held}`,
    '# HELP creator_generations_finished_1h Jobs finished in the last hour.',
    '# TYPE creator_generations_finished_1h gauge',
    ...outcomes.map((o) => `creator_generations_finished_1h{status="${o.status}",provider="${o.provider.replace(/"/g, '')}"} ${o.n}`),
    '# HELP creator_provider_cost_usd_1h Provider cost of jobs finished in the last hour.',
    '# TYPE creator_provider_cost_usd_1h gauge',
    ...outcomes.filter((o) => o.status === 'succeeded').map((o) => `creator_provider_cost_usd_1h{provider="${o.provider.replace(/"/g, '')}"} ${Number(o.cost) / 1e6}`),
  ];
  res.setHeader('Content-Type', 'text/plain; version=0.0.4');
  res.send(`${lines.join('\n')}\n`);
}
