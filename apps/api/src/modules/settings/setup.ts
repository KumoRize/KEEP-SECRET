import { config, razorpayPlanIds } from '../../config.js';
import { pool } from '../../db/pool.js';
import { mailDeliverable } from '../../lib/mailer.js';
import { PLANS } from '../billing/plans.js';
import { encryptionAvailable, type SecretName } from './secrets.js';
import { settings } from './settings.js';

export type CheckStatus = 'ok' | 'missing' | 'warning' | 'optional';
export interface SetupItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** Where to fix it in the dashboard: 'keys:NAME' or 'settings:section'. */
  fix?: string;
  required: boolean;
}

const has = (n: SecretName) => Boolean((config as unknown as Record<string, string | undefined>)[n]);

/** The owner's launch checklist, computed live from configuration. */
export async function setupChecklist(): Promise<{ items: SetupItem[]; ready: boolean; progress: number }> {
  const s = settings();
  const { rows: [cat] } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM catalog_models WHERE enabled`);
  const paidPlans = Object.keys(PLANS).filter((p) => p !== 'free');
  const planIds = (() => { try { return razorpayPlanIds(); } catch { return {}; } })();
  const missingPlans = paidPlans.filter((p) => !planIds[p]);
  const prod = config.NODE_ENV === 'production';

  const items: SetupItem[] = [
    { id: 'owner', label: 'Owner account', status: 'ok', detail: 'You are the owner. Only you can change money, keys, roles and settings.', required: true },
    {
      id: 'encryption', label: 'Save keys from the dashboard', required: false,
      status: encryptionAvailable() ? 'ok' : 'warning',
      detail: encryptionAvailable() ? 'Keys you paste here are stored encrypted (AES-256-GCM).' : 'Ask your host to set SETTINGS_ENCRYPTION_KEY (run: openssl rand -hex 32) to paste keys here instead of server settings.',
    },
    {
      id: 'text', label: 'Chat, writing & coding models', required: true, fix: 'keys:OPENROUTER_API_KEY',
      status: has('OPENROUTER_API_KEY') || has('ANTHROPIC_API_KEY') || has('OPENAI_API_KEY') ? 'ok' : 'missing',
      detail: has('OPENROUTER_API_KEY') ? `OpenRouter key saved (use Test in API keys to confirm): ${cat!.n} catalog models enabled.` : 'Add an OpenRouter key (hundreds of models incl. free ones), or Anthropic/OpenAI.',
    },
    {
      id: 'image', label: 'Image models', required: true, fix: 'keys:FAL_KEY',
      status: has('FAL_KEY') || has('OPENAI_API_KEY') || has('STABILITY_API_KEY') ? 'ok' : 'missing',
      detail: 'fal.ai (FLUX family) is recommended; OpenAI or Stability also work.',
    },
    {
      id: 'video', label: 'Video models', required: false, fix: 'keys:FAL_KEY',
      status: has('FAL_KEY') || (has('REPLICATE_API_TOKEN') && Boolean(config.REPLICATE_VIDEO_MODEL)) ? 'ok' : 'optional',
      detail: 'fal.ai gives Veo 3.1 and Kling. Check video prices in Models before launch.',
    },
    {
      id: 'search', label: 'Web research', required: false, fix: 'keys:TAVILY_API_KEY',
      status: has('TAVILY_API_KEY') || has('BRAVE_SEARCH_API_KEY') ? 'ok' : 'optional',
      detail: 'Tavily or Brave powers Research mode and agents with web search.',
    },
    {
      id: 'payments', label: 'Payments (Razorpay)', required: true, fix: has('RAZORPAY_KEY_ID') ? 'settings:razorpayPlans' : 'keys:RAZORPAY_KEY_ID',
      status: !has('RAZORPAY_KEY_ID') || !has('RAZORPAY_KEY_SECRET') ? 'missing' : !has('RAZORPAY_WEBHOOK_SECRET') || missingPlans.length ? 'warning' : 'ok',
      detail: !has('RAZORPAY_KEY_ID') || !has('RAZORPAY_KEY_SECRET') ? 'Add your Razorpay Key ID and Key Secret.'
        : !has('RAZORPAY_WEBHOOK_SECRET') ? `Add the webhook secret. Webhook URL: ${config.PUBLIC_URL}/api/v1/webhooks/razorpay`
          : missingPlans.length ? `Create Razorpay subscription plans and paste their ids for: ${missingPlans.join(', ')}.` : 'Packs and subscriptions are live.',
    },
    {
      id: 'email', label: 'Email (verification & password reset)', required: true, fix: 'keys:RESEND_API_KEY',
      status: mailDeliverable() ? (s.business.mailFrom.includes('example.com') ? 'warning' : 'ok') : 'missing',
      detail: mailDeliverable() ? (s.business.mailFrom.includes('example.com') ? 'Set your sender address in Business settings.' : `Sending as ${s.business.mailFrom}.`)
        : 'Add a Resend key. Until then, email verification is paused automatically so nobody gets locked out.',
    },
    {
      id: 'business', label: 'Business & GST details', required: true, fix: 'settings:business',
      status: /configure/i.test(s.business.sellerLegalName) || /configure/i.test(s.business.sellerAddress) ? 'missing' : 'ok',
      detail: s.business.sellerGstin ? `Tax invoices with GSTIN ${s.business.sellerGstin}.` : 'Your name and address appear on invoices. Add a GSTIN once registered (Bills of Supply until then).',
    },
    {
      id: 'storage', label: 'File storage', required: prod,
      status: config.STORAGE_DRIVER === 's3' ? 'ok' : prod ? 'warning' : 'optional',
      detail: config.STORAGE_DRIVER === 's3' ? `S3 bucket ${config.S3_BUCKET}.` : 'Local disk. For production use S3 or Cloudflare R2 so files survive redeploys.',
    },
    {
      id: 'alerts', label: 'Alerts & daily report', required: false, fix: 'keys:ALERT_WEBHOOK_URL',
      status: has('ALERT_WEBHOOK_URL') || mailDeliverable() ? 'ok' : 'optional',
      detail: s.automation.dailyReport ? `Daily report at ${String(s.automation.reportHourIst).padStart(2, '0')}:00 IST by email${has('ALERT_WEBHOOK_URL') ? ' and Slack/Discord' : ''}.` : 'Daily report is off.',
    },
    {
      id: 'mock', label: 'Test provider off', required: prod,
      status: config.ENABLE_MOCK_PROVIDER ? (prod ? 'missing' : 'warning') : 'ok',
      detail: config.ENABLE_MOCK_PROVIDER ? 'The mock provider is on (fine for testing, never in production).' : 'Only real models are served.',
    },
  ];
  const required = items.filter((i) => i.required);
  const done = required.filter((i) => i.status === 'ok').length;
  return { items, ready: required.every((i) => i.status === 'ok'), progress: Math.round((done / required.length) * 100) };
}

/** Cheap, read-only calls that prove a key works. Never spends credits. */
const TESTS: Partial<Record<SecretName, () => Promise<Response>>> = {
  OPENROUTER_API_KEY: () => fetch('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(10_000) }),
  ANTHROPIC_API_KEY: () => fetch('https://api.anthropic.com/v1/models', { headers: { 'x-api-key': config.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(10_000) }),
  OPENAI_API_KEY: () => fetch('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${config.OPENAI_API_KEY}` }, signal: AbortSignal.timeout(10_000) }),
  RAZORPAY_KEY_SECRET: () => fetch('https://api.razorpay.com/v1/orders?count=1', {
    headers: { Authorization: `Basic ${Buffer.from(`${config.RAZORPAY_KEY_ID}:${config.RAZORPAY_KEY_SECRET}`).toString('base64')}` }, signal: AbortSignal.timeout(10_000),
  }),
  RESEND_API_KEY: () => fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${config.RESEND_API_KEY}` }, signal: AbortSignal.timeout(10_000) }),
};
TESTS.RAZORPAY_KEY_ID = TESTS.RAZORPAY_KEY_SECRET;

export async function testSecret(name: SecretName): Promise<{ ok: boolean; message: string }> {
  if (!has(name)) return { ok: false, message: 'Not set' };
  const t = TESTS[name];
  if (!t) return { ok: true, message: 'Saved. This key is checked on first use.' };
  try {
    const res = await t();
    if (res.ok) return { ok: true, message: 'Connected' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: 'Rejected: the key is invalid or lacks permission' };
    return { ok: false, message: `Provider answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: `Could not reach the provider: ${(err as Error).message}` };
  }
}
