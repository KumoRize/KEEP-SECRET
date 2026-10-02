import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { requireAuth } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { storage } from '../storage/storage.js';

export const libraryRoutes = Router();
libraryRoutes.use(requireAuth);

libraryRoutes.get('/projects', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.created_at, count(g.id)::int AS generation_count
       FROM projects p LEFT JOIN generations g ON g.project_id = p.id
      WHERE p.user_id = $1 GROUP BY p.id ORDER BY p.created_at DESC`,
    [req.user!.id],
  );
  res.json({ items: rows });
});

libraryRoutes.post('/projects', async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  const { rows } = await pool.query('INSERT INTO projects (user_id, name) VALUES ($1, $2) RETURNING id, name, created_at', [req.user!.id, name]);
  res.status(201).json(rows[0]);
});

libraryRoutes.patch('/projects/:id', async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
  const { rows } = await pool.query('UPDATE projects SET name = $3 WHERE id = $1 AND user_id = $2 RETURNING id, name, created_at',
    [parse(z.uuid(), req.params.id), req.user!.id, name]);
  if (!rows[0]) throw notFound();
  res.json(rows[0]);
});

libraryRoutes.delete('/projects/:id', async (req, res) => {
  // Generations are kept (project_id set NULL) so nothing paid-for is lost.
  const { rowCount } = await pool.query('DELETE FROM projects WHERE id = $1 AND user_id = $2', [parse(z.uuid(), req.params.id), req.user!.id]);
  if (!rowCount) throw notFound();
  res.status(204).end();
});

libraryRoutes.post('/generations/:id/move', async (req, res) => {
  const { projectId } = parse(z.object({ projectId: z.uuid().nullable() }), req.body);
  if (projectId) {
    const { rowCount } = await pool.query('SELECT 1 FROM projects WHERE id = $1 AND user_id = $2', [projectId, req.user!.id]);
    if (!rowCount) throw notFound('Project not found');
  }
  const { rowCount } = await pool.query('UPDATE generations SET project_id = $3 WHERE id = $1 AND user_id = $2',
    [parse(z.uuid(), req.params.id), req.user!.id, projectId]);
  if (!rowCount) throw notFound();
  res.json({ ok: true });
});

libraryRoutes.delete('/assets/:id', async (req, res) => {
  const { rows } = await pool.query<{ storage_key: string }>(
    'DELETE FROM assets WHERE id = $1 AND user_id = $2 RETURNING storage_key', [parse(z.uuid(), req.params.id), req.user!.id],
  );
  if (!rows[0]) throw notFound();
  await storage.delete(rows[0].storage_key);
  res.status(204).end();
});

libraryRoutes.get('/usage', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT modality, count(*)::int AS generations, COALESCE(sum(charged_credits), 0)::int AS credits
       FROM generations WHERE user_id = $1 AND status = 'succeeded' AND created_at >= now() - interval '30 days'
      GROUP BY modality ORDER BY credits DESC`,
    [req.user!.id],
  );
  const { rows: [storageRow] } = await pool.query<{ bytes: number }>(
    'SELECT COALESCE(sum(size_bytes), 0)::bigint AS bytes FROM assets WHERE user_id = $1', [req.user!.id],
  );
  res.json({ last30Days: rows, storageBytes: storageRow!.bytes });
});
