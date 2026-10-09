import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { alert } from '../../lib/monitoring.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { parse } from '../../middleware/validate.js';
import { isValidGstin } from '../../lib/gstin.js';
import { notFound } from '../../lib/errors.js';
import { isStateCode, STATES } from './gst.js';
import { invoiceSummary, type InvoiceRow } from './invoices.js';
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

billingRoutes.get('/profile', requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT legal_name, address, state_code, gstin FROM billing_profiles WHERE user_id = $1', [req.user!.id],
  );
  res.json({ profile: rows[0] ?? { legal_name: '', address: '', state_code: null, gstin: null }, states: STATES });
});

const profileSchema = z.object({
  legalName: z.string().trim().max(200).default(''),
  address: z.string().trim().max(500).default(''),
  stateCode: z.string().refine(isStateCode, 'Unknown state code').nullable().default(null),
  gstin: z.string().trim().toUpperCase().refine(isValidGstin, 'Invalid GSTIN (check the format and last character)').nullable().default(null),
}).superRefine((p, ctx) => {
  // A GSTIN fixes the buyer's state; a mismatch would put the wrong place of supply on invoices.
  if (p.gstin && p.stateCode && p.gstin.slice(0, 2) !== p.stateCode) {
    ctx.addIssue({ code: 'custom', path: ['stateCode'], message: 'State must match the first two digits of the GSTIN' });
  }
  if (p.gstin && (!p.legalName || !p.address)) {
    ctx.addIssue({ code: 'custom', path: ['legalName'], message: 'Legal name and address are required with a GSTIN' });
  }
});

/** Applies to invoices issued after the change; issued invoices are immutable snapshots. */
billingRoutes.put('/profile', requireAuth, async (req, res) => {
  const p = parse(profileSchema, req.body);
  const stateCode = p.gstin ? p.gstin.slice(0, 2) : p.stateCode;
  await pool.query(
    `INSERT INTO billing_profiles (user_id, legal_name, address, state_code, gstin) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id) DO UPDATE SET legal_name = $2, address = $3, state_code = $4, gstin = $5, updated_at = now()`,
    [req.user!.id, p.legalName, p.address, stateCode, p.gstin],
  );
  res.json({ profile: { legal_name: p.legalName, address: p.address, state_code: stateCode, gstin: p.gstin } });
});

billingRoutes.get('/invoices', requireAuth, async (req, res) => {
  const { rows } = await pool.query<InvoiceRow>('SELECT * FROM invoices WHERE user_id = $1 ORDER BY issued_at DESC LIMIT 100', [req.user!.id]);
  res.json({ items: rows.map(invoiceSummary) });
});

billingRoutes.get('/invoices/:id', requireAuth, async (req, res) => {
  const { rows } = await pool.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1 AND user_id = $2', [parse(z.uuid(), req.params.id), req.user!.id]);
  if (!rows[0]) throw notFound('Invoice not found');
  res.json(invoiceSummary(rows[0]));
});

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
  const result = await rzp.handleWebhook(eventId, JSON.parse(raw.toString('utf8'))).catch((err) => {
    // Razorpay retries, but a failing payment webhook means paid customers may be missing credits.
    void alert('razorpay-webhook', `Razorpay webhook ${eventId} failed: ${(err as Error).message}`.slice(0, 300));
    throw err;
  });
  logger.info({ eventId, result }, 'razorpay webhook');
  res.json({ status: result });
});
