import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';

export const KEY_PREFIX = 'sk_live_';
const MAX_KEYS = 10;

export const developerRoutes = Router();
developerRoutes.use(requireAuth);

developerRoutes.get('/keys', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, prefix, last_used_at, created_at FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC',
    [req.user!.id],
  );
  res.json({ items: rows });
});

/** Creates a key; the full secret is returned only in this response. Keys act as the user and spend their credits. */
developerRoutes.post('/keys', async (req, res) => {
  if (req.user!.viaApiKey) throw badRequest('API keys cannot create other API keys');
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(60) }), req.body);
  const { rows: [count] } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL', [req.user!.id]);
  if (count!.n >= MAX_KEYS) throw badRequest(`You can have at most ${MAX_KEYS} active keys`);
  const key = `${KEY_PREFIX}${randomToken(32)}`;
  const { rows: [row] } = await pool.query(
    'INSERT INTO api_keys (user_id, name, prefix, key_hash) VALUES ($1,$2,$3,$4) RETURNING id, name, prefix, created_at',
    [req.user!.id, name, key.slice(0, KEY_PREFIX.length + 6), sha256(key)],
  );
  res.status(201).json({ ...row, key });
});

developerRoutes.delete('/keys/:id', async (req, res) => {
  const { rowCount } = await pool.query(
    'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [parse(z.uuid(), req.params.id), req.user!.id],
  );
  if (!rowCount) throw notFound('Key not found');
  res.status(204).end();
});
