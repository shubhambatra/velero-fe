import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';

import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * Outbound email over SMTP (PLAN.md §4.2).
 *
 * Plain-text only on purpose: nothing in these messages needs markup, and a
 * text body cannot carry injected HTML or a tracking pixel — relevant for an
 * air-gapped product (§1.1 P6) that must not fetch remote content.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: Transporter | undefined;

  constructor(@Inject(ENV) private readonly env: Env) {}

  get configured(): boolean {
    return this.env.SMTP_HOST !== undefined;
  }

  /**
   * Sends one message, throwing if mail is not configured or the relay
   * refuses it. Callers decide whether failure is fatal: an invitation is
   * (503), a lockout notification is not.
   */
  async send(message: MailMessage): Promise<void> {
    const transporter = this.transport();
    if (transporter === undefined) {
      throw new ServiceUnavailableException('email delivery is not configured (SMTP_HOST unset)');
    }

    await transporter.sendMail({
      from: this.env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
    // Recipient is logged redacted: addresses are personal data and the log
    // line is only here to correlate "was it sent".
    this.logger.log(`sent "${message.subject}" to ${maskEmail(message.to)}`);
  }

  private transport(): Transporter | undefined {
    if (this.env.SMTP_HOST === undefined) {
      return undefined;
    }
    this.transporter ??= createTransport({
      host: this.env.SMTP_HOST,
      port: this.env.SMTP_PORT,
      secure: this.env.SMTP_SECURE,
      ...(this.env.SMTP_USER !== undefined && this.env.SMTP_PASSWORD !== undefined
        ? { auth: { user: this.env.SMTP_USER, pass: this.env.SMTP_PASSWORD } }
        : {}),
      // A relay that hangs must not hold a request worker.
      connectionTimeout: 5_000,
      greetingTimeout: 5_000,
      socketTimeout: 10_000,
    });
    return this.transporter;
  }
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}
