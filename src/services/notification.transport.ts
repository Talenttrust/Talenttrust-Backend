import { EmailPayload, WebPayload } from '../types/notification.types';
import { WebhookService } from './webhook.service';
import { logger } from '../logger';
import * as crypto from 'crypto';
import {
  assertSafeEmailHeaders,
  EmailMessage,
  EmailTransport,
  isValidRecipientEmail,
  redactEmailAddress,
  SendGridEmailTransport,
  SesEmailTransport,
  SmtpEmailTransport,
} from '../queue/processors/email.transport';

/** Result returned by notification transports. */
export interface NotificationResult {
  success: boolean;
  message?: string;
}

/** Pluggable transport interface for notification delivery. */
export interface NotificationTransport {
  sendEmail?: (payload: EmailPayload) => Promise<NotificationResult>;
  sendWebNotification?: (payload: WebPayload) => Promise<NotificationResult>;
}

/** Explicit no-network transport for local development and tests. */
export const ConsoleTransport: NotificationTransport = {
  async sendEmail(payload: EmailPayload): Promise<NotificationResult> {
    if (!isValidRecipientEmail(payload.to)) return { success: false, message: 'Invalid email address' };
    try {
      assertSafeEmailHeaders(payload);
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
    logger.debug('[ConsoleTransport:Email] Sending', { toRedacted: redactEmailAddress(payload.to) });
    return { success: true };
  },
  async sendWebNotification(payload: WebPayload): Promise<NotificationResult> {
    logger.debug('[ConsoleTransport:Web] Sending', { userId: payload.userId });
    return { success: true };
  },
};

/** Webhook transport reuses WebhookService signing and retry behaviour. */
export class WebhookTransport implements NotificationTransport {
  constructor(private readonly webhookService: WebhookService, private readonly url: string, private readonly secret?: string) {}

  /**
   * Generates a collision-resistant delivery id for a notification.
   *
   * The id is constructed as `${userId}:${crypto.randomUUID()}` so it remains
   * human-readable (the userId prefix aids log correlation) while being unique
   * under rapid successive sends — even multiple sends for the same user within
   * the same millisecond produce distinct ids. The random component uses
   * `crypto.randomUUID()` which provides 122 bits of entropy (version 4 UUID).
   *
   * @param userId - The recipient's platform identifier.
   * @returns A unique delivery id string (e.g. `user-abc:550e8400-e29b-41d4-a716-446655440000`).
   */
  private buildDeliveryId(userId: string): string {
    return `${userId}:${crypto.randomUUID()}`;
  }

  /**
   * Sends a web notification via the configured webhook endpoint.
   *
   * The delivery id is generated once per call (via {@link buildDeliveryId}) and
   * passed to `webhookService.send`, which handles its own bounded retry cycle
   * using that same id — so the id is stable for a single logical send.
   *
   * @param payload - The web notification payload (userId, title, message).
   * @returns A result indicating success or failure with an optional message.
   */
  async sendWebNotification(payload: WebPayload): Promise<NotificationResult> {
    try {
      await this.webhookService.send({ id: this.buildDeliveryId(payload.userId), url: this.url, data: payload, retryCount: 0, webhookSecret: this.secret });
      return { success: true };
    } catch (error) {
      return { success: false, message: (error as Error).message };
    }
  }
}

type Provider = Pick<EmailTransport, 'send'>;

/**
 * Adapts a real queue email provider to the NotificationTransport contract.
 * It validates a single recipient and rejects CR/LF header injection before
 * dispatch. Provider errors are converted to a failed result for caller retry.
 */
class ProviderEmailNotificationTransport implements NotificationTransport {
  constructor(private readonly provider: Provider, private readonly name: string) {}

  async sendEmail(payload: EmailPayload): Promise<NotificationResult> {
    if (!isValidRecipientEmail(payload.to)) return { success: false, message: 'Invalid email address' };
    try {
      assertSafeEmailHeaders(payload);
      await this.provider.send(payload as EmailMessage, logger);
      return { success: true };
    } catch (error) {
      logger.error(`[${this.name}] Email delivery failed`, { err: error, toRedacted: redactEmailAddress(payload.to) });
      return { success: false, message: (error as Error).message };
    }
  }
}

/** Real SMTP notification transport. A provider may be injected for tests. */
export class SMTPTransport extends ProviderEmailNotificationTransport {
  constructor(config: { host: string; port: number; user?: string; password?: string; from: string; secure?: boolean }, timeoutMs = 10_000, provider?: Provider) {
    if (!config.host || !config.port || !config.from) throw new Error('SMTP_HOST, SMTP_PORT, and SMTP_FROM are required');
    super(provider ?? new SmtpEmailTransport(config, timeoutMs), 'SMTPTransport');
  }
}

/** Real AWS SES notification transport. A provider may be injected for tests. */
export class SESTransport extends ProviderEmailNotificationTransport {
  constructor(config: { accessKeyId?: string; secretAccessKey?: string; region: string; from: string }, timeoutMs = 10_000, provider?: Provider) {
    if (!config.region || !config.from) throw new Error('AWS_REGION and SMTP_FROM are required');
    super(provider ?? new SesEmailTransport(config, timeoutMs), 'SESTransport');
  }
}

/** Real SendGrid notification transport. A provider may be injected for tests. */
export class SendGridTransport extends ProviderEmailNotificationTransport {
  constructor(config: { apiKey: string; from: string }, timeoutMs = 10_000, provider?: Provider) {
    if (!config.apiKey || !config.from) throw new Error('SENDGRID_API_KEY and SMTP_FROM are required');
    super(provider ?? new SendGridEmailTransport(config, timeoutMs), 'SendGridTransport');
  }
}
