import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, conflict, unauthorized } from '../../lib/errors.js';
import { signAccessToken } from '../../middleware/auth.js';
import { PLANS } from '../billing/plans.js';
import { resetSubscriptionCredits } from '../billing/wallet.js';
import { logger } from '../../lib/logger.js';
import { sendVerificationEmail } from './emailTokens.js';

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

// Burn comparable CPU when the email is unknown so response timing does not reveal registered emails.
let dummyHash: Promise<string> | null = null;

export async function register(email: string, password: string, name: string): Promise<Session> {
  const passwordHash = await hashPassword(password);
  const role = adminEmails().includes(email.toLowerCase()) ? 'admin' : 'user';
  try {
    const user = await tx(async (c) => {
      const { rows } = await c.query<PublicUser>(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role, plan_id',
        [email.toLowerCase(), passwordHash, name, role],
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
    if ((err as { code?: string }).code === '23505') throw conflict('An account with this email already exists');
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
