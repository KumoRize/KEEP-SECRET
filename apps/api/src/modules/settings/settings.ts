import pg from 'pg';
import { z } from 'zod';
import { config, razorpayPlanIds } from '../../config.js';
import { pool } from '../../db/pool.js';
import { isValidGstin } from '../../lib/gstin.js';
import { logger } from '../../lib/logger.js';
import { parse } from '../../middleware/validate.js';
import { CREDIT_PACKS, PLANS, type PlanId } from '../billing/plans.js';
import { isStateCode } from '../billing/gst.js';

/**
 * Owner-editable runtime settings. Each section is stored as one row in app_settings and applied
 * in place to the live config / plan objects, so the rest of the code reads them as before.
 * Changes reach every API and worker process via Postgres NOTIFY (plus a 60s poll fallback).
 */

const PLAN_IDS = Object.keys(PLANS) as PlanId[];

const planShape = z.object({
  name: z.string().trim().min(2).max(30),
  priceInr: z.number().int().min(0).max(1_000_000),
  monthlyCredits: z.number().int().min(0).max(10_000_000),
  dailyGenerations: z.number().int().min(0).max(1_000_000),
  dailyMessages: z.number().int().min(0).max(1_000_000),
  maxConcurrent: z.number().int().min(1).max(100),
  maxVideoSeconds: z.number().int().min(0).max(600),
  maxMusicSeconds: z.number().int().min(0).max(600),
  storageGb: z.number().min(0).max(100_000),
});

export const SECTIONS = {
  pricing: z.object({
    usdInr: z.number().positive().max(1000),
    priceMarkup: z.number().min(1).max(20),
    inrPerCreditCost: z.number().positive().max(100),
    searchCostUsd: z.number().min(0).max(5),
  }),
  plans: z.object(Object.fromEntries(PLAN_IDS.map((id) => [id, planShape])) as Record<PlanId, typeof planShape>)
    .refine((p) => p.free.priceInr === 0, { message: 'The Free plan must cost ₹0', path: ['free', 'priceInr'] }),
  packs: z.array(z.object({
    id: z.string().regex(/^[a-z0-9_]{3,30}$/),
    name: z.string().trim().min(2).max(40),
    credits: z.number().int().min(1).max(10_000_000),
    priceInr: z.number().int().min(1).max(1_000_000),
  })).max(10).refine((a) => new Set(a.map((p) => p.id)).size === a.length, 'Pack ids must be unique'),
  referral: z.object({
    referrerCredits: z.number().int().min(0).max(100_000),
    refereeCredits: z.number().int().min(0).max(100_000),
  }),
  site: z.object({
    signupsOpen: z.boolean(),
    maintenance: z.boolean(),
    maintenanceMessage: z.string().max(300),
    announcement: z.string().max(300),
    requireEmailVerification: z.boolean(),
    moderationEnabled: z.boolean(),
  }),
  business: z.object({
    appName: z.string().trim().min(2).max(60),
    mailFrom: z.string().trim().max(120),
    sellerLegalName: z.string().trim().max(200),
    sellerAddress: z.string().trim().max(500),
    sellerStateCode: z.string().refine(isStateCode, 'Unknown GST state code'),
    sellerGstin: z.string().trim().toUpperCase().refine((g) => g === '' || isValidGstin(g), 'Invalid GSTIN'),
    gstSacCode: z.string().trim().refine((c) => c === '' || /^\d{6}$/.test(c), 'SAC code must be 6 digits'),
    gstRatePercent: z.number().min(0).max(28),
    pricesIncludeGst: z.boolean(),
    invoicePrefix: z.string().regex(/^[A-Z0-9]{1,4}$/, '1-4 uppercase letters/digits'),
  }).superRefine((b, ctx) => {
    if (b.sellerGstin && b.sellerGstin.slice(0, 2) !== b.sellerStateCode) {
      ctx.addIssue({ code: 'custom', path: ['sellerStateCode'], message: 'State must match the first two digits of the GSTIN' });
    }
    if (b.sellerGstin && !b.gstSacCode) {
      ctx.addIssue({ code: 'custom', path: ['gstSacCode'], message: 'SAC code is required once you add a GSTIN (confirm it with your CA)' });
    }
  }),
  automation: z.object({
    dailyReport: z.boolean(),
    /** Hour of day in IST (0-23) to send the daily report. */
    reportHourIst: z.number().int().min(0).max(23),
    /** Disable catalog models that lost money over the last 7 days (alert only when false). */
    autoDisableLossMakers: z.boolean(),
  }),
  razorpayPlans: z.record(z.enum(PLAN_IDS.filter((p) => p !== 'free') as [string, ...string[]]), z.string().regex(/^plan_[A-Za-z0-9]{6,40}$|^$/, 'Razorpay plan ids look like plan_XXXX')),
} as const;

