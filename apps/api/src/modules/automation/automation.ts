import { config, ownerEmail } from '../../config.js';
import { pool } from '../../db/pool.js';
import { mailer } from '../../lib/mailer.js';
import { alert } from '../../lib/monitoring.js';
import { invalidateCatalog } from '../catalog/catalog.js';
import { setupChecklist } from '../settings/setup.js';
import { settings } from '../settings/settings.js';

const IST_MS = 5.5 * 3600_000;
const istDate = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const istHour = (d: Date) => new Date(d.getTime() + IST_MS).getUTCHours();
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/**
 * Claims a once-per-day job slot across all workers. Returns true for exactly one caller per (job, day).
 * State rows use a '_state:' prefix that settings loading ignores.
 */
async function claimDaily(job: string, day: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, to_jsonb($2::text))
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE app_settings.value <> EXCLUDED.value`,
    [`_state:${job}`, day],
  );
  return (rowCount ?? 0) > 0;
}

export interface DailyReport {
  day: string;
  revenueInr: number;
  payments: number;
  providerCostInr: number;
  profitInr: number;
  newUsers: number;
  succeeded: number;
  failed: number;
  topModels: { model: string; jobs: number }[];
  setupMissing: string[];
}

/** Numbers for one IST calendar day. */
export async function buildDailyReport(day: string): Promise<DailyReport> {
  const from = new Date(`${day}T00:00:00+05:30`);
  const to = new Date(from.getTime() + 86_400_000);
  const [rev, cost, users, gens, top, setup] = await Promise.all([
    pool.query<{ paise: number; n: number }>(`SELECT COALESCE(sum(amount_paise),0)::bigint AS paise, count(*)::int AS n FROM payments WHERE status = 'paid' AND paid_at >= $1 AND paid_at < $2`, [from, to]),
    pool.query<{ micros: number }>(`SELECT COALESCE(sum(provider_cost_usd_micros),0)::bigint AS micros FROM generations WHERE finished_at >= $1 AND finished_at < $2`, [from, to]),
    pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM users WHERE created_at >= $1 AND created_at < $2`, [from, to]),
    pool.query<{ ok: number; bad: number }>(`SELECT count(*) FILTER (WHERE status = 'succeeded')::int AS ok, count(*) FILTER (WHERE status = 'failed')::int AS bad
                FROM generations WHERE finished_at >= $1 AND finished_at < $2`, [from, to]),
    pool.query<{ model: string; jobs: number }>(`SELECT COALESCE(model, provider_id, 'unknown') AS model, count(*)::int AS jobs FROM generations
                WHERE status = 'succeeded' AND finished_at >= $1 AND finished_at < $2 GROUP BY 1 ORDER BY 2 DESC LIMIT 3`, [from, to]),
    setupChecklist(),
  ]);
  const revenueInr = Number(rev.rows[0]!.paise) / 100;
  const providerCostInr = (Number(cost.rows[0]!.micros) / 1e6) * config.USD_INR;
  return {
    day, revenueInr, payments: rev.rows[0]!.n, providerCostInr, profitInr: revenueInr - providerCostInr, newUsers: users.rows[0]!.n,
    succeeded: gens.rows[0]!.ok, failed: gens.rows[0]!.bad, topModels: top.rows,
    setupMissing: setup.items.filter((i) => i.required && i.status !== 'ok').map((i) => i.label),
  };
}

export function formatReport(r: DailyReport): string {
  return [
    `${config.APP_NAME}: daily report for ${r.day}`,
    '',
    `Revenue: ${inr(r.revenueInr)} from ${r.payments} payment(s)`,
    `AI provider cost: ${inr(r.providerCostInr)}`,
    `Gross profit: ${inr(r.profitInr)}`,
    `New users: ${r.newUsers}`,
    `Generations: ${r.succeeded} succeeded, ${r.failed} failed`,
    r.topModels.length ? `Top models: ${r.topModels.map((m) => `${m.model} (${m.jobs})`).join(', ')}` : 'Top models: none yet',
    r.setupMissing.length ? `\nStill to set up: ${r.setupMissing.join(', ')}` : '\nSetup: complete',
    '',
    `Open your dashboard: ${config.PUBLIC_URL}/admin`,
  ].join('\n');
}

