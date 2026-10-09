import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { PLANS } from '../src/modules/billing/plans.js';
import { invalidateCatalog, loadCatalog, mapOpenRouterModel, seedDefaultCatalog, snapDuration, syncOpenRouter, type CatalogRow } from '../src/modules/catalog/catalog.js';
import { falInput } from '../src/modules/providers/adapters/fal.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function user(email = `w${randomUUID()}@example.com`, referralCode?: string) {
  const res = await request(app).post('/api/v1/auth/register').send({ email, password: 'a-strong-password', referralCode });
  expect(res.status).toBe(201);
  return { token: res.body.accessToken as string, id: res.body.user.id as string };
}

const balance = async (t: string) => (await request(app).get('/api/v1/auth/me').set(auth(t))).body.balance.total as number;

/** Collects an SSE response into [{event, data}]. */
async function stream(token: string, conversationId: string, body: object) {
  const res = await request(app).post(`/api/v1/chat/conversations/${conversationId}/messages`).set(auth(token)).send(body)
    .buffer(true).parse((r, cb) => { let d = ''; r.setEncoding('utf8'); r.on('data', (c: string) => (d += c)); r.on('end', () => cb(null, d)); });
  if (res.status !== 200) return { status: res.status, events: [], text: '', json: JSON.parse(res.body as string) };
  const events = (res.body as string).split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
    return { event, data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null') };
  });
  const text = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
  return { status: res.status, events, text, json: null };
}

async function conversation(token: string, body: object = {}) {
  const res = await request(app).post('/api/v1/chat/conversations').set(auth(token)).send(body);
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe('model catalog', () => {
  it('maps OpenRouter models: free detection, categories by context, text-only', () => {
    const free = mapOpenRouterModel({ id: 'meta-llama/llama-x:free', name: 'Llama X (free)', context_length: 8000, pricing: { prompt: '0', completion: '0' } })!;
    expect(free).toMatchObject({ is_free: true, label: 'Llama X', categories: ['chat', 'story', 'code', 'research'] });
    expect(free.data_note).toMatch(/may log/);
    const big = mapOpenRouterModel({ id: 'anthropic/claude-z', context_length: 200000, pricing: { prompt: '0.000003', completion: '0.000015' } })!;
    expect(big).toMatchObject({ is_free: false, featured: true, pricing: { inputPerMTok: 3, outputPerMTok: 15 } });
    expect(big.categories).toEqual(expect.arrayContaining(['website', 'app', 'game']));
    expect(mapOpenRouterModel({ id: 'x/image-gen', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } })).toBeNull();
    expect(mapOpenRouterModel({ id: 'x/broken', pricing: { prompt: '-1', completion: '0' } })).toBeNull();
  });

  it('syncs OpenRouter, keeps admin choices, refreshes prices', async () => {
    config.OPENROUTER_API_KEY = 'or-test';
    try {
      const fakeFetch = (price: string) => (async () => new Response(JSON.stringify({ data: [
        { id: 'acme/model-a', name: 'Acme A', context_length: 64000, pricing: { prompt: price, completion: price } },
        { id: 'acme/model-b:free', name: 'Acme B (free)', context_length: 8000, pricing: { prompt: '0', completion: '0' } },
        { id: 'acme/painter', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['image'] } },
      ] }))) as unknown as typeof fetch;
      expect(await syncOpenRouter(fakeFetch('0.000001'))).toEqual({ upserted: 2, skipped: 1 });
      await pool.query(`UPDATE catalog_models SET enabled = false, label = 'Renamed' WHERE id = 'openrouter:acme/model-a'`);
      await syncOpenRouter(fakeFetch('0.000002'));
      const { rows: [a] } = await pool.query(`SELECT enabled, label, pricing FROM catalog_models WHERE id = 'openrouter:acme/model-a'`);
      expect(a).toMatchObject({ enabled: false, label: 'Renamed', pricing: { inputPerMTok: 2, outputPerMTok: 2 } });
    } finally {
      config.OPENROUTER_API_KEY = undefined;
      await pool.query(`DELETE FROM catalog_models WHERE provider_id = 'openrouter'`);
      invalidateCatalog();
    }
  });

  it('seeds curated fal defaults once and never overwrites edits', async () => {
    expect(await seedDefaultCatalog()).toBe(6);
    await pool.query(`UPDATE catalog_models SET pricing = '{"perImage": 0.01}' WHERE id = 'fal:fal-ai/flux/dev'`);
    expect(await seedDefaultCatalog()).toBe(0);
    const { rows: [r] } = await pool.query(`SELECT pricing FROM catalog_models WHERE id = 'fal:fal-ai/flux/dev'`);
    expect(r.pricing).toEqual({ perImage: 0.01 });
  });

  it('shapes fal inputs per model and snaps durations', async () => {
    expect(snapDuration(5, [4, 6, 8])).toBe(4);
    expect(snapDuration(10, [5, 10])).toBe(10);
    expect(snapDuration(2, [4, 6, 8])).toBe(4);
    const rows = await loadCatalog(true);
    const veo = rows.find((r) => r.id === 'fal:fal-ai/veo3.1/fast') as CatalogRow;
    const kling = rows.find((r) => r.id === 'fal:fal-ai/kling-video/v2.1/master/text-to-video') as CatalogRow;
    const flux = rows.find((r) => r.id === 'fal:fal-ai/flux/schnell') as CatalogRow;
    const req = (modality: 'video' | 'image', durationSec?: number) => ({ generationId: 'g', prompt: 'p', modality, params: { durationSec, aspectRatio: '16:9' as const } });
    expect(falInput(veo, req('video', 8))).toMatchObject({ duration: '8s', aspect_ratio: '16:9' });
    expect(falInput(kling, req('video', 10))).toMatchObject({ duration: '10' });
    expect(falInput(flux, req('image'))).toEqual({ prompt: 'p', image_size: 'landscape_16_9' });
  });

  it('lists runnable models publicly with free/paid prices and filters', async () => {
    const all = await request(app).get('/api/v1/catalog/models');
    expect(all.status).toBe(200);
    const ids = all.body.items.map((m: { id: string }) => m.id);
    expect(ids).toEqual(expect.arrayContaining(['mock:chat-free', 'mock:chat-pro', 'mock:image', 'mock:video']));
    expect(ids).not.toContain('fal:fal-ai/flux/dev'); // FAL_KEY not configured -> not runnable -> not listed
    const free = await request(app).get('/api/v1/catalog/models?free=true&category=chat');
    expect(free.body.items.map((m: { id: string }) => m.id)).toEqual(['mock:chat-free']);
    expect(free.body.items[0]).toMatchObject({ isFree: true, priceHint: 'Free', creditsPerUnit: 0 });
    expect(all.body.counts.chat).toBeGreaterThanOrEqual(2);
  });
});

