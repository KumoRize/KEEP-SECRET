import { config, razorpayPlanIds } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { hmac, safeEqual } from '../../lib/crypto.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { issueInvoice } from './invoices.js';
import { rewardReferral } from './referrals.js';
import { CREDIT_PACKS, getPlan, isPlanId, PLANS } from './plans.js';
import { addPurchasedCredits, resetSubscriptionCredits } from './wallet.js';

const API = 'https://api.razorpay.com/v1';

function assertConfigured() {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) {
    throw new AppError(503, 'payments_unavailable', 'Payments are not configured');
  }
}

async function rzp<T>(method: string, path: string, body?: object): Promise<T> {
  assertConfigured();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    logger.error({ status: res.status, path }, 'razorpay api error');
    throw new AppError(502, 'payment_provider_error', 'Payment provider error, please retry');
  }
  return (await res.json()) as T;
}

export async function createPackOrder(userId: string, packId: string) {
  const pack = CREDIT_PACKS.find((p) => p.id === packId);
  if (!pack) throw badRequest('Unknown credit pack');
  assertConfigured();
  const amount = pack.priceInr * 100;
  const { rows: [payment] } = await pool.query<{ id: string }>(
    `INSERT INTO payments (user_id, kind, item_id, amount_paise) VALUES ($1, 'credit_pack', $2, $3) RETURNING id`,
    [userId, pack.id, amount],
  );
  const order = await rzp<{ id: string }>('POST', '/orders', {
    amount, currency: 'INR', receipt: payment!.id, notes: { payment_id: payment!.id, user_id: userId, pack_id: pack.id },
  });
  await pool.query('UPDATE payments SET razorpay_order_id = $2 WHERE id = $1', [payment!.id, order.id]);
  return { keyId: config.RAZORPAY_KEY_ID, orderId: order.id, amount, currency: 'INR', pack };
}

/** Grants pack credits exactly once per payment row. Returns false if already fulfilled. */
async function fulfillPackOrder(orderId: string, paymentId: string, amountPaise?: number): Promise<boolean> {
  return tx(async (c) => {
    const { rows } = await c.query<{ id: string; user_id: string; item_id: string; amount_paise: number }>(
      `UPDATE payments SET status = 'paid', razorpay_payment_id = $2, paid_at = now()
        WHERE razorpay_order_id = $1 AND status = 'created' RETURNING id, user_id, item_id, amount_paise`,
      [orderId, paymentId],
    );
    const p = rows[0];
    if (!p) return false;
    if (amountPaise !== undefined && amountPaise !== p.amount_paise) {
      throw new AppError(400, 'amount_mismatch', 'Paid amount does not match order');
    }
    const pack = CREDIT_PACKS.find((x) => x.id === p.item_id)!;
    await addPurchasedCredits(p.user_id, pack.credits, {
      kind: 'purchase', refType: 'payment', refId: p.id, idempotencyKey: `payment:${p.id}`, note: pack.name,
    }, c);
    await issueInvoice(c, p.id);
    await rewardReferral(c, p.user_id, p.id);
    return true;
  });
}

/** Client-side confirmation after Razorpay Checkout; the webhook is the backstop if this never arrives. */
export async function verifyCheckout(userId: string, orderId: string, paymentId: string, signature: string) {
  assertConfigured();
  const expected = hmac(config.RAZORPAY_KEY_SECRET!, `${orderId}|${paymentId}`);
  if (!safeEqual(expected, signature)) throw badRequest('Invalid payment signature');
  const { rowCount } = await pool.query('SELECT 1 FROM payments WHERE razorpay_order_id = $1 AND user_id = $2', [orderId, userId]);
  if (!rowCount) throw notFound('Order not found');
  await fulfillPackOrder(orderId, paymentId);
}