/** Sends yesterday's report once per day, at or after the owner's chosen IST hour. */
export async function maybeSendDailyReport(now = new Date()): Promise<DailyReport | null> {
  const a = settings().automation;
  if (!a.dailyReport || istHour(now) < a.reportHourIst) return null;
  const today = istDate(now);
  if (!(await claimDaily('daily_report', today))) return null;
  const yesterday = istDate(new Date(now.getTime() - 86_400_000));
  const report = await buildDailyReport(yesterday);
  const text = formatReport(report);
  const to = ownerEmail();
  if (to) await mailer.send({ to, subject: `${config.APP_NAME} daily report: ${inr(report.revenueInr)} revenue`, text });
  await alert(`daily-report:${today}`, text);
  return report;
}

export interface LossMaker { providerId: string; model: string; jobs: number; costInr: number; chargedInr: number }

/**
 * Models whose real provider cost exceeded what users were charged (at list value per credit) over
 * the last 7 days, e.g. after a provider price rise. Needs at least 3 jobs to avoid noise.
 */
export async function findLossMakers(): Promise<LossMaker[]> {
  const { rows } = await pool.query<{ provider_id: string; model: string; jobs: number; micros: number; credits: number }>(
    `SELECT provider_id, model, count(*)::int AS jobs, COALESCE(sum(provider_cost_usd_micros),0)::bigint AS micros,
            COALESCE(sum(charged_credits),0)::bigint AS credits
       FROM generations WHERE status = 'succeeded' AND finished_at >= now() - interval '7 days' AND model IS NOT NULL
      GROUP BY provider_id, model HAVING count(*) >= 3`,
  );
  return rows.map((r) => ({
    providerId: r.provider_id, model: r.model, jobs: r.jobs,
    costInr: (Number(r.micros) / 1e6) * config.USD_INR, chargedInr: Number(r.credits) * config.INR_PER_CREDIT_COST,
  })).filter((r) => r.costInr > r.chargedInr && r.costInr > 0);
}

/** Daily: alerts on loss-making models and, if the owner enabled it, disables them in the catalog. */
export async function maybeRunLossGuard(now = new Date()): Promise<{ losers: LossMaker[]; disabled: string[] } | null> {
  if (!(await claimDaily('loss_guard', istDate(now)))) return null;
  const losers = await findLossMakers();
  const disabled: string[] = [];
  if (losers.length && settings().automation.autoDisableLossMakers) {
    for (const l of losers) {
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE catalog_models SET enabled = false, updated_at = now() WHERE provider_id = $1 AND model = $2 AND enabled RETURNING id`, [l.providerId, l.model],
      );
      disabled.push(...rows.map((r) => r.id));
    }
    if (disabled.length) {
      invalidateCatalog();
      await pool.query("SELECT pg_notify('settings_changed', 'catalog')");
    }
  }
  if (losers.length) {
    const lines = losers.map((l) => `${l.providerId}/${l.model}: cost ${inr(l.costInr)} vs charged ${inr(l.chargedInr)} over ${l.jobs} jobs`);
    const msg = `${losers.length} model(s) lost money in the last 7 days:\n${lines.join('\n')}\n`
      + (disabled.length ? `Automatically disabled: ${disabled.join(', ')}.` : 'Raise their price in Admin > Models, or turn on auto-disable in Settings > Automation.');
    await alert(`loss-guard:${istDate(now)}`, msg);
    const to = ownerEmail();
    if (to) await mailer.send({ to, subject: `${config.APP_NAME}: ${losers.length} model(s) losing money`, text: msg });
  }
  return { losers, disabled };
}

/** Runs all owner automations; safe to call often from every worker. */
export async function runAutomations(now = new Date()): Promise<void> {
  await maybeSendDailyReport(now);
  await maybeRunLossGuard(now);
}
