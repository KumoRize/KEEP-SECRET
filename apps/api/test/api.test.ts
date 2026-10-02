import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { claimNext, processGeneration } from '../src/modules/generations/worker.js';
import { invalidateProviderSettings, registerAdapter } from '../src/modules/providers/registry.js';
import { ProviderError, type ProviderAdapter } from '../src/modules/providers/types.js';

const app = createApp();

async function signup(email = `u${randomUUID()}@example.com`) {
  const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'a-strong-password' });
  expect(res.status).toBe(201);
  const cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
  return { token: res.body.accessToken as string, user: res.body.user as { id: string }, cookie, email };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function estimate(token: string, body: object) {
  return request(app).post('/api/v1/generations/estimate').set(auth(token)).send(body);
}

async function generate(token: string, prompt: string, extra: object = {}, key = randomUUID()) {
  const q = await estimate(token, { prompt, ...extra });
  expect(q.status).toBe(200);
  return request(app).post('/api/v1/generations').set(auth(token)).set('Idempotency-Key', key)
    .send({ prompt, quoteToken: q.body.quoteToken });
}

async function runWorkerOnce() {
  const job = await claimNext();
  expect(job).not.toBeNull();
  return processGeneration(job!);
}

async function balance(token: string) {
  return (await request(app).get('/api/v1/auth/me').set(auth(token))).body.balance.total as number;
}

// A provider that is always down, ranked ahead of mock, to exercise fallback.
let flakyCalls = 0;
const flaky: ProviderAdapter = {
  id: 'flaky', name: 'Flaky', isConfigured: () => true,
  models: () => [{
    id: 'flaky:img', providerId: 'flaky', model: 'img', modality: 'image', label: 'Flaky', quality: 10,
    license: { commercialUse: true, note: 'test' }, estimateCostUsd: () => 0.01,
  }],
  run: async () => { flakyCalls++; throw new ProviderError('flaky: 503', 'retriable'); },
};

beforeAll(async () => {
  registerAdapter(flaky);
  await pool.query(`INSERT INTO provider_settings (provider_id, enabled, priority) VALUES ('flaky', false, 1)`);
  invalidateProviderSettings();
});

describe('auth', () => {
  it('registers with 60 free credits and rejects duplicate emails', async () => {
    const s = await signup();
    expect(await balance(s.token)).toBe(60);
    const dup = await request(app).post('/api/v1/auth/register').send({ email: s.email.toUpperCase(), password: 'a-strong-password' });
    expect(dup.status).toBe(409);
  });

  it('rejects weak passwords and bad credentials', async () => {
    expect((await request(app).post('/api/v1/auth/register').send({ email: 'x@example.com', password: 'short' })).status).toBe(400);
    const s = await signup();
    expect((await request(app).post('/api/v1/auth/login').send({ email: s.email, password: 'wrong-password' })).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: s.email, password: 'a-strong-password' })).status).toBe(200);
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const s = await signup();
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', s.cookie)).status).toBe(400); // no CSRF header
    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', '1');
    expect(r1.status).toBe(200);
    const next = r1.headers['set-cookie']![0]!.split(';')[0]!;
    const reuse = await request(app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set('X-Requested-With', '1');
    expect(reuse.status).toBe(401);
    // The legitimately rotated token is now revoked too.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', next).set('X-Requested-With', '1')).status).toBe(401);
  });

  it('requires a valid bearer token', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(auth('garbage'))).status).toBe(401);
  });
});