export type SectionName = keyof typeof SECTIONS;
export type Settings = { [K in SectionName]: z.infer<(typeof SECTIONS)[K]> };

/** Defaults: whatever the environment / code configured at boot. Captured once, before any overrides. */
const DEFAULTS: Settings = {
  pricing: { usdInr: config.USD_INR, priceMarkup: config.PRICE_MARKUP, inrPerCreditCost: config.INR_PER_CREDIT_COST, searchCostUsd: config.SEARCH_COST_USD },
  plans: Object.fromEntries(PLAN_IDS.map((id) => {
    const p = PLANS[id];
    return [id, { name: p.name, priceInr: p.priceInr, monthlyCredits: p.monthlyCredits, dailyGenerations: p.dailyGenerations, dailyMessages: p.dailyMessages,
      maxConcurrent: p.maxConcurrent, maxVideoSeconds: p.maxVideoSeconds, maxMusicSeconds: p.maxMusicSeconds, storageGb: p.storageGb }];
  })) as Settings['plans'],
  packs: CREDIT_PACKS.map((p) => ({ ...p })),
  referral: { referrerCredits: config.REFERRAL_REFERRER_CREDITS, refereeCredits: config.REFERRAL_REFEREE_CREDITS },
  site: {
    signupsOpen: true, maintenance: false, maintenanceMessage: 'We are upgrading the studio. Back shortly!', announcement: '',
    requireEmailVerification: config.REQUIRE_EMAIL_VERIFICATION, moderationEnabled: config.MODERATION_ENABLED,
  },
  business: {
    appName: config.APP_NAME, mailFrom: config.MAIL_FROM, sellerLegalName: config.SELLER_LEGAL_NAME, sellerAddress: config.SELLER_ADDRESS,
    sellerStateCode: config.SELLER_STATE_CODE, sellerGstin: config.SELLER_GSTIN ?? '', gstSacCode: config.GST_SAC_CODE ?? '',
    gstRatePercent: config.GST_RATE_PERCENT, pricesIncludeGst: config.PRICES_INCLUDE_GST, invoicePrefix: config.INVOICE_PREFIX,
  },
  automation: { dailyReport: true, reportHourIst: 9, autoDisableLossMakers: false },
  razorpayPlans: (() => { try { return razorpayPlanIds(); } catch { return {}; } })(),
};

let current: Settings = structuredClone(DEFAULTS);
export const settings = (): Settings => current;
export const defaultSettings = (): Settings => structuredClone(DEFAULTS);