export async function createSubscription(userId: string, planId: string) {
  if (!isPlanId(planId) || planId === 'free') throw badRequest('Unknown paid plan');
  const rzpPlan = razorpayPlanIds()[planId];
  if (!rzpPlan) throw new AppError(503, 'payments_unavailable', `Plan ${planId} is not configured for payments`);
  const sub = await rzp<{ id: string; short_url?: string }>('POST', '/subscriptions', {
    plan_id: rzpPlan, total_count: 120, customer_notify: 1, notes: { user_id: userId, plan_id: planId },
  });
  await pool.query('INSERT INTO subscriptions (user_id, plan_id, razorpay_subscription_id) VALUES ($1,$2,$3)', [userId, planId, sub.id]);
  return { keyId: config.RAZORPAY_KEY_ID, subscriptionId: sub.id, shortUrl: sub.short_url, plan: PLANS[planId] };
}

export async function cancelSubscription(userId: string) {
  const { rows } = await pool.query<{ razorpay_subscription_id: string }>(
    `SELECT razorpay_subscription_id FROM subscriptions WHERE user_id = $1 AND status IN ('active','authenticated') ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  if (!rows[0]) throw notFound('No active subscription');
  // Keep access until the paid period ends; maintenance downgrades afterwards.
  await rzp('POST', `/subscriptions/${rows[0].razorpay_subscription_id}/cancel`, { cancel_at_cycle_end: 1 });
  await pool.query(`UPDATE subscriptions SET status = 'cancel_scheduled' WHERE razorpay_subscription_id = $1`, [rows[0].razorpay_subscription_id]);
}

export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!config.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  return safeEqual(hmac(config.RAZORPAY_WEBHOOK_SECRET, rawBody), signature);
}

interface WebhookBody {
  event: string;
  payload: {
    payment?: { entity: { id: string; order_id?: string; amount: number; status: string } };
    subscription?: { entity: { id: string; status: string; current_end?: number; notes?: Record<string, string> } };
  };
}

export async function handleWebhook(eventId: string, body: WebhookBody): Promise<'processed' | 'duplicate' | 'ignored'> {
  const { rowCount } = await pool.query(
    'INSERT INTO webhook_events (id, source, event) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [eventId, 'razorpay', body.event],
  );
  if (!rowCount) return 'duplicate';
  try {
    return await dispatch(body);
  } catch (err) {
    // Let Razorpay retry: forget the event id so the retry is not treated as a duplicate.
    await pool.query('DELETE FROM webhook_events WHERE id = $1', [eventId]);
    throw err;
  }
}

async function dispatch(body: WebhookBody): Promise<'processed' | 'ignored'> {
  const payment = body.payload.payment?.entity;
  const sub = body.payload.subscription?.entity;
  switch (body.event) {
    case 'payment.captured':
    case 'order.paid':
      if (payment?.order_id) await fulfillPackOrder(payment.order_id, payment.id, payment.amount);
      return 'processed';
    case 'subscription.activated':
    case 'subscription.authenticated':
      if (sub) await pool.query('UPDATE subscriptions SET status = $2 WHERE razorpay_subscription_id = $1', [sub.id, sub.status]);
      return 'processed';
    case 'subscription.charged':
      if (sub && payment) await onSubscriptionCharged(sub, payment);
      return 'processed';
    case 'subscription.cancelled':
    case 'subscription.completed':
    case 'subscription.halted':
      if (sub) {
        await pool.query(
          'UPDATE subscriptions SET status = $2, current_period_end = COALESCE(to_timestamp($3), current_period_end) WHERE razorpay_subscription_id = $1',
          [sub.id, sub.status, sub.current_end ?? null],
        );
      }
      return 'processed';
    default:
      return 'ignored';
  }
}

async function onSubscriptionCharged(
  sub: NonNullable<WebhookBody['payload']['subscription']>['entity'],
  payment: NonNullable<WebhookBody['payload']['payment']>['entity'],
) {
  const replaced = await tx(async (c) => {
    const { rows } = await c.query<{ user_id: string; plan_id: string }>(
      'SELECT user_id, plan_id FROM subscriptions WHERE razorpay_subscription_id = $1 FOR UPDATE', [sub.id],
    );
    const s = rows[0];
    if (!s) throw new Error(`unknown subscription ${sub.id}`);
    const plan = getPlan(s.plan_id);
    const periodEnd = sub.current_end ? new Date(sub.current_end * 1000) : new Date(Date.now() + 31 * 86_400_000);
    await c.query(
      `UPDATE subscriptions SET status = 'active', current_period_end = $2 WHERE razorpay_subscription_id = $1`,
      [sub.id, periodEnd],
    );
    await c.query('UPDATE users SET plan_id = $2, plan_renews_at = $3 WHERE id = $1', [s.user_id, plan.id, periodEnd]);
    const { rows: [paymentRow] } = await c.query<{ id: string }>(
      `INSERT INTO payments (user_id, kind, item_id, amount_paise, status, razorpay_payment_id, razorpay_subscription_id, paid_at)
       VALUES ($1, 'subscription', $2, $3, 'paid', $4, $5, now()) ON CONFLICT (razorpay_payment_id) DO NOTHING RETURNING id`,
      [s.user_id, plan.id, payment.amount, payment.id, sub.id],
    );
    if (paymentRow) {
      await issueInvoice(c, paymentRow.id);
      await rewardReferral(c, s.user_id, paymentRow.id);
    }
    await resetSubscriptionCredits(s.user_id, plan.monthlyCredits, `sub:${sub.id}:${payment.id}`, c);
    // A new subscription supersedes any older one (plan change).
    const { rows: old } = await c.query<{ razorpay_subscription_id: string }>(
      `UPDATE subscriptions SET status = 'replaced' WHERE user_id = $1 AND razorpay_subscription_id <> $2
         AND status IN ('active','authenticated','cancel_scheduled') RETURNING razorpay_subscription_id`,
      [s.user_id, sub.id],
    );
    return old.map((o) => o.razorpay_subscription_id);
  });
  for (const id of replaced) {
    await rzp('POST', `/subscriptions/${id}/cancel`, { cancel_at_cycle_end: 0 }).catch((err) =>
      logger.error({ err, id }, 'failed to cancel replaced subscription'),
    );
  }
}

/**
 * Hourly: refreshes free-plan monthly credits and downgrades lapsed paid plans.
 * Paid plan renewals are driven by subscription.charged webhooks.
 */
export async function runBillingMaintenance(): Promise<{ renewedFree: number; downgraded: number }> {
  const { rows: lapsed } = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.plan_id <> 'free' AND u.plan_renews_at < now() - interval '1 day'
       AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.user_id = u.id AND s.status = 'active' AND s.current_period_end > now())`,
  );
  for (const { id } of lapsed) {
    await tx(async (c) => {
      await c.query(`UPDATE users SET plan_id = 'free', plan_renews_at = now() + interval '1 month' WHERE id = $1`, [id]);
      await resetSubscriptionCredits(id, PLANS.free.monthlyCredits, `downgrade:${id}:${Date.now()}`, c);
    });
  }
  const { rows: due } = await pool.query<{ id: string; plan_renews_at: Date }>(
    `SELECT id, plan_renews_at FROM users WHERE plan_id = 'free' AND (plan_renews_at IS NULL OR plan_renews_at <= now())`,
  );
  for (const u of due) {
    const cycle = new Date().toISOString().slice(0, 7);
    await tx(async (c) => {
      await resetSubscriptionCredits(u.id, PLANS.free.monthlyCredits, `free:${u.id}:${cycle}`, c);
      await c.query(`UPDATE users SET plan_renews_at = date_trunc('month', now()) + interval '1 month' WHERE id = $1`, [u.id]);
    });
  }
  return { renewedFree: due.length, downgraded: lapsed.length };
}
