import { randomUUID } from 'node:crypto';
import { config, ownerEmail } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, conflict, unauthorized } from '../../lib/errors.js';
import { signAccessToken } from '../../middleware/auth.js';
import { PLANS } from '../billing/plans.js';
import { resetSubscriptionCredits } from '../billing/wallet.js';
import { logger } from '../../lib/logger.js';
import { sendVerificationEmail } from './emailTokens.js';
import { newReferralCode } from '../billing/referrals.js';
import { settings } from '../settings/settings.js';

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  role: string;
  plan_id: string;
}

export interface Session {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

const adminEmails = () => config.ADMIN_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

function roleFor(email: string): 'owner' | 'admin' | 'user' {
  const e = email.toLowerCase();
  if (e === ownerEmail()) return 'owner';
  return adminEmails().includes(e) ? 'admin' : 'user';
}

/**
 * Creating the owner account requires OWNER_SETUP_CODE, so knowing the owner's email isn't enough to
 * claim ownership before they sign up. Required in production; optional in development and tests.
 */
function assertOwnerSetupCode(code: string | undefined): void {
  if (!config.OWNER_SETUP_CODE) {
    if (config.NODE_ENV === 'production') {
      throw new AppError(403, 'owner_setup_code_required', 'Set OWNER_SETUP_CODE on the server, then sign up with it to claim ownership');
    }
    return;
  }
  if (!code || !safeEqual(sha256(code), sha256(config.OWNER_SETUP_CODE))) {
    throw new AppError(403, 'owner_setup_code_invalid', 'This email is reserved. Enter the owner setup code to continue.');
  }
}

/**
 * Startup: makes the OWNER_EMAIL account the one and only owner (if it has registered).
 * Any other owner (e.g. after changing OWNER_EMAIL) is demoted to admin.
 */
export async function ensureOwner(): Promise<string | null> {
  const email = ownerEmail();
  if (!email) return null;
  return tx(async (c) => {
    const { rows } = await c.query<{ id: string }>('SELECT id FROM users WHERE lower(email) = $1', [email]);
    if (!rows[0]) return null;
    await c.query(`UPDATE users SET role = 'admin' WHERE role = 'owner' AND id <> $1`, [rows[0].id]);
    await c.query(`UPDATE users SET role = 'owner', status = 'active' WHERE id = $1`, [rows[0].id]);
    return rows[0].id;
  });
}

// Burn comparable CPU when the email is unknown so response timing does not reveal registered emails.
let dummyHash: Promise<string> | null = null;

export async function register(email: string, password: string, name: string, referralCode?: string, setupCode?: string): Promise<Session> {
  const role = roleFor(email);
  if (role === 'owner') assertOwnerSetupCode(setupCode);
  const site = settings().site;
  // The owner can always create their account, even with sign-ups closed or during maintenance.
  if (role !== 'owner' && (!site.signupsOpen || site.maintenance)) {
    throw new AppError(403, 'signups_closed', site.maintenance ? site.maintenanceMessage : 'Sign-ups are closed right now. Please check back soon.');
  }
  const passwordHash = await hashPassword(password);
  try {
    const user = await tx(async (c) => {
      // Unknown referral codes are ignored rather than failing sign-up.
      const referrer = referralCode
        ? (await c.query<{ id: string }>('SELECT id FROM users WHERE referral_code = $1', [referralCode.toUpperCase()])).rows[0]?.id ?? null
        : null;
      // One owner at a time: a new OWNER_EMAIL sign-up takes over ownership.
      if (role === 'owner') await c.query(`UPDATE users SET role = 'admin' WHERE role = 'owner'`);
      const { rows } = await c.query<PublicUser>(
        `INSERT INTO users (email, password_hash, name, role, referral_code, referred_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, email, name, role, plan_id`,
        [email.toLowerCase(), passwordHash, name, role, newReferralCode(), referrer],
      );
      const u = rows[0]!;
      const cycle = new Date().toISOString().slice(0, 7);
      await resetSubscriptionCredits(u.id, PLANS.free.monthlyCredits, `free:${u.id}:${cycle}`, c);
      await c.query("UPDATE users SET plan_renews_at = date_trunc('month', now()) + interval '1 month' WHERE id = $1", [u.id]);
      return u;
    });
    // Registration must not fail because the mail provider is down; the user can resend from the app.
    await sendVerificationEmail(user).catch((err) => logger.error({ err }, 'verification email failed'));
    return { user, ...(await issueTokens(user.id)) };
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'users_email_uq') throw conflict('An account with this email already exists');
    throw err;
  }
}

export async function login(email: string, password: string): Promise<Session> {
  const { rows } = await pool.query<PublicUser & { password_hash: string; status: string }>(
    'SELECT id, email, name, role, plan_id, password_hash, status FROM users WHERE lower(email) = lower($1)',
    [email],
  );
  const row = rows[0];
  if (!row) {
    dummyHash ??= hashPassword('timing-equaliser');
    await verifyPassword(password, await dummyHash);
    throw unauthorized('Invalid email or password');
  }
  if (!(await verifyPassword(password, row.password_hash))) throw unauthorized('Invalid email or password');
  if (row.status !== 'active') throw new AppError(403, 'account_inactive', 'Account suspended');
  const { password_hash: _ph, status: _s, ...user } = row;
  return { user, ...(await issueTokens(user.id)) };
}

async function issueTokens(userId: string, familyId: string = randomUUID()) {
  const refreshToken = randomToken(48);
  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
    [userId, sha256(refreshToken), familyId, config.REFRESH_TOKEN_TTL_DAYS],
  );
  return { accessToken: signAccessToken(userId), refreshToken };
}

/** Rotates the refresh token. Reuse of a rotated token revokes the whole family (likely theft). */
export async function refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const hash = sha256(refreshToken);
  const result = await tx(async (c) => {
    const { rows } = await c.query<{ id: string; user_id: string; family_id: string; revoked_at: Date | null; expires_at: Date; status: string }>(
      `SELECT rt.id, rt.user_id, rt.family_id, rt.revoked_at, rt.expires_at, u.status
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1 FOR UPDATE OF rt`,
      [hash],
    );
    const rt = rows[0];
    if (!rt) throw unauthorized('Invalid session');
    if (rt.revoked_at) {
      // Committed (not thrown) so the family revocation survives the transaction.
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [rt.family_id]);
      return null;
    }
    if (rt.expires_at < new Date() || rt.status !== 'active') throw unauthorized('Session expired');
    const next = randomToken(48);
    const { rows: [created] } = await c.query<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(days => $4)) RETURNING id`,
      [rt.user_id, sha256(next), rt.family_id, config.REFRESH_TOKEN_TTL_DAYS],
    );
    await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [rt.id, created!.id]);
    return { accessToken: signAccessToken(rt.user_id), refreshToken: next };
  });
  if (!result) throw unauthorized('Session revoked');
  return result;
}

export async function logout(refreshToken: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL`,
    [sha256(refreshToken)],
  );
}
