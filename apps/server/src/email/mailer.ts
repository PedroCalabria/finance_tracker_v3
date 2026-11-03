import type { FastifyBaseLogger } from 'fastify';
import type { Config } from '../config';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface Mailer {
  send(msg: EmailMessage): Promise<void>;
}

/** Em desenvolvimento os emails vão para o log (com os links clicáveis). */
class ConsoleMailer implements Mailer {
  constructor(private readonly log: Pick<FastifyBaseLogger, 'info'>) {}
  readonly sent: EmailMessage[] = [];
  async send(msg: EmailMessage): Promise<void> {
    this.sent.push(msg);
    this.log.info({ to: msg.to, subject: msg.subject }, `\n--- EMAIL ---\nPara: ${msg.to}\nAssunto: ${msg.subject}\n\n${msg.text}\n-------------`);
  }
}

/** Resend pela API HTTP, sem SDK (ADR-0007). */
class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(msg: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend respondeu ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}

export function createMailer(config: Config, log: Pick<FastifyBaseLogger, 'info'>): Mailer {
  if (config.EMAIL_DRIVER === 'resend') return new ResendMailer(config.RESEND_API_KEY!, config.EMAIL_FROM);
  return new ConsoleMailer(log);
}

export { ConsoleMailer };
