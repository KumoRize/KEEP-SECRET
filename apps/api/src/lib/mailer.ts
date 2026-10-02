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

export const mailer: Mailer = config.MAIL_DRIVER === 'resend' ? new ResendMailer() : new ConsoleMailer();

/** Exposed for tests and local development only. */
export const consoleOutbox = mailer instanceof ConsoleMailer ? mailer.sent : null;
