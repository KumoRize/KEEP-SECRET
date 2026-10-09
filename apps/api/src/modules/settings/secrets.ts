import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config, decodeKey } from '../../config.js';
import { pool } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Provider credentials the owner can paste into the dashboard instead of editing server env.
 * Stored AES-256-GCM encrypted with SETTINGS_ENCRYPTION_KEY; plaintext is never returned to any client.
 * A value set in the server environment always wins and can't be changed from the dashboard.
 */
export const SECRET_NAMES = [
  'OPENROUTER_API_KEY', 'FAL_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'STABILITY_API_KEY', 'REPLICATE_API_TOKEN',
  'ELEVENLABS_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'RESEND_API_KEY',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'ALERT_WEBHOOK_URL',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

type Cfg = Record<SecretName, string | undefined>;
const cfg = config as unknown as Cfg;

/** Which secrets came from the process environment at boot (those are read-only in the dashboard). */
const FROM_ENV = new Set<SecretName>(SECRET_NAMES.filter((n) => Boolean(cfg[n])));
/** Names this process last applied from the database, so deletions can be undone in memory. */
const applied = new Set<SecretName>();

export const isSecretName = (n: string): n is SecretName => (SECRET_NAMES as readonly string[]).includes(n);
export const encryptionAvailable = () => Boolean(config.SETTINGS_ENCRYPTION_KEY && decodeKey(config.SETTINGS_ENCRYPTION_KEY));

function key(): Buffer {
  const k = config.SETTINGS_ENCRYPTION_KEY ? decodeKey(config.SETTINGS_ENCRYPTION_KEY) : null;
  if (!k) throw new AppError(503, 'encryption_unavailable', 'Set SETTINGS_ENCRYPTION_KEY on the server to save keys from the dashboard');
  return k;
}

export function encrypt(plain: string): { ciphertext: string; iv: string; tag: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return { ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
}

export function decrypt(row: { ciphertext: string; iv: string; tag: string }): string {
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(row.iv, 'base64'));
  d.setAuthTag(Buffer.from(row.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(row.ciphertext, 'base64')), d.final()]).toString('utf8');
}

/** Loads dashboard secrets into the live config (env-provided names are left untouched). */
export async function loadSecrets(): Promise<void> {
  const { rows } = await pool.query<{ name: string; ciphertext: string; iv: string; tag: string }>('SELECT name, ciphertext, iv, tag FROM app_secrets');
  const seen = new Set<SecretName>();
  for (const r of rows) {
    if (!isSecretName(r.name) || FROM_ENV.has(r.name)) continue;
    if (!encryptionAvailable()) break;
    try {
      cfg[r.name] = decrypt(r);
      seen.add(r.name);
    } catch {
      logger.error({ name: r.name }, 'could not decrypt stored secret (was SETTINGS_ENCRYPTION_KEY changed?)');
    }
  }
  for (const n of applied) if (!seen.has(n) && !FROM_ENV.has(n)) cfg[n] = undefined; // deleted elsewhere
  applied.clear();
  for (const n of seen) applied.add(n);
}

export async function saveSecret(name: SecretName, value: string, actorId: string): Promise<void> {
  if (FROM_ENV.has(name)) throw new AppError(409, 'set_in_env', `${name} is set in the server environment; change it there`);
  const enc = encrypt(value);
  await pool.query(
    `INSERT INTO app_secrets (name, ciphertext, iv, tag, last4, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (name) DO UPDATE SET ciphertext = $2, iv = $3, tag = $4, last4 = $5, updated_by = $6, updated_at = now()`,
    [name, enc.ciphertext, enc.iv, enc.tag, value.slice(-4), actorId],
  );
  cfg[name] = value;
  applied.add(name);
  await pool.query("SELECT pg_notify('settings_changed', $1)", [`secret:${name}`]);
  await pool.query('INSERT INTO audit_log (actor_id, action, target) VALUES ($1, $2, $3)', [actorId, 'secret.set', name]);
}

export async function deleteSecret(name: SecretName, actorId: string): Promise<void> {
  if (FROM_ENV.has(name)) throw new AppError(409, 'set_in_env', `${name} is set in the server environment; remove it there`);
  await pool.query('DELETE FROM app_secrets WHERE name = $1', [name]);
  cfg[name] = undefined;
  applied.delete(name);
  await pool.query("SELECT pg_notify('settings_changed', $1)", [`secret:${name}`]);
  await pool.query('INSERT INTO audit_log (actor_id, action, target) VALUES ($1, $2, $3)', [actorId, 'secret.delete', name]);
}

/** Status for the dashboard: never the value, only where it comes from and its last 4 characters. */
export async function secretStatus(): Promise<{ name: SecretName; source: 'env' | 'dashboard' | 'none'; last4: string | null; updatedAt: string | null }[]> {
  const { rows } = await pool.query<{ name: string; last4: string; updated_at: Date }>('SELECT name, last4, updated_at FROM app_secrets');
  const byName = new Map(rows.map((r) => [r.name, r]));
  return SECRET_NAMES.map((name) => {
    if (FROM_ENV.has(name)) return { name, source: 'env' as const, last4: cfg[name]!.slice(-4), updatedAt: null };
    const r = byName.get(name);
    return r ? { name, source: 'dashboard' as const, last4: r.last4, updatedAt: r.updated_at.toISOString() } : { name, source: 'none' as const, last4: null, updatedAt: null };
  });
}

/** Test hook: forget which names came from the environment. */
export function _resetEnvSnapshotForTests(): void {
  for (const n of SECRET_NAMES) if (!process.env[n]) FROM_ENV.delete(n);
}
