import { config } from '../config.js';
import { logger } from './logger.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

class ConsoleMailer implements Mailer {
  readonly sent: Mail[] = [];
  async send(mail: Mail): Promise<void> {
    this.sent.push(mail);
    if (this.sent.length > 100) this.sent.shift();
    logger.info({ to: mail.to, subject: mail.subject, text: mail.text }, 'email (console driver)');
  }
}

class ResendMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: config.MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`resend: HTTP ${res.status}`);
  }
}

const consoleMailer = new ConsoleMailer();
const resendMailer = new ResendMailer();

/** True when emails actually reach inboxes (a Resend key from env or the owner dashboard). */
export const mailDeliverable = () => config.MAIL_DRIVER === 'resend' || (config.MAIL_DRIVER === 'auto' && Boolean(config.RESEND_API_KEY));

/** Picks the driver per send, so a key saved in the dashboard takes effect without a restart. */
export const mailer: Mailer = {
  send: (mail) => (mailDeliverable() ? resendMailer : consoleMailer).send(mail),
};

/**
 * Verification is enforced only when it can be completed: emails are deliverable, or links are
 * logged to the console outside production. Otherwise new users would be locked out.
 */
export const verificationEnforced = () =>
  config.REQUIRE_EMAIL_VERIFICATION && (mailDeliverable() || (config.MAIL_DRIVER === 'console' && config.NODE_ENV !== 'production'));

/** Exposed for tests and local development only. */
export const consoleOutbox = consoleMailer.sent;