describe('orchestrator + generations', () => {
  it('auto-detects modality and returns a credit estimate', async () => {
    const s = await signup();
    const q = await estimate(s.token, { prompt: 'Landing page for a vegan bakery' });
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ modality: 'website', provider: { modelId: 'mock:website' }, estimatedCredits: 1, maxCredits: 1 });
    expect(q.body.quoteToken).toBeTypeOf('string');
    expect(JSON.stringify(q.body)).not.toMatch(/api[_-]?key|secret/i);
  });

  it('generates, stores assets, and charges credits', async () => {
    const s = await signup();
    const res = await generate(s.token, 'A poster of a retro robot');
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', modality: 'image', heldCredits: 1 });
    expect(await balance(s.token)).toBe(59);

    const done = await runWorkerOnce();
    expect(done?.status).toBe('succeeded');
    const g = await request(app).get(`/api/v1/generations/${res.body.id}`).set(auth(s.token));
    expect(g.body).toMatchObject({ status: 'succeeded', chargedCredits: 1, provider: 'mock' });
    expect(g.body.assets).toHaveLength(1);
    expect(await balance(s.token)).toBe(59);

    // Signed file URL works and is sandboxed; a tampered one does not.
    const url = new URL(g.body.assets[0].previewUrl);
    const file = await request(app).get(url.pathname);
    expect(file.status).toBe(200);
    expect(file.headers['content-security-policy']).toMatch(/sandbox/);
    expect((await request(app).get(url.pathname.slice(0, -2) + 'xx')).status).toBe(404);
  });

  it('is idempotent per Idempotency-Key', async () => {
    const s = await signup();
    const q = await estimate(s.token, { prompt: 'A photo of a red fox' });
    const send = () => request(app).post('/api/v1/generations').set(auth(s.token)).set('Idempotency-Key', 'same-key')
      .send({ prompt: 'A photo of a red fox', quoteToken: q.body.quoteToken });
    const [a, b] = [await send(), await send()];
    expect(a.status).toBe(202);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(await balance(s.token)).toBe(59);
    await runWorkerOnce();
  });

  it('rejects a quote reused for a different prompt or user', async () => {
    const a = await signup();
    const b = await signup();
    const q = await estimate(a.token, { prompt: 'A photo of a lighthouse' });
    const changed = await request(app).post('/api/v1/generations').set(auth(a.token)).set('Idempotency-Key', randomUUID())
      .send({ prompt: 'Something else entirely', quoteToken: q.body.quoteToken });
    expect(changed.status).toBe(400);
    const stolen = await request(app).post('/api/v1/generations').set(auth(b.token)).set('Idempotency-Key', randomUUID())
      .send({ prompt: 'A photo of a lighthouse', quoteToken: q.body.quoteToken });
    expect(stolen.status).toBe(400);
  });

  it('refunds credits in full when every provider fails', async () => {
    const s = await signup();
    await generate(s.token, 'A photo of a bridge [mock:fail]');
    expect(await balance(s.token)).toBe(59);
    const done = await runWorkerOnce();
    expect(done).toMatchObject({ status: 'failed', charged_credits: 0 });
    expect(await balance(s.token)).toBe(60);
  });

  it('does not fall back when a provider rejects the content', async () => {
    const s = await signup();
    await generate(s.token, 'A photo of something [mock:reject]');
    const done = await runWorkerOnce();
    expect(done?.status).toBe('failed');
    expect(done?.error).toMatch(/declined/);
    expect(await balance(s.token)).toBe(60);
  });

  it('falls back to the next provider on outage', async () => {
    await pool.query(`UPDATE provider_settings SET enabled = true WHERE provider_id = 'flaky'`);
    invalidateProviderSettings();
    try {
      const s = await signup();
      const q = await estimate(s.token, { prompt: 'An illustration of a whale' });
      expect(q.body.provider.modelId).toBe('flaky:img');
      expect(q.body.fallbacks.map((f: { modelId: string }) => f.modelId)).toContain('mock:image');
      await request(app).post('/api/v1/generations').set(auth(s.token)).set('Idempotency-Key', randomUUID())
        .send({ prompt: 'An illustration of a whale', quoteToken: q.body.quoteToken });
      const before = flakyCalls;
      const done = await runWorkerOnce();
      expect(flakyCalls).toBe(before + 1);
      expect(done).toMatchObject({ status: 'succeeded', provider_id: 'mock' });
      expect(done!.attempts.map((a) => a.ok)).toEqual([false, true]);
      // Held max(flaky=6, mock=1) credits, charged the mock price, refunded the rest.
      expect(await balance(s.token)).toBe(59);
    } finally {
      await pool.query(`UPDATE provider_settings SET enabled = false WHERE provider_id = 'flaky'`);
      invalidateProviderSettings();
    }
  });

  it('enforces plan modality gating and concurrency', async () => {
    const s = await signup();
    const video = await estimate(s.token, { prompt: 'A 5 second video of rain' });
    expect(video.status).toBe(403);
    expect(video.body.error.code).toBe('plan_upgrade_required');

    await generate(s.token, 'A picture of a cat');
    const second = await generate(s.token, 'A picture of a dog');
    expect(second.status).toBe(429); // free plan: 1 concurrent
    await runWorkerOnce();
  });

  it('enforces duration limits for paid plans', async () => {
    const s = await signup();
    await pool.query(`UPDATE users SET plan_id = 'starter' WHERE id = $1`, [s.user.id]);
    expect((await estimate(s.token, { prompt: 'video of a sunrise', params: { durationSec: 8 } })).status).toBe(403);
    const ok = await estimate(s.token, { prompt: 'video of a sunrise', params: { durationSec: 5 } });
    expect(ok.status).toBe(200);
    expect(ok.body.params.durationSec).toBe(5);
  });

  it('refuses generation with insufficient credits', async () => {
    const s = await signup();
    await pool.query('UPDATE wallets SET subscription_balance = 0 WHERE user_id = $1', [s.user.id]);
    const res = await generate(s.token, 'A drawing of a castle');
    expect(res.status).toBe(402);
  });

  it('lets users cancel queued jobs with a refund', async () => {
    const s = await signup();
    const res = await generate(s.token, 'A painting of a meadow');
    const c = await request(app).post(`/api/v1/generations/${res.body.id}/cancel`).set(auth(s.token));
    expect(c.body.status).toBe('canceled');
    expect(await balance(s.token)).toBe(60);
  });

  it('isolates users from each other', async () => {
    const a = await signup();
    const b = await signup();
    const res = await generate(a.token, 'A sketch of a bicycle');
    expect((await request(app).get(`/api/v1/generations/${res.body.id}`).set(auth(b.token))).status).toBe(404);
    await runWorkerOnce();
  });
});