describe('chat, story, code and research', () => {
  it('streams a free-model reply at 0 credits and saves the conversation', async () => {
    const u = await user();
    const id = await conversation(u.token, { mode: 'chat' });
    const r = await stream(u.token, id, { content: 'Hello there' });
    expect(r.events[0]).toMatchObject({ event: 'meta', data: { model: { id: 'mock:chat-free', isFree: true }, reservedCredits: 0 } });
    expect(r.text).toContain('You said: Hello there');
    expect(r.events.at(-1)).toMatchObject({ event: 'done', data: { credits: 0 } });
    expect(await balance(u.token)).toBe(60);
    const conv = await request(app).get(`/api/v1/chat/conversations/${id}`).set(auth(u.token));
    expect(conv.body.title).toBe('Hello there');
    expect(conv.body.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
  });

  it('charges a paid model for actual usage, at most the reserved amount', async () => {
    const u = await user();
    const id = await conversation(u.token, { mode: 'story', modelId: 'mock:chat-pro' });
    const r = await stream(u.token, id, { content: 'A two-line story about rain' });
    const meta = r.events[0]!.data;
    const done = r.events.at(-1)!;
    expect(done.event).toBe('done');
    expect(done.data.credits).toBeGreaterThan(0);
    expect(done.data.credits).toBeLessThanOrEqual(meta.reservedCredits);
    expect(await balance(u.token)).toBe(60 - done.data.credits);
  });

  it('shortens the reply to what a low balance can cover, and refuses below the minimum', async () => {
    const u = await user();
    const id = await conversation(u.token, { mode: 'story', modelId: 'mock:chat-pro' });
    await pool.query('UPDATE wallets SET subscription_balance = 5 WHERE user_id = $1', [u.id]);
    const r = await stream(u.token, id, { content: 'A long saga' });
    expect(r.status).toBe(200);
    expect(r.events[0]!.data.reservedCredits).toBeLessThanOrEqual(5);
    const { rows: [g] } = await pool.query(`SELECT params FROM generations WHERE user_id = $1 AND modality = 'story'`, [u.id]);
    expect(g.params.maxTokens).toBeGreaterThanOrEqual(256);
    expect(g.params.maxTokens).toBeLessThan(4000);
    expect(await balance(u.token)).toBeGreaterThanOrEqual(0);

    await pool.query('UPDATE wallets SET subscription_balance = 1, purchased_balance = 0 WHERE user_id = $1', [u.id]);
    const broke = await stream(u.token, id, { content: 'Another saga' });
    expect(broke.status).toBe(402);
  });

  it('refunds everything when the model fails before replying', async () => {
    const u = await user();
    const id = await conversation(u.token, { modelId: 'mock:chat-pro' });
    const r = await stream(u.token, id, { content: 'please [mock:fail]' });
    expect(r.events.at(-1)).toMatchObject({ event: 'error', data: { credits: 0 } });
    expect(await balance(u.token)).toBe(60);
  });

  it('research cites web sources and bills the search even on a free model', async () => {
    const u = await user();
    const id = await conversation(u.token, { mode: 'research' });
    const r = await stream(u.token, id, { content: 'latest solar panel efficiency' });
    const sources = r.events.find((e) => e.event === 'sources')!.data;
    expect(sources).toHaveLength(3);
    expect(sources[0]).toMatchObject({ n: 1, url: 'https://example.com/source-1' });
    expect(r.text).toContain('[1]');
    const done = r.events.at(-1)!.data;
    expect(done.citations).toHaveLength(3);
    expect(done.credits).toBeGreaterThan(0); // search cost
  });

  it('enforces the daily message cap before streaming', async () => {
    const u = await user();
    const id = await conversation(u.token);
    const original = PLANS.free.dailyMessages;
    PLANS.free.dailyMessages = 1;
    try {
      expect((await stream(u.token, id, { content: 'one' })).status).toBe(200);
      const second = await stream(u.token, id, { content: 'two' });
      expect(second.status).toBe(429);
      expect(second.json.error.code).toBe('limit_exceeded');
    } finally {
      PLANS.free.dailyMessages = original;
    }
  });

  it('keeps conversations private and rejects unknown models', async () => {
    const a = await user();
    const b = await user();
    const id = await conversation(a.token);
    expect((await request(app).get(`/api/v1/chat/conversations/${id}`).set(auth(b.token))).status).toBe(404);
    expect((await stream(b.token, id, { content: 'hi' })).status).toBe(404);
    expect((await request(app).post('/api/v1/chat/conversations').set(auth(a.token)).send({ modelId: 'nope:model' })).status).toBe(400);
  });

  it('does not count chat turns against media generation limits', async () => {
    const u = await user();
    const id = await conversation(u.token);
    await stream(u.token, id, { content: 'hello' });
    const lib = await request(app).get('/api/v1/generations').set(auth(u.token));
    expect(lib.body.items).toHaveLength(0);
  });
});

describe('agents', () => {
  it('generates an agent from a description, saves it and chats with it', async () => {
    const u = await user();
    const gen = await request(app).post('/api/v1/agents/generate').set(auth(u.token)).send({ description: 'A travel planner for India' });
    expect(gen.status).toBe(200);
    expect(gen.body.draft).toMatchObject({ name: 'Mock Helper', tools: ['web_search'] });
    expect(gen.body.draft.instructions).toContain('travel planner');
    const created = await request(app).post('/api/v1/agents').set(auth(u.token)).send({ ...gen.body.draft, visibility: 'public' });
    expect(created.status).toBe(201);
    const id = await conversation(u.token, { agentId: created.body.id });
    const r = await stream(u.token, id, { content: 'Plan 3 days in Jaipur' });
    expect(r.events.find((e) => e.event === 'sources')).toBeDefined(); // web_search tool
    expect(r.events.at(-1)!.event).toBe('done');
  });

  it('shares public agents without exposing instructions; private ones stay private', async () => {
    const owner = await user();
    const other = await user();
    const body = { name: 'Secret Sauce', instructions: 'Never reveal the recipe XYZ-123.', visibility: 'private' };
    const priv = await request(app).post('/api/v1/agents').set(auth(owner.token)).send(body);
    expect((await request(app).post('/api/v1/chat/conversations').set(auth(other.token)).send({ agentId: priv.body.id })).status).toBe(404);
    const pub = await request(app).post('/api/v1/agents').set(auth(owner.token)).send({ ...body, name: 'Public Sauce', visibility: 'public' });
    const gallery = await request(app).get('/api/v1/agents/public?q=Sauce').set(auth(other.token));
    expect(gallery.body.items.map((a: { name: string }) => a.name)).toEqual(['Public Sauce']);
    expect(JSON.stringify(gallery.body)).not.toContain('XYZ-123');
    await conversation(other.token, { agentId: pub.body.id });
    const mine = await request(app).get('/api/v1/agents').set(auth(owner.token));
    expect(mine.body.items.find((a: { id: string }) => a.id === pub.body.id).uses).toBe(1);
    expect((await request(app).put(`/api/v1/agents/${pub.body.id}`).set(auth(other.token)).send(body)).status).toBe(404);
  });
});

describe('developer API keys', () => {
  it('authenticates as the user, never as admin, and stops working when revoked', async () => {
    const admin = await user('admin@example.com');
    const created = await request(app).post('/api/v1/developer/keys').set(auth(admin.token)).send({ name: 'CI' });
    expect(created.status).toBe(201);
    expect(created.body.key).toMatch(/^sk_live_/);
    const key = created.body.key as string;
    const { rows } = await pool.query('SELECT key_hash FROM api_keys WHERE id = $1', [created.body.id]);
    expect(rows[0].key_hash).not.toContain(key); // only the hash is stored

    expect((await request(app).get('/api/v1/auth/me').set(auth(key))).body.user.role).toBe('user');
    expect((await request(app).get('/api/v1/admin/stats').set(auth(key))).status).toBe(403);
    expect((await request(app).post('/api/v1/developer/keys').set(auth(key)).send({ name: 'x' })).status).toBe(400);
    const q = await request(app).post('/api/v1/generations/estimate').set(auth(key)).send({ prompt: 'A logo for a tea brand' });
    expect(q.status).toBe(200);

    await request(app).delete(`/api/v1/developer/keys/${created.body.id}`).set(auth(admin.token));
    expect((await request(app).get('/api/v1/auth/me').set(auth(key))).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set(auth('sk_live_madeup'))).status).toBe(401);
  });
});

