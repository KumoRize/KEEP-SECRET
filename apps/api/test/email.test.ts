import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { consoleOutbox } from '../src/lib/mailer.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function lastLink(to: string, path: string): string {
  const mail = [...consoleOutbox!].reverse().find((m) => m.to === to && m.text.includes(path));
  const match = mail?.text.match(/token=([\w-]+)/);
  if (!match) throw new Error(`no ${path} email for ${to}`);
  return match[1]!;
}

async function signup() {
  const email = `e${randomUUID()}@example.com`;
  const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'a-strong-password' });
  expect(res.status).toBe(201);
  return { email, token: res.body.accessToken as string, userId: res.body.user.id as string, cookie: res.headers['set-cookie']![0]!.split(';')[0]! };
}

async function tryGenerate(token: string, prompt = 'A photo of a mountain lake') {
  const q = await request(app).post('/api/v1/generations/estimate').set(auth(token)).send({ prompt });
  return request(app).post('/api/v1/generations').set(auth(token)).set('Idempotency-Key', randomUUID())
    .send({ prompt, quoteToken: q.body.quoteToken });
}

describe('email verification', () => {
  beforeAll(() => { config.REQUIRE_EMAIL_VERIFICATION = true; });
  afterAll(() => { config.REQUIRE_EMAIL_VERIFICATION = false; });

  it('blocks generation until the emailed link is used, once', async () => {
    const s = await signup();
    const blocked = await tryGenerate(s.token);
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('email_not_verified');

    const token = lastLink(s.email, '/verify-email');
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token })).status).toBe(400); // single use
    expect((await request(app).get('/api/v1/auth/me').set(auth(s.token))).body.user.emailVerified).toBe(true);
    expect((await tryGenerate(s.token)).status).toBe(202);
  });

  it('resending invalidates the previous link', async () => {
    const s = await signup();
    const first = lastLink(s.email, '/verify-email');
    expect((await request(app).post('/api/v1/auth/verify-email/resend').set(auth(s.token))).status).toBe(202);
    const second = lastLink(s.email, '/verify-email');
    expect(second).not.toBe(first);
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token: first })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/verify-email').send({ token: second })).status).toBe(200);
  });
});

describe('password reset', () => {
  it('gives the same response for unknown emails and sends nothing', async () => {
    const before = consoleOutbox!.length;
    const res = await request(app).post('/api/v1/auth/password/forgot').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(202);
    expect(consoleOutbox!.length).toBe(before);
  });

  it('resets the password, signs out old sessions and is single use', async () => {
    const s = await signup();
    expect((await request(app).post('/api/v1/auth/password/forgot').send({ email: s.email.toUpperCase() })).status).toBe(202);
    const token = lastLink(s.email, '/reset-password');

    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'short' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'a-new-strong-password' })).status).toBe(200);
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'another-password-1' })).status).toBe(400);

    expect((await request(app).post('/api/v1/auth/login').send({ email: s.email, password: 'a-strong-password' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: s.email, password: 'a-new-strong-password' })).status).toBe(200);
    const refresh = await request(app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', '1');
    expect(refresh.status).toBe(401);
  });

  it('rejects expired links', async () => {
    const s = await signup();
    await request(app).post('/api/v1/auth/password/forgot').send({ email: s.email });
    const token = lastLink(s.email, '/reset-password');
    await pool.query(`UPDATE auth_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [s.userId]);
    expect((await request(app).post('/api/v1/auth/password/reset').send({ token, password: 'a-new-strong-password' })).status).toBe(400);
  });
});

describe('storage quota', () => {
  it('blocks new generations once the plan storage limit is reached', async () => {
    const s = await signup();
    const { rows: [g] } = await pool.query<{ id: string }>(
      `INSERT INTO generations (user_id, prompt, modality, held_credits, idempotency_key, status) VALUES ($1,'p','image',0,'q','succeeded') RETURNING id`,
      [s.userId],
    );
    await pool.query(
      `INSERT INTO assets (user_id, generation_id, storage_key, filename, content_type, size_bytes) VALUES ($1,$2,'k','f.png','image/png',$3)`,
      [s.userId, g!.id, 1024 ** 3], // free plan: 1 GB
    );
    const res = await tryGenerate(s.token);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('storage_full');
    const usage = await request(app).get('/api/v1/library/usage').set(auth(s.token));
    expect(usage.body).toMatchObject({ storageBytes: 1024 ** 3, storageLimitBytes: 1024 ** 3 });
  });
});