describe('payments', () => {
  const sign = (body: string) => createHmac('sha256', 'rzp_webhook_secret').update(body).digest('hex');

  it('fulfils credit packs once via webhook and checkout verification', async () => {
    const s = await signup();
    await pool.query(
      `INSERT INTO payments (user_id, kind, item_id, amount_paise, razorpay_order_id) VALUES ($1, 'credit_pack', 'pack_500', 19900, 'order_1')`,
      [s.user.id],
    );
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 19900, status: 'captured' } } } });
    const hook = () => request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sign(body)).set('X-Razorpay-Event-Id', 'evt_1').send(body);
    expect((await hook()).body.status).toBe('processed');
    expect((await hook()).body.status).toBe('duplicate');

    const sig = createHmac('sha256', 'rzp_test_secret').update('order_1|pay_1').digest('hex');
    const verify = await request(app).post('/api/v1/billing/orders/verify').set(auth(s.token))
      .send({ orderId: 'order_1', paymentId: 'pay_1', signature: sig });
    expect(verify.status).toBe(200);
    expect(await balance(s.token)).toBe(560);
  });

  it('rejects bad webhook and checkout signatures', async () => {
    const s = await signup();
    const body = JSON.stringify({ event: 'payment.captured', payload: {} });
    const bad = await request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', 'deadbeef').set('X-Razorpay-Event-Id', 'evt_x').send(body);
    expect(bad.status).toBe(400);
    const v = await request(app).post('/api/v1/billing/orders/verify').set(auth(s.token))
      .send({ orderId: 'order_1', paymentId: 'pay_1', signature: 'nope' });
    expect(v.status).toBe(400);
  });

  it('activates a subscription plan and its credits on subscription.charged', async () => {
    const s = await signup();
    await pool.query(`INSERT INTO subscriptions (user_id, plan_id, razorpay_subscription_id) VALUES ($1, 'creator', 'sub_1')`, [s.user.id]);
    const body = JSON.stringify({
      event: 'subscription.charged',
      payload: {
        subscription: { entity: { id: 'sub_1', status: 'active', current_end: Math.floor(Date.now() / 1000) + 30 * 86400 } },
        payment: { entity: { id: 'pay_sub_1', amount: 49900, status: 'captured' } },
      },
    });
    const res = await request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', sign(body)).set('X-Razorpay-Event-Id', 'evt_sub_1').send(body);
    expect(res.status).toBe(200);
    const me = await request(app).get('/api/v1/auth/me').set(auth(s.token));
    expect(me.body.user.plan.id).toBe('creator');
    expect(me.body.balance).toMatchObject({ subscription: 1700, total: 1700 }); // free credits expired, plan granted
  });
});

describe('admin', () => {
  it('is forbidden to regular users', async () => {
    const s = await signup();
    expect((await request(app).get('/api/v1/admin/stats').set(auth(s.token))).status).toBe(403);
  });

  it('lets admins adjust credits, manage providers and read stats without exposing keys', async () => {
    const admin = await signup('admin@example.com');
    const u = await signup();
    const adj = await request(app).post(`/api/v1/admin/users/${u.user.id}/credits`).set(auth(admin.token)).send({ amount: 40, reason: 'support goodwill' });
    expect(adj.body.balance.total).toBe(100);
    const providers = await request(app).get('/api/v1/admin/providers').set(auth(admin.token));
    expect(providers.status).toBe(200);
    expect(providers.body.items.find((p: { id: string }) => p.id === 'openai')).toMatchObject({ configured: false });
    expect(JSON.stringify(providers.body)).not.toMatch(/sk-|Bearer/);
    const stats = await request(app).get('/api/v1/admin/stats').set(auth(admin.token));
    expect(stats.body.revenueInr).toBeGreaterThanOrEqual(0);

    const suspend = await request(app).patch(`/api/v1/admin/users/${u.user.id}`).set(auth(admin.token)).send({ status: 'suspended' });
    expect(suspend.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set(auth(u.token))).status).toBe(403);
  });
});
