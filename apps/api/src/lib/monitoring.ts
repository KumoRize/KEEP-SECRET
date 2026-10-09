import * as Sentry from '@sentry/node';
import { config } from '../config.js';
import { logger } from './logger.js';

let sentryOn = false;

/** Call once at process start (API or worker). No-op without SENTRY_DSN. */
export function initMonitoring(service: 'api' | 'worker'): void {
  if (!config.SENTRY_DSN || sentryOn) return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.NODE_ENV,
    tracesSampleRate: 0,
    // Never ship user info, cookies, headers, bodies or query strings: they can hold prompts,
    // tokens, emails and payment details.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
  });
  Sentry.setTag('service', service);
  sentryOn = true;
}

export function captureError(err: unknown, context?: Record<string, unknown>): void {
  logger.error({ err, ...context }, 'error captured');
  if (sentryOn) Sentry.captureException(err, context ? { extra: context } : undefined);
}

export async function flushMonitoring(): Promise<void> {
  if (sentryOn) await Sentry.flush(2000);
}

const ALERT_COOLDOWN_MS = 15 * 60_000;
const lastSent = new Map<string, number>();

/**
 * Posts an operational alert to ALERT_WEBHOOK_URL (Slack and Discord both accept this shape).
 * Throttled per key so a flapping provider produces one message per 15 minutes, not hundreds.
 * Never throws: alerting must not break the request or job that triggered it.
 */
export async function alert(key: string, message: string, now = Date.now()): Promise<boolean> {
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < ALERT_COOLDOWN_MS) return false;
  lastSent.set(key, now);
  logger.warn({ alert: key }, message);
  if (!config.ALERT_WEBHOOK_URL) return false;
  const text = `[${config.NODE_ENV}] ${message}`;
  try {
    const res = await fetch(config.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, content: text }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'alert delivery failed');
    return false;
  }
}

export function resetAlertThrottle(): void {
  lastSent.clear();
}
