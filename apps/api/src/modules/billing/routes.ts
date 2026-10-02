import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { parse } from '../../middleware/validate.js';
import { CREDIT_PACKS, PLANS } from './plans.js';
import * as rzp from './razorpay.js';
import { getBalance } from './wallet.js';

export const billingRoutes = Router();

billingRoutes.get('/catalog', (_req, res) => {
  res.json({ plans: Object.values(PLANS), packs: CREDIT_PACKS });
});

billingRoutes.get('/wallet', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, kind, delta_subscription + delta_purchased AS delta, balance_after, ref_type, ref_id, note, created_at
       FROM credit_ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
    [req.user!.id],
  );
  res.json({ balance: await getBalance(req.user!.id), ledger: rows });
});

const payLimiter = rateLimit({ name: 'pay', limit: 10, windowSec: 60 });

billingRoutes.post('/orders', requireAuth, payLimiter, async (req, res) => {
  const { packId } = parse(z.object({ packId: z.string() }), req.body);
  res.status(201).json(await rzp.createPackOrder(req.user!.id, packId));
});

billingRoutes.post('/orders/verify', requireAuth, payLimiter, async (req, res) => {
  const b = parse(z.object({ orderId: z.string(), paymentId: z.string(), signature: z.string() }), req.body);
  await rzp.verifyCheckout(req.user!.id, b.orderId, b.paymentId, b.signature);
  res.json({ ok: true, balance: await getBalance(req.user!.id) });
});

billingRoutes.post('/subscriptions', requireAuth, payLimiter, async (req, res) => {
  const { planId } = parse(z.object({ planId: z.string() }), req.body);
  res.status(201).json(await rzp.createSubscription(req.user!.id, planId));
});

billingRoutes.post('/subscriptions/cancel', requireAuth, payLimiter, async (req, res) => {
  await rzp.cancelSubscription(req.user!.id);
  res.json({ ok: true });
});

/** Mounted with a raw body parser so the HMAC is computed over the exact bytes Razorpay signed. */
export const razorpayWebhook = Router();
razorpayWebhook.post('/', async (req, res) => {
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !rzp.verifyWebhookSignature(raw, req.header('x-razorpay-signature'))) {
    res.status(400).json({ error: { code: 'bad_signature', message: 'Invalid signature' } });
    return;
  }
  const eventId = req.header('x-razorpay-event-id');
  if (!eventId) throw badRequest('Missing event id');
  const result = await rzp.handleWebhook(eventId, JSON.parse(raw.toString('utf8')));
  logger.info({ eventId, result }, 'razorpay webhook');
  res.json({ status: result });
});
