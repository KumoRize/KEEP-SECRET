import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { consoleOutbox, verificationEnforced } from '../src/lib/mailer.js';
import { findLossMakers, maybeRunLossGuard, maybeSendDailyReport } from '../src/modules/automation/automation.js';
import { CREDIT_PACKS, PLANS } from '../src/modules/billing/plans.js';
import { usdToCredits } from '../src/modules/orchestrator/router.js';
import { decrypt, encrypt, loadSecrets } from '../src/modules/settings/secrets.js';
import { defaultSettings, loadSettings } from '../src/modules/settings/settings.js';

const app = createApp();
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let owner: { token: string; id: string };

async function signup(email = `s${randomUUID()}@example.com`) {
  const r = await request(app).post('/api/v1/auth/register').send({ email, password: 'a-strong-password' });
  return { token: r.body.accessToken as string, id: r.body.user?.id as string, status: r.status, body: r.body };
}

beforeAll(async () => {
  const o = await signup('admin@example.com'); // the owner (first ADMIN_EMAILS entry)
  owner = { token: o.token, id: o.id };
});

afterEach(async () => {
  // Restore defaults after each test so they don't leak.
  await pool.query(`DELETE FROM app_settings WHERE key NOT LIKE '\\_state:%'`);
  await loadSettings();
  config.SETTINGS_ENCRYPTION_KEY = undefined;
});

