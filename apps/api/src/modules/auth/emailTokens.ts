import type { PoolClient } from 'pg';
import { config } from '../../config.js';
import { pool, tx } from '../../db/pool.js';
import { hashPassword, randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, badRequest } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { mailer } from '../../lib/mailer.js';

type Kind = 'verify_email' | 'reset_password';
const TTL_MINUTES: Record<Kind, number> = { verify_email: 24 * 60, reset_password: 60 };

async function issue(userId: string, kind: Kind): Promise<string> {
  const token = randomToken(32);
  // Only the newest link of each kind stays valid.
  await pool.query('UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL', [userId, kind]);
  await pool.query(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at) VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [userId, kind, sha256(token), TTL_MINUTES[kind]],
  );
  return token;
}

/** Marks a token used and returns its user id; rejects unknown, expired or already-used tokens. */
async function consume(c: PoolClient, token: string, kind: Kind): Promise<string> {
  const { rows } = await c.query<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = now()
      WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), kind],
  );
  if (!rows[0]) throw new AppError(400, 'invalid_token', 'This link is invalid or has expired');
  return rows[0].user_id;
}

export async function sendVerificationEmail(user: { id: string; email: string }): Promise<void> {
  const token = await issue(user.id, 'verify_email');
  await mailer.send({
    to: user.email,
    subject: 'Verify your email',
    text: `Confirm your email address to start creating:\n\n${config.PUBLIC_URL}/verify-email?token=${token}\n\nThis link expires in 24 hours.`,
  });
}

export async function verifyEmail(token: string): Promise<void> {
  await tx(async (c) => {
    const userId = await consume(c, token, 'verify_email');
    await c.query('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId]);
  });
}

/** Always resolves the same way whether or not the email exists, so it cannot be used to probe accounts. */
export async function requestPasswordReset(email: string): Promise<void> {
  const { rows } = await pool.query<{ id: string; email: string }>(
    `SELECT id, email FROM users WHERE lower(email) = lower($1) AND status = 'active'`, [email],
  );
  const user = rows[0];
  if (!user) return;
  const token = await issue(user.id, 'reset_password');
  await mailer.send({
    to: user.email,
    subject: 'Reset your password',
    text: `Use this link to choose a new password:\n\n${config.PUBLIC_URL}/reset-password?token=${token}\n\n` +
      'It expires in 1 hour. If you did not ask for this, you can ignore this email.',
  }).catch((err) => logger.error({ err }, 'password reset email failed'));
}

export async function resetPassword(token: string, password: string): Promise<void> {
  if (password.length < 10) throw badRequest('Password must be at least 10 characters');
  const hash = await hashPassword(password);
  await tx(async (c) => {
    const userId = await consume(c, token, 'reset_password');
    // Receiving the link proves control of the inbox, so the email counts as verified.
    await c.query('UPDATE users SET password_hash = $2, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1', [userId, hash]);
    // Sign out every existing session, in case the old password was compromised.
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  });
}
