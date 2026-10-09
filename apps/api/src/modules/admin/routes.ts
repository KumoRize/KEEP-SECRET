import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { invoicesCsv } from '../billing/invoices.js';
import { getPlan, isPlanId } from '../billing/plans.js';
import { config } from '../../config.js';
import { addPurchasedCredits, debitCredits, getBalance } from '../billing/wallet.js';
import { breaker } from '../providers/circuitBreaker.js';
import { invalidateProviderSettings, listAdapters, providerSettings } from '../providers/registry.js';

export const adminRoutes = Router();
adminRoutes.use(requireAuth, requireAdmin);

async function audit(actorId: string, action: string, target: string, meta: object) {
  await pool.query('INSERT INTO audit_log (actor_id, action, target, meta) VALUES ($1,$2,$3,$4)', [actorId, action, target, meta]);
}

adminRoutes.get('/stats', async (req, res) => {
  const days = parse(z.coerce.number().int().min(1).max(365).default(30), req.query.days);
  const [users, revenue, gens, byProvider, subs, wallets, referrals] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE plan_id <> 'free')::int AS paying,
                       count(*) FILTER (WHERE created_at >= now() - make_interval(days => $1))::int AS new FROM users`, [days]),
    pool.query(`SELECT COALESCE(sum(amount_paise), 0)::bigint AS paise, count(*)::int AS payments,
                       COALESCE(sum(amount_paise) FILTER (WHERE kind = 'subscription'), 0)::bigint AS sub_paise
                  FROM payments WHERE status = 'paid' AND paid_at >= now() - make_interval(days => $1)`, [days]),
    pool.query(`SELECT status, count(*)::int AS n FROM generations WHERE created_at >= now() - make_interval(days => $1) GROUP BY status`, [days]),
    pool.query(
      `SELECT provider_id, modality, count(*)::int AS generations, COALESCE(sum(charged_credits),0)::bigint AS credits,
              COALESCE(sum(provider_cost_usd_micros),0)::bigint AS cost_usd_micros
         FROM generations WHERE status = 'succeeded' AND created_at >= now() - make_interval(days => $1)
        GROUP BY provider_id, modality ORDER BY cost_usd_micros DESC`, [days]),
    pool.query(`SELECT plan_id, count(*)::int AS n FROM subscriptions WHERE status = 'active' AND current_period_end > now() GROUP BY plan_id`),
    pool.query(`SELECT COALESCE(sum(subscription_balance + purchased_balance), 0)::bigint AS credits FROM wallets`),
    pool.query(`SELECT count(*)::int AS rewards, COALESCE(sum(referrer_credits + referee_credits), 0)::int AS credits
                  FROM referral_rewards WHERE created_at >= now() - make_interval(days => $1)`, [days]),
  ]);
  const revenueInr = Number(revenue.rows[0].paise) / 100;
  const providerCosts = byProvider.rows.map((r) => {
    const costInr = (Number(r.cost_usd_micros) / 1e6) * config.USD_INR;
    // What the charged credits are worth at list value (before plan discounts).
    const creditValueInr = Number(r.credits) * config.INR_PER_CREDIT_COST;
    return { ...r, cost_usd: Number(r.cost_usd_micros) / 1e6, cost_inr: Math.round(costInr * 100) / 100, credit_value_inr: creditValueInr };
  });
  const providerCostInr = providerCosts.reduce((s, r) => s + r.cost_inr, 0);
  const mrrInr = subs.rows.reduce((s, r) => s + getPlan(r.plan_id).priceInr * r.n, 0);
  const outstandingCredits = Number(wallets.rows[0].credits);
  const paying = users.rows[0].paying as number;
  res.json({
    days,
    users: users.rows[0],
    revenueInr,
    payments: revenue.rows[0].payments,
    providerCostInr: Math.round(providerCostInr * 100) / 100,
    grossProfitInr: Math.round((revenueInr - providerCostInr) * 100) / 100,
    marginPct: revenueInr > 0 ? Math.round(((revenueInr - providerCostInr) / revenueInr) * 1000) / 10 : null,
    mrrInr,
    activeSubscriptions: subs.rows,
    arpuInr: paying > 0 ? Math.round((revenueInr / paying) * 100) / 100 : 0,
    // Provider cost you would incur if every outstanding credit were spent (credits are priced at cost x markup).
    outstandingCredits,
    outstandingCostInr: Math.round(((outstandingCredits * config.INR_PER_CREDIT_COST) / config.PRICE_MARKUP) * 100) / 100,
    referrals: referrals.rows[0],
    generationsByStatus: gens.rows,
    providerCosts,
  });
});

adminRoutes.get('/users', async (req, res) => {
  const q = parse(z.object({ q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.name, u.role, u.status, u.plan_id, u.created_at,
            COALESCE(w.subscription_balance + w.purchased_balance, 0) AS credits
       FROM users u LEFT JOIN wallets w ON w.user_id = u.id
      WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%')
      ORDER BY u.created_at DESC LIMIT $2`,
    [q.q ?? null, q.limit],
  );
  res.json({ items: rows });
});