describe('owner settings (no redeploy)', () => {
  it('is owner-only', async () => {
    const staff = await signup();
    await pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [staff.id]);
    expect((await request(app).get('/api/v1/owner/settings').set(auth(staff.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/owner/keys').set(auth(staff.token))).status).toBe(403);
    expect((await request(app).get('/api/v1/owner/settings').set(auth(owner.token))).status).toBe(200);
  });

  it('changes plans, packs and pricing live, with validation', async () => {
    const { body } = await request(app).get('/api/v1/owner/settings').set(auth(owner.token));
    const plans = body.settings.plans;
    plans.starter.monthlyCredits = 777;
    plans.starter.name = 'Starter+';
    expect((await request(app).put('/api/v1/owner/settings/plans').set(auth(owner.token)).send(plans)).status).toBe(200);
    expect(PLANS.starter).toMatchObject({ monthlyCredits: 777, name: 'Starter+' });
    const catalog = await request(app).get('/api/v1/billing/catalog');
    expect(catalog.body.plans.find((p: { id: string }) => p.id === 'starter')).toMatchObject({ monthlyCredits: 777 });

    const bad = { ...plans, free: { ...plans.free, priceInr: 99 } };
    expect((await request(app).put('/api/v1/owner/settings/plans').set(auth(owner.token)).send(bad)).status).toBe(400);

    const packs = [{ id: 'pack_mega', name: 'Mega pack', credits: 10000, priceInr: 2499 }];
    await request(app).put('/api/v1/owner/settings/packs').set(auth(owner.token)).send(packs);
    expect(CREDIT_PACKS).toEqual(packs);

    const before = usdToCredits(0.05);
    await request(app).put('/api/v1/owner/settings/pricing').set(auth(owner.token)).send({ ...body.settings.pricing, priceMarkup: 3.2 });
    expect(usdToCredits(0.05)).toBe(Math.ceil((0.05 * config.USD_INR * 3.2) / config.INR_PER_CREDIT_COST)); // 54, was 27
    expect(usdToCredits(0.05)).toBe(before * 2);

    // Reset to defaults.
    await request(app).delete('/api/v1/owner/settings/plans').set(auth(owner.token));
    expect(PLANS.starter.monthlyCredits).toBe(defaultSettings().plans.starter.monthlyCredits);
  });

  it('survives a restart: saved sections are reloaded from the database', async () => {
    const { body } = await request(app).get('/api/v1/owner/settings').set(auth(owner.token));
    await request(app).put('/api/v1/owner/settings/referral').set(auth(owner.token)).send({ referrerCredits: 999, refereeCredits: 1 });
    config.REFERRAL_REFERRER_CREDITS = 0; // simulate a fresh process
    await loadSettings();
    expect(config.REFERRAL_REFERRER_CREDITS).toBe(999);
    expect(body.defaults.referral.referrerCredits).toBe(300);
  });

  it('validates business/GST details', async () => {
    const { body } = await request(app).get('/api/v1/owner/settings').set(auth(owner.token));
    const b = body.settings.business;
    const wrongState = await request(app).put('/api/v1/owner/settings/business').set(auth(owner.token)).send({ ...b, sellerGstin: '27AAPFU0939F1ZV', sellerStateCode: '29', gstSacCode: '998314' });
    expect(wrongState.status).toBe(400);
    const ok = await request(app).put('/api/v1/owner/settings/business').set(auth(owner.token))
      .send({ ...b, sellerLegalName: 'Kumo Creative', sellerAddress: 'Pune', sellerGstin: '27AAPFU0939F1ZV', sellerStateCode: '27', gstSacCode: '998314' });
    expect(ok.status).toBe(200);
    expect(config.SELLER_GSTIN).toBe('27AAPFU0939F1ZV');
  });
});

describe('site switches', () => {
  it('maintenance mode pauses customers but not the owner, and the public site endpoint reports it', async () => {
    const customer = await signup();
    const { body } = await request(app).get('/api/v1/owner/settings').set(auth(owner.token));
    await request(app).put('/api/v1/owner/settings/site').set(auth(owner.token))
      .send({ ...body.settings.site, maintenance: true, maintenanceMessage: 'Back at 6pm', announcement: 'New: Veo 3.1!' });
    const site = await request(app).get('/api/v1/site');
    expect(site.body).toMatchObject({ maintenance: true, maintenanceMessage: 'Back at 6pm', announcement: 'New: Veo 3.1!' });
    const blocked = await request(app).get('/api/v1/auth/me').set(auth(customer.token));
    expect(blocked.status).toBe(503);
    expect(blocked.body.error).toMatchObject({ code: 'maintenance', message: 'Back at 6pm' });
    expect((await request(app).get('/api/v1/auth/me').set(auth(owner.token))).status).toBe(200);
    expect((await signup()).status).toBe(403);
  });

  it('can close sign-ups', async () => {
    const { body } = await request(app).get('/api/v1/owner/settings').set(auth(owner.token));
    await request(app).put('/api/v1/owner/settings/site').set(auth(owner.token)).send({ ...body.settings.site, signupsOpen: false });
    const r = await signup();
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('signups_closed');
  });

  it('only enforces email verification when emails can actually be delivered', () => {
    const saved = { d: config.MAIL_DRIVER, r: config.REQUIRE_EMAIL_VERIFICATION, k: config.RESEND_API_KEY };
    try {
      config.REQUIRE_EMAIL_VERIFICATION = true;
      config.MAIL_DRIVER = 'auto';
      config.RESEND_API_KEY = undefined;
      expect(verificationEnforced()).toBe(false); // nothing would arrive: don't lock users out
      config.RESEND_API_KEY = 're_test';
      expect(verificationEnforced()).toBe(true);
    } finally {
      Object.assign(config, { MAIL_DRIVER: saved.d, REQUIRE_EMAIL_VERIFICATION: saved.r, RESEND_API_KEY: saved.k });
    }
  });
});

describe('API keys saved from the dashboard', () => {
  it('needs the server encryption key', async () => {
    const r = await request(app).put('/api/v1/owner/keys/FAL_KEY').set(auth(owner.token)).send({ value: 'fal-secret-1234' });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('encryption_unavailable');
  });

  it('stores keys encrypted, shows only the last 4 characters, applies them live, and respects env', async () => {
    config.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64);
    const save = await request(app).put('/api/v1/owner/keys/FAL_KEY').set(auth(owner.token)).send({ value: 'fal-secret-ABCD' });
    expect(save.status).toBe(200);
    expect(save.body.test).toMatchObject({ ok: true });
    expect(config.FAL_KEY).toBe('fal-secret-ABCD');
    const { rows: [row] } = await pool.query(`SELECT * FROM app_secrets WHERE name = 'FAL_KEY'`);
    expect(JSON.stringify(row)).not.toContain('fal-secret');
    const list = await request(app).get('/api/v1/owner/keys').set(auth(owner.token));
    expect(list.body.items.find((k: { name: string }) => k.name === 'FAL_KEY')).toMatchObject({ source: 'dashboard', last4: 'ABCD' });
    expect(JSON.stringify(list.body)).not.toContain('fal-secret');

    config.FAL_KEY = undefined; // fresh process
    await loadSecrets();
    expect(config.FAL_KEY).toBe('fal-secret-ABCD');

    // Keys from the server environment can't be overridden from the dashboard.
    expect((await request(app).put('/api/v1/owner/keys/RAZORPAY_KEY_ID').set(auth(owner.token)).send({ value: 'rzp_live_x' })).status).toBe(409);
    expect((await request(app).put('/api/v1/owner/keys/NOT_A_KEY').set(auth(owner.token)).send({ value: 'xxxxx' })).status).toBe(400);

    await request(app).delete('/api/v1/owner/keys/FAL_KEY').set(auth(owner.token));
    expect(config.FAL_KEY).toBeUndefined();
  });

  it('detects tampering (AES-GCM)', () => {
    config.SETTINGS_ENCRYPTION_KEY = 'b'.repeat(64);
    const enc = encrypt('hello');
    expect(decrypt(enc)).toBe('hello');
    const tampered = { ...enc, ciphertext: Buffer.from('jello').toString('base64') };
    expect(() => decrypt(tampered)).toThrow();
  });
});

describe('setup checklist', () => {
  it('lists what is missing for launch', async () => {
    const r = await request(app).get('/api/v1/owner/setup').set(auth(owner.token));
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.body.items.map((i: { id: string; status: string }) => [i.id, i.status]));
    expect(byId).toMatchObject({ owner: 'ok', text: 'missing', image: 'missing', business: 'missing', mock: 'warning' });
    expect(r.body.ready).toBe(false);
    expect(r.body.progress).toBeGreaterThan(0);
  });
});

describe('automation', () => {
  it("sends the daily report once, after the chosen hour, with yesterday's numbers", async () => {
    const customer = await signup();
    // A payment yesterday (IST).
    await pool.query(
      `INSERT INTO payments (user_id, kind, item_id, amount_paise, status, paid_at) VALUES ($1,'credit_pack','pack_500',49900,'paid', $2)`,
      [customer.id, new Date('2026-10-08T06:00:00Z')],
    );
    const early = new Date('2026-10-09T02:00:00Z'); // 07:30 IST, before 09:00
    expect(await maybeSendDailyReport(early)).toBeNull();
    const now = new Date('2026-10-09T04:00:00Z'); // 09:30 IST
    const before = consoleOutbox.length;
    const report = await maybeSendDailyReport(now);
    expect(report).toMatchObject({ day: '2026-10-08', revenueInr: 499, payments: 1 });
    const mail = consoleOutbox.slice(before).find((m) => m.to === 'admin@example.com');
    expect(mail?.text).toContain('Revenue: ₹499');
    expect(await maybeSendDailyReport(new Date('2026-10-09T10:00:00Z'))).toBeNull(); // once per day
  });

  it('finds models losing money and auto-disables them when allowed', async () => {
    const customer = await signup();
    await pool.query(`INSERT INTO catalog_models (id, provider_id, model, categories, label, pricing) VALUES ('fal:fal-ai/costly', 'fal', 'fal-ai/costly', '{image}', 'Costly', '{"perImage":0.001}') ON CONFLICT DO NOTHING`);
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO generations (user_id, prompt, modality, held_credits, idempotency_key, status, provider_id, model, charged_credits, provider_cost_usd_micros, finished_at)
         VALUES ($1,'p','image',1,$2,'succeeded','fal','fal-ai/costly',1,100000,now())`,
        [customer.id, randomUUID()],
      );
    }
    expect((await findLossMakers()).map((l) => l.model)).toContain('fal-ai/costly'); // ₹8.4 cost vs ₹0.75 charged
    const { body } = await request(app).get('/api/v1/owner/settings').set(auth(owner.token));
    await request(app).put('/api/v1/owner/settings/automation').set(auth(owner.token)).send({ ...body.settings.automation, autoDisableLossMakers: true });
    const res = await maybeRunLossGuard(new Date('2026-10-09T05:00:00Z'));
    expect(res?.disabled).toContain('fal:fal-ai/costly');
    expect((await pool.query(`SELECT enabled FROM catalog_models WHERE id = 'fal:fal-ai/costly'`)).rows[0].enabled).toBe(false);
    expect(await maybeRunLossGuard(new Date('2026-10-09T06:00:00Z'))).toBeNull(); // once per day
  });
});
