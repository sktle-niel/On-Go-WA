import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/env.js';
import type { CodeDelivery } from '../context.js';
import { logger } from '../logging/logger.js';
import { renderResetCodeEmail } from './reset-email.js';

/**
 * SMTP delivery through any provider (Gmail, Resend, Postmark, SES, Mailtrap …).
 * One driver, no lock-in: the provider is chosen by the SMTP_* settings, whose
 * password comes from Secret Manager in a deployed environment.
 *
 * A send failure is logged but never thrown: the reset endpoint always answers
 * 202 whether or not the email exists, so raising here would both break that
 * contract and leak which addresses are real.
 */

/** The slice of a nodemailer transport this uses; a test passes a fake. */
export interface MailTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string; html: string }): Promise<unknown>;
}

export function createSmtpDelivery(config: AppConfig, transport?: MailTransport): CodeDelivery {
  const mailer: MailTransport =
    transport ??
    nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE ?? config.SMTP_PORT === 465,
      auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD },
    });

  const from = `${config.SMTP_FROM_NAME} <${config.SMTP_FROM}>`;

  return {
    async deliverPasswordResetCode({ email, code, expiresInSeconds }) {
      const { subject, text, html } = renderResetCodeEmail({ code, expiresInSeconds, appName: config.SMTP_FROM_NAME });
      try {
        await mailer.sendMail({ from, to: email, subject, text, html });
      } catch (err) {
        logger.error({ err: { message: (err as Error).message }, email }, 'password reset email failed to send');
      }
    },
  };
}
