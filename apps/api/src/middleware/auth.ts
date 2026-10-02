import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
  plan_id: string;
  status: string;
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
  let sub: string;
  try {
    const payload = jwt.verify(header.slice(7), config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
    if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw new Error('bad token');
    sub = payload.sub;
  } catch {
    throw unauthorized('Invalid or expired token');
  }
  const { rows } = await pool.query<AuthUser>('SELECT id, email, role, plan_id, status FROM users WHERE id = $1', [sub]);
  const user = rows[0];
  if (!user) throw unauthorized();
  if (user.status !== 'active') throw forbidden('Account suspended');
  req.user = user;
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.role !== 'admin') throw forbidden('Admin only');
  next();
}
