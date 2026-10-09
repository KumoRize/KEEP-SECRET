import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { requireAuth, requireOwner } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { deleteSecret, encryptionAvailable, isSecretName, saveSecret, secretStatus } from './secrets.js';
import { setupChecklist, testSecret } from './setup.js';
import { defaultSettings, resetSection, saveSection, SECTIONS, settings, type SectionName } from './settings.js';

/** Everything here is owner-only: money, keys and switches for the whole platform. */
export const ownerRoutes = Router();
ownerRoutes.use(requireAuth, requireOwner);

const section = (v: unknown): SectionName => {
  const s = parse(z.string(), v);
  if (!(s in SECTIONS)) throw badRequest('Unknown settings section');
  return s as SectionName;
};

ownerRoutes.get('/setup', async (_req, res) => {
  res.json(await setupChecklist());
});

ownerRoutes.get('/settings', (_req, res) => {
  res.json({ settings: settings(), defaults: defaultSettings() });
});

ownerRoutes.put('/settings/:section', async (req, res) => {
  const key = section(req.params.section);
  const saved = await saveSection(key, req.body, req.user!.id);
  await pool.query('INSERT INTO audit_log (actor_id, action, target, meta) VALUES ($1, $2, $3, $4)', [req.user!.id, 'settings.update', key, saved]);
  res.json({ [key]: saved });
});

ownerRoutes.delete('/settings/:section', async (req, res) => {
  await resetSection(section(req.params.section), req.user!.id);
  res.json({ settings: settings() });
});

ownerRoutes.get('/keys', async (_req, res) => {
  res.json({ items: await secretStatus(), encryptionAvailable: encryptionAvailable() });
});

ownerRoutes.put('/keys/:name', async (req, res) => {
  const name = parse(z.string(), req.params.name);
  if (!isSecretName(name)) throw badRequest('Unknown key name');
  const { value } = parse(z.object({ value: z.string().trim().min(4).max(500) }), req.body);
  await saveSecret(name, value, req.user!.id);
  res.json({ ok: true, test: await testSecret(name) });
});

ownerRoutes.delete('/keys/:name', async (req, res) => {
  const name = parse(z.string(), req.params.name);
  if (!isSecretName(name)) throw badRequest('Unknown key name');
  await deleteSecret(name, req.user!.id);
  res.status(204).end();
});

ownerRoutes.post('/keys/:name/test', async (req, res) => {
  const name = parse(z.string(), req.params.name);
  if (!isSecretName(name)) throw badRequest('Unknown key name');
  res.json(await testSecret(name));
});

/** Public, unauthenticated: what every visitor's app shell needs to know. */
export const siteRoutes = Router();
siteRoutes.get('/', (_req, res) => {
  const s = settings();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    appName: s.business.appName, announcement: s.site.announcement, maintenance: s.site.maintenance,
    maintenanceMessage: s.site.maintenanceMessage, signupsOpen: s.site.signupsOpen,
  });
});
