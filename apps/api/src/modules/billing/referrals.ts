import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { Router } from 'express';
import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { requireAuth } from '../../middleware/auth.js';
import { addPurchasedCredits } from './wallet.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

export function newReferralCode(): string {
  return [...randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/**
 * Pays referral rewards once per referred user, on their first real payment, inside the payment
 * transaction. Rewarding payments (not sign-ups) makes fake-account farming pointless.
 */
export async function rewardReferral(c: PoolClient, refereeId: string, paymentId: string): Promise<boolean> {
  const { rows: [u] } = await c.query<{ referred_by: string | null }>('SELECT referred_by FROM users WHERE id = $1', [refereeId]);
  if (!u?.referred_by || u.referred_by === refereeId) return false;
  const { rowCount } = await c.query(
    `INSERT INTO referral_rewards (referrer_id, referee_id, payment_id, referrer_credits, referee_credits)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (referee_id) DO NOTHING`,
    [u.referred_by, refereeId, paymentId, config.REFERRAL_REFERRER_CREDITS, config.REFERRAL_REFEREE_CREDITS],
  );
  if (!rowCount) return false;
  if (config.REFERRAL_REFERRER_CREDITS > 0) {
    await addPurchasedCredits(u.referred_by, config.REFERRAL_REFERRER_CREDITS, {
      kind: 'purchase', refType: 'referral', refId: refereeId, idempotencyKey: `referral:referrer:${refereeId}`, note: 'Referral reward',
    }, c);
  }
  if (config.REFERRAL_REFEREE_CREDITS > 0) {
    await addPurchasedCredits(refereeId, config.REFERRAL_REFEREE_CREDITS, {
      kind: 'purchase', refType: 'referral', refId: u.referred_by, idempotencyKey: `referral:referee:${refereeId}`, note: 'Welcome bonus (referred)',
    }, c);
  }
  return true;
}

export const referralRoutes = Router();
referralRoutes.use(requireAuth);

referralRoutes.get('/', async (req, res) => {
  const { rows: [u] } = await pool.query<{ referral_code: string }>('SELECT referral_code FROM users WHERE id = $1', [req.user!.id]);
  const { rows: [stats] } = await pool.query<{ signups: number; rewarded: number; credits: number }>(
    `SELECT (SELECT count(*)::int FROM users WHERE referred_by = $1) AS signups,
            count(r.id)::int AS rewarded, COALESCE(sum(r.referrer_credits), 0)::int AS credits
       FROM referral_rewards r WHERE r.referrer_id = $1`,
    [req.user!.id],
  );
  res.json({
    code: u!.referral_code,
    link: `${config.PUBLIC_URL}/register?ref=${u!.referral_code}`,
    rewardCredits: config.REFERRAL_REFERRER_CREDITS,
    friendCredits: config.REFERRAL_REFEREE_CREDITS,
    ...stats,
  });
});
