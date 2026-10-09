import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { sha256 } from '../lib/crypto.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { settings } from '../modules/settings/settings.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin' | 'owner';
  plan_id: string;
  status: string;
  email_verified_at: Date | null;
  /** True when the request authenticated with a developer API key instead of a session. */
  viaApiKey?: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId, typ: 'access' }, config.JWT_SECRET, { expiresIn: config.ACCESS_TOKEN_TTL_SEC, algorithm: 'HS256' });
}

/** Verifies the bearer token and reloads the user so suspensions and role changes apply immediately. */
export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw unauthorized();
  // Developer API keys: 'Bearer sk_live_...'. Only the hash is stored.
  if (header.startsWith('Bearer sk_live_')) {
    const { rows } = await pool.query<AuthUser & { key_id: string }>(
      `SELECT u.id, u.email, u.role, u.plan_id, u.status, u.email_verified_at, k.id AS key_id
         FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [sha256(header.slice(7).trim())],
    );
    const row = rows[0];
    if (!row) throw unauthorized('Invalid API key');
    if (row.status !== 'active') throw forbidden('Account suspended');
    // Admin powers are never available through API keys.
    const { key_id: keyId, ...user } = row;
    const site = settings().site;
    if (site.maintenance) throw new AppError(503, 'maintenance', site.maintenanceMessage);
    req.user = { ...user, role: 'user', viaApiKey: true };
    void pool.query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`, [keyId]);
    return next();
  }
  let sub: string;
  try {
    const payload = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw new Error('bad token');
    sub = payload.sub;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const { rows } = await pool.query<AuthUser>('SELECT id, email, role, plan_id, status, email_verified_at FROM users WHERE id = $1', [sub]);
  const user = rows[0];
  if (!user) throw unauthorized();
  if (user.status !== 'active') throw forbidden('Account suspended');
  // Maintenance mode: customers wait, the owner and staff keep working.
  const site = settings().site;
  if (site.maintenance && user.role === 'user') throw new AppError(503, 'maintenance', site.maintenanceMessage);
  req.user = user;
  next();
}

/** Owner or staff admin. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin' && req.user?.role !== 'owner') throw forbidden('Admin only');
  next();
}

/** The platform owner only: money, settings, keys, roles. */
export function requireOwner(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'owner') throw forbidden('Owner only');
  next();
}