adminRoutes.post('/users/:id/credits', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({ amount: z.number().int().refine((n) => n !== 0 && Math.abs(n) <= 1_000_000), reason: z.string().trim().min(3).max(200) }), req.body);
  const balance = b.amount > 0
    ? await addPurchasedCredits(id, b.amount, { kind: 'admin_adjust', refType: 'admin', refId: req.user!.id, note: b.reason })
    : await debitCredits(id, -b.amount, b.reason, req.user!.id);
  await audit(req.user!.id, 'credits.adjust', id, b);
  res.json({ balance });
});

adminRoutes.patch('/users/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({
    status: z.enum(['active', 'suspended']).optional(),
    role: z.enum(['user', 'admin']).optional(),
    planId: z.string().refine(isPlanId, 'unknown plan').optional(),
  }), req.body);
  const { rows } = await pool.query(
    `UPDATE users SET status = COALESCE($2, status), role = COALESCE($3, role), plan_id = COALESCE($4, plan_id)
      WHERE id = $1 RETURNING id, email, status, role, plan_id`,
    [id, b.status ?? null, b.role ?? null, b.planId ?? null],
  );
  if (!rows[0]) throw notFound();
  if (b.status === 'suspended') await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
  await audit(req.user!.id, 'user.update', id, b);
  res.json({ ...rows[0], balance: await getBalance(id) });
});

adminRoutes.get('/providers', async (_req, res) => {
  const settings = await providerSettings();
  const health = breaker.snapshot();
  res.json({
    items: listAdapters().map((a) => ({
      id: a.id,
      name: a.name,
      configured: a.isConfigured(), // never expose key material, only whether it is set
      enabled: settings.get(a.id)?.enabled ?? true,
      priority: settings.get(a.id)?.priority ?? 100,
      circuit: health[a.id] ?? { failures: 0, open: false },
      models: a.isConfigured() ? a.models().map((m) => ({ id: m.id, modality: m.modality, label: m.label, commercialUse: m.license.commercialUse })) : [],
    })),
  });
});

adminRoutes.put('/providers/:id', async (req, res) => {
  const id = parse(z.string().max(50), req.params.id);
  if (!listAdapters().some((a) => a.id === id)) throw notFound('Unknown provider');
  const b = parse(z.object({ enabled: z.boolean(), priority: z.number().int().min(0).max(1000) }), req.body);
  await pool.query(
    `INSERT INTO provider_settings (provider_id, enabled, priority) VALUES ($1,$2,$3)
     ON CONFLICT (provider_id) DO UPDATE SET enabled = $2, priority = $3, updated_at = now()`,
    [id, b.enabled, b.priority],
  );
  invalidateProviderSettings();
  await audit(req.user!.id, 'provider.update', id, b);
  res.json({ id, ...b });
});

adminRoutes.get('/generations', async (req, res) => {
  const q = parse(z.object({ status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const { rows } = await pool.query(
    `SELECT g.id, u.email, g.modality, g.status, g.provider_id, g.model, g.held_credits, g.charged_credits,
            g.provider_cost_usd_micros, g.attempts, g.error, g.created_at, g.finished_at
       FROM generations g JOIN users u ON u.id = g.user_id
      WHERE ($1::text IS NULL OR g.status = $1) ORDER BY g.created_at DESC LIMIT $2`,
    [q.status ?? null, q.limit],
  );
  res.json({ items: rows });
});

adminRoutes.get('/invoices.csv', async (req, res) => {
  const q = parse(z.object({ from: z.iso.date(), to: z.iso.date() }), req.query);
  // `to` is inclusive for the caller; dates are IST calendar days.
  const from = new Date(`${q.from}T00:00:00+05:30`);
  const to = new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000);
  await audit(req.user!.id, 'invoices.export', `${q.from}..${q.to}`, {});
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="invoices-${q.from}-to-${q.to}.csv"`);
  res.send(await invoicesCsv(from, to));
});

adminRoutes.get('/audit', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
  res.json({ items: rows });
});