/** Copies settings onto the live objects every module already reads. */
function apply(s: Settings): void {
  config.USD_INR = s.pricing.usdInr;
  config.PRICE_MARKUP = s.pricing.priceMarkup;
  config.INR_PER_CREDIT_COST = s.pricing.inrPerCreditCost;
  config.SEARCH_COST_USD = s.pricing.searchCostUsd;
  for (const id of PLAN_IDS) Object.assign(PLANS[id], s.plans[id]);
  CREDIT_PACKS.splice(0, CREDIT_PACKS.length, ...s.packs.map((p) => ({ ...p })));
  config.REFERRAL_REFERRER_CREDITS = s.referral.referrerCredits;
  config.REFERRAL_REFEREE_CREDITS = s.referral.refereeCredits;
  config.REQUIRE_EMAIL_VERIFICATION = s.site.requireEmailVerification;
  config.MODERATION_ENABLED = s.site.moderationEnabled;
  const b = s.business;
  Object.assign(config, {
    APP_NAME: b.appName, MAIL_FROM: b.mailFrom, SELLER_LEGAL_NAME: b.sellerLegalName, SELLER_ADDRESS: b.sellerAddress,
    SELLER_STATE_CODE: b.sellerStateCode, SELLER_GSTIN: b.sellerGstin || undefined, GST_SAC_CODE: b.gstSacCode || undefined,
    GST_RATE_PERCENT: b.gstRatePercent, PRICES_INCLUDE_GST: b.pricesIncludeGst, INVOICE_PREFIX: b.invoicePrefix,
  });
  config.RAZORPAY_PLAN_IDS = JSON.stringify(Object.fromEntries(Object.entries(s.razorpayPlans).filter(([, v]) => v)));
  current = s;
}

/** Loads saved sections over the defaults. Invalid stored sections are skipped (and logged), never fatal. */
export async function loadSettings(): Promise<Settings> {
  const { rows } = await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
  const next = structuredClone(DEFAULTS) as Record<string, unknown>;
  for (const r of rows) {
    const schema = SECTIONS[r.key as SectionName];
    if (!schema) continue;
    const parsed = schema.safeParse(r.value);
    if (parsed.success) next[r.key] = parsed.data;
    else logger.error({ section: r.key, issues: parsed.error.issues }, 'ignoring invalid stored settings section');
  }
  apply(next as Settings);
  return current;
}

export async function saveSection<K extends SectionName>(key: K, value: unknown, actorId: string): Promise<Settings[K]> {
  // Invalid input becomes a 400 listing each problem, never a 500.
  const data = parse(SECTIONS[key], value) as Settings[K];
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, JSON.stringify(data), actorId],
  );
  apply({ ...current, [key]: data });
  await pool.query("SELECT pg_notify('settings_changed', $1)", [key]);
  return data;
}

export async function resetSection(key: SectionName, actorId: string): Promise<void> {
  await pool.query('DELETE FROM app_settings WHERE key = $1', [key]);
  apply({ ...current, [key]: structuredClone(DEFAULTS[key]) });
  await pool.query("SELECT pg_notify('settings_changed', $1)", [key]);
  await pool.query('INSERT INTO audit_log (actor_id, action, target) VALUES ($1, $2, $3)', [actorId, 'settings.reset', key]);
}

/**
 * Keeps this process in sync with changes made by any other process: LISTEN for instant updates,
 * plus a periodic reload in case a notification is missed. Returns a stop function.
 */
export function watchSettings(onChange: () => Promise<unknown>, intervalMs = 60_000): () => Promise<void> {
  let client: pg.Client | null = null;
  let stopped = false;
  const connect = async () => {
    if (stopped) return;
    try {
      client = new pg.Client({ connectionString: config.DATABASE_URL });
      client.on('error', () => { client = null; setTimeout(() => void connect(), 5000); });
      await client.connect();
      client.on('notification', () => void onChange().catch((err) => logger.error({ err }, 'settings reload failed')));
      await client.query('LISTEN settings_changed');
    } catch (err) {
      logger.warn({ err: (err as Error).message }, 'settings listener unavailable; relying on polling');
      client = null;
      setTimeout(() => void connect(), 15_000);
    }
  };
  void connect();
  const timer = setInterval(() => void onChange().catch(() => undefined), intervalMs);
  return async () => {
    stopped = true;
    clearInterval(timer);
    await client?.end().catch(() => undefined);
  };
}
