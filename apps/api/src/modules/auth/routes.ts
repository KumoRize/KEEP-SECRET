import { Router, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { badRequest, unauthorized } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rateLimit.js';
import { parse } from '../../middleware/validate.js';
import { getBalance } from '../billing/wallet.js';
import { getPlan } from '../billing/plans.js';
import * as auth from './service.js';

const COOKIE = 'rt';
const credentials = z.object({
  email: z.email().max(254),
  password: z.string().min(10, 'Password must be at least 10 characters').max(200),
});

function setRefreshCookie(res: Response, token: string) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

// Cookie-authenticated endpoints require a custom header that cross-site forms cannot send.
function requireCsrfHeader(h: string | undefined) {
  if (h !== '1') throw badRequest('Missing X-Requested-With header');
}

export const authRoutes = Router();
const authLimiter = rateLimit({ name: 'auth', limit: 10, windowSec: 60, key: (req) => `${req.ip}:${String(req.body?.email ?? '').toLowerCase()}` });

authRoutes.post('/register', authLimiter, async (req, res) => {
  const body = parse(credentials.extend({ name: z.string().trim().max(80).default('') }), req.body);
  const s = await auth.register(body.email, body.password, body.name);
  setRefreshCookie(res, s.refreshToken);
  res.status(201).json({ user: s.user, accessToken: s.accessToken });
});

authRoutes.post('/login', authLimiter, async (req, res) => {
  const body = parse(credentials.extend({ password: z.string().min(1).max(200) }), req.body);
  const s = await auth.login(body.email, body.password);
  setRefreshCookie(res, s.refreshToken);
  res.json({ user: s.user, accessToken: s.accessToken });
});

authRoutes.post('/refresh', rateLimit({ name: 'refresh', limit: 30, windowSec: 60 }), async (req, res) => {
  requireCsrfHeader(req.header('x-requested-with'));
  const token = req.cookies?.[COOKIE];
  if (!token) throw unauthorized('No session');
  const s = await auth.refresh(token);
  setRefreshCookie(res, s.refreshToken);
  res.json({ accessToken: s.accessToken });
});

authRoutes.post('/logout', async (req, res) => {
  requireCsrfHeader(req.header('x-requested-with'));
  const token = req.cookies?.[COOKIE];
  if (token) await auth.logout(token);
  res.clearCookie(COOKIE, { path: '/api/v1/auth' });
  res.status(204).end();
});

authRoutes.get('/me', requireAuth, async (req, res) => {
  const u = req.user!;
  res.json({ user: { id: u.id, email: u.email, role: u.role, plan: getPlan(u.plan_id) }, balance: await getBalance(u.id) });
});