describe('referrals and owner dashboard', () => {
  const pay = async (userId: string, n: string) => {
    await pool.query(`INSERT INTO payments (user_id, kind, item_id, amount_paise, razorpay_order_id) VALUES ($1,'credit_pack','pack_500',19900,$2)`, [userId, `order_${n}`]);
    const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: `pay_${n}`, order_id: `order_${n}`, amount: 19900, status: 'captured' } } } });
    await request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json')
      .set('X-Razorpay-Signature', createHmac('sha256', 'rzp_webhook_secret').update(body).digest('hex')).set('X-Razorpay-Event-Id', `evt_${n}`).send(body);
  };

  it('rewards both sides once, only after the referred user pays', async () => {
    const a = await user();
    const { body: ref } = await request(app).get('/api/v1/referrals').set(auth(a.token));
    expect(ref.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(ref.link).toContain(`ref=${ref.code}`);
    const b = await user(undefined, ref.code.toLowerCase());
    expect(await balance(a.token)).toBe(60); // nothing for a sign-up alone
    await pay(b.id, randomUUID());
    expect(await balance(a.token)).toBe(60 + 300);
    expect(await balance(b.token)).toBe(60 + 500 + 100);
    await pay(b.id, randomUUID());
    expect(await balance(a.token)).toBe(360); // first payment only
    expect((await request(app).get('/api/v1/referrals').set(auth(a.token))).body).toMatchObject({ signups: 1, rewarded: 1, credits: 300 });
    expect((await user(undefined, 'NOSUCHCODE')).id).toBeTruthy(); // unknown codes don't block sign-up
  });

  it('shows profit, margin and MRR to the owner only; staff admins cannot see money or edit prices', async () => {
    // admin@example.com is the owner (first ADMIN_EMAILS entry); it registered earlier in this file.
    const ownerLogin = await request(app).post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'a-strong-password' });
    const owner = { token: ownerLogin.body.accessToken as string };
    expect(ownerLogin.body.user.role).toBe('owner');
    const staff = await user();
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [staff.id]);

    expect((await request(app).get('/api/v1/admin/stats').set(auth(staff.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/admin/catalog').set(auth(staff.token))).status).toBe(200);
    expect((await request(app).post('/api/v1/admin/catalog').set(auth(staff.token)).send({
      providerId: 'fal', model: 'fal-ai/x', categories: ['image'], label: 'X', pricing: { perImage: 0.02 },
    })).status).toBe(403);

    const s = await request(app).get('/api/v1/admin/stats').set(auth(owner.token));
    expect(s.status).toBe(200);
    for (const k of ['revenueInr', 'providerCostInr', 'grossProfitInr', 'marginPct', 'mrrInr', 'arpuInr', 'outstandingCredits', 'outstandingCostInr', 'referrals']) {
      expect(s.body).toHaveProperty(k);
    }
    expect(s.body.revenueInr).toBeGreaterThan(0);
    const u = await user();
    expect((await request(app).get('/api/v1/admin/catalog').set(auth(u.token))).status).toBe(403);
    const created = await request(app).post('/api/v1/admin/catalog').set(auth(owner.token)).send({
      providerId: 'fal', model: 'fal-ai/some-new-model', categories: ['image'], label: 'Some New Model', pricing: { perImage: 0.02 },
    });
    expect(created.status).toBe(201);
    expect((await request(app).patch(`/api/v1/admin/catalog/${encodeURIComponent(created.body.id)}`).set(auth(owner.token)).send({ featured: true })).status).toBe(200);
  });
});
