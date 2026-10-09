import type { PoolClient } from 'pg';
import { pool, tx, type Db } from '../../db/pool.js';
import { badRequest, insufficientCredits } from '../../lib/errors.js';

export interface Balance {
  subscription: number;
  purchased: number;
  total: number;
}

interface WalletRow {
  subscription_balance: number;
  purchased_balance: number;
}

async function lockWallet(c: PoolClient, userId: string): Promise<WalletRow> {
  await c.query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  const { rows } = await c.query<WalletRow>(
    'SELECT subscription_balance, purchased_balance FROM wallets WHERE user_id = $1 FOR UPDATE',
    [userId],
  );
  return rows[0]!;
}

async function apply(
  c: PoolClient,
  userId: string,
  dSub: number,
  dPur: number,
  entry: { kind: string; refType?: string; refId?: string; idempotencyKey?: string; note?: string },
): Promise<Balance> {
  const { rows } = await c.query<WalletRow>(
    `UPDATE wallets SET subscription_balance = subscription_balance + $2,
       purchased_balance = purchased_balance + $3, updated_at = now()
     WHERE user_id = $1 RETURNING subscription_balance, purchased_balance`,
    [userId, dSub, dPur],
  );
  const w = rows[0]!;
  const total = w.subscription_balance + w.purchased_balance;
  await c.query(
    `INSERT INTO credit_ledger (user_id, kind, delta_subscription, delta_purchased, balance_after, ref_type, ref_id, idempotency_key, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, entry.kind, dSub, dPur, total, entry.refType ?? null, entry.refId ?? null, entry.idempotencyKey ?? null, entry.note ?? null],
  );
  return { subscription: w.subscription_balance, purchased: w.purchased_balance, total };
}

/** Returns true if this idempotency key was already applied (so the caller must not re-apply). */
async function alreadyApplied(c: PoolClient, key: string | undefined): Promise<boolean> {
  if (!key) return false;
  const { rowCount } = await c.query('SELECT 1 FROM credit_ledger WHERE idempotency_key = $1', [key]);
  return (rowCount ?? 0) > 0;
}

export async function getBalance(userId: string, db: Db = pool): Promise<Balance> {
  const { rows } = await db.query<WalletRow>(
    'SELECT subscription_balance, purchased_balance FROM wallets WHERE user_id = $1',
    [userId],
  );
  const w = rows[0] ?? { subscription_balance: 0, purchased_balance: 0 };
  return { subscription: w.subscription_balance, purchased: w.purchased_balance, total: w.subscription_balance + w.purchased_balance };
}

/** Adds non-expiring credits (packs, admin grants). Idempotent per key. */
export async function addPurchasedCredits(
  userId: string,
  amount: number,
  meta: { kind: 'purchase' | 'admin_adjust'; refType?: string; refId?: string; idempotencyKey?: string; note?: string },
  client?: PoolClient,
): Promise<Balance> {
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('amount must be a positive integer');
  const run = async (c: PoolClient) => {
    await lockWallet(c, userId);
    if (await alreadyApplied(c, meta.idempotencyKey)) return getBalance(userId, c);
    return apply(c, userId, 0, amount, meta);
  };
  return client ? run(client) : tx(run);
}

/** Admin debit; spends purchased credits after subscription credits, never below zero. */
export async function debitCredits(userId: string, amount: number, note: string, refId?: string): Promise<Balance> {
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('amount must be a positive integer');
  return tx(async (c) => {
    const w = await lockWallet(c, userId);
    const total = w.subscription_balance + w.purchased_balance;
    if (total < amount) throw insufficientCredits(amount, total);
    const fromSub = Math.min(w.subscription_balance, amount);
    return apply(c, userId, -fromSub, -(amount - fromSub), { kind: 'admin_adjust', refType: 'admin', refId, note });
  });
}

/**
 * Starts a new billing cycle: unused subscription credits expire and the plan allowance is granted.
 * Idempotent per cycle key (e.g. Razorpay invoice/payment id).
 */
export async function resetSubscriptionCredits(
  userId: string,
  allowance: number,
  idempotencyKey: string,
  client?: PoolClient,
): Promise<Balance> {
  const run = async (c: PoolClient) => {
    const w = await lockWallet(c, userId);
    if (await alreadyApplied(c, idempotencyKey)) return getBalance(userId, c);
    if (w.subscription_balance > 0) {
      await apply(c, userId, -w.subscription_balance, 0, { kind: 'expire_subscription', refType: 'cycle', refId: idempotencyKey });
    }
    return apply(c, userId, allowance, 0, { kind: 'grant_subscription', refType: 'cycle', refId: idempotencyKey, idempotencyKey });
  };
  return client ? run(client) : tx(run);
}

export interface Hold {
  subscription: number;
  purchased: number;
}

/** Reserves credits inside the caller's transaction. Subscription credits are spent first (they expire). */
export async function holdCredits(c: PoolClient, userId: string, amount: number, generationId: string): Promise<Hold> {
  if (amount === 0) return { subscription: 0, purchased: 0 }; // free model: nothing to reserve
  const w = await lockWallet(c, userId);
  const total = w.subscription_balance + w.purchased_balance;
  if (total < amount) throw insufficientCredits(amount, total);
  const sub = Math.min(w.subscription_balance, amount);
  const hold = { subscription: sub, purchased: amount - sub };
  await apply(c, userId, -hold.subscription, -hold.purchased, {
    kind: 'hold', refType: 'generation', refId: generationId, idempotencyKey: `hold:${generationId}`,
  });
  return hold;
}

/**
 * Settles a hold: keeps `charge` credits and refunds the rest, purchased credits first
 * (subscription credits are refunded last since they would expire anyway).
 */
export async function settleHold(c: PoolClient, userId: string, generationId: string, hold: Hold, charge: number): Promise<void> {
  const held = hold.subscription + hold.purchased;
  const keep = Math.max(0, Math.min(charge, held));
  const refund = held - keep;
  if (refund === 0) return;
  // Consume subscription credits first for the kept part; refund whatever remains in each bucket.
  const keepSub = Math.min(hold.subscription, keep);
  const keepPur = keep - keepSub;
  await lockWallet(c, userId);
  await apply(c, userId, hold.subscription - keepSub, hold.purchased - keepPur, {
    kind: 'refund', refType: 'generation', refId: generationId, idempotencyKey: `refund:${generationId}`,
    note: keep === 0 ? 'full refund' : `partial refund, charged ${keep}`,
  });
}
