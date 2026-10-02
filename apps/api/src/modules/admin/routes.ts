import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { requireAdmin, requireAuth } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { isPlanId } from '../billing/plans.js';
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
  const [users, revenue, gens, byProvider] = await Promise.all([
    pool.query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE plan_id <> 'free')::int AS paying FROM users`),
    pool.query(`SELECT COALESCE(sum(amount_paise), 0)::bigint AS paise FROM payments WHERE status = 'paid' AND paid_at >= now() - make_interval(days => $1)`, [days]),
    pool.query(
      `SELECT status, count(*)::int AS n FROM generations WHERE created_at >= now() - make_interval(days => $1) GROUP BY status`, [days]),
    pool.query(
      `SELECT provider_id, modality, count(*)::int AS generations, COALESCE(sum(charged_credits),0)::bigint AS credits,
              COALESCE(sum(provider_cost_usd_micros),0)::bigint AS cost_usd_micros
         FROM generations WHERE status = 'succeeded' AND created_at >= now() - make_interval(days => $1)
        GROUP BY provider_id, modality ORDER BY cost_usd_micros DESC`, [days]),
  ]);
  res.json({
    days,
    users: users.rows[0],
    revenueInr: Number(revenue.rows[0].paise) / 100,
    generationsByStatus: gens.rows,
    providerCosts: byProvider.rows.map((r) => ({ ...r, cost_usd: Number(r.cost_usd_micros) / 1e6 })),
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

adminRoutes.get('/audit', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200');
  res.json({ items: rows });
});
