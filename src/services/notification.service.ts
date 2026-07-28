import { KeyEscrowEvent, EmailPayload, WebPayload } from '../types/notification.types';
import { NotificationTransport, ConsoleTransport, NotificationResult, SMTPTransport, SESTransport, SendGridTransport } from './notification.transport';
import { NotificationRepository } from '../repositories/notificationRepository';
import { getDb } from '../db/database';
import { EnvConfig, validateEnv } from '../config/env.schema';
import { logger } from '../logger';

/** Resolve the synchronous notification email transport from validated config. */
export function createNotificationEmailTransport(env: EnvConfig = validateEnv()): NotificationTransport {
  if (env.EMAIL_PROVIDER === 'smtp') {
    if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
      throw new Error('SMTP email transport selected but SMTP_HOST, SMTP_PORT, and SMTP_FROM are required');
    }
    return new SMTPTransport({ host: env.SMTP_HOST, port: env.SMTP_PORT, user: env.SMTP_USER, password: env.SMTP_PASSWORD, from: env.SMTP_FROM, secure: env.SMTP_SECURE }, env.EMAIL_SEND_TIMEOUT_MS);
  }
  if (env.EMAIL_PROVIDER === 'ses') {
    if (!env.SMTP_FROM || !env.AWS_REGION || !env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
      throw new Error('SES email transport selected but SMTP_FROM, AWS_REGION, AWS_ACCESS_KEY_ID, and AWS_SECRET_ACCESS_KEY are required');
    }
    return new SESTransport({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, region: env.AWS_REGION, from: env.SMTP_FROM }, env.EMAIL_SEND_TIMEOUT_MS);
  }
  if (env.EMAIL_PROVIDER === 'sendgrid') {
    if (!env.SMTP_FROM || !env.SENDGRID_API_KEY) {
      throw new Error('SendGrid email transport selected but SMTP_FROM and SENDGRID_API_KEY are required');
    }
    return new SendGridTransport({ apiKey: env.SENDGRID_API_KEY, from: env.SMTP_FROM }, env.EMAIL_SEND_TIMEOUT_MS);
  }
  return ConsoleTransport;
}

/**
 * @title NotificationService
 * @notice Service responsible for dispatching email and web push notifications.
 * @dev Transport layers are pluggable via `NotificationTransport`. Web notifications
 * are persisted using `NotificationRepository` so they survive restarts. Methods
 * return typed results to allow callers to react to partial failures.
 */
export class NotificationService {
  private emailTransport: NotificationTransport;
  private webTransport: NotificationTransport;
  private repo: NotificationRepository;

  /**
   * Creates an email transport based on the environment configuration.
   */
  constructor(options?: {
    emailTransport?: NotificationTransport;
    webTransport?: NotificationTransport;
    repo?: NotificationRepository;
  }) {
    this.emailTransport = options?.emailTransport ?? createNotificationEmailTransport();
    this.webTransport = options?.webTransport ?? ConsoleTransport;
    this.repo = options?.repo ?? new NotificationRepository(getDb(process.env['DB_PATH'] ?? ':memory:'));
  }

  /**
   * Validates a single recipient email address before it is handed to an email
   * transport.
   *
   * The check is intentionally strict because validated addresses flow into the
   * (soon real) SMTP/SES/SendGrid transports, where permissive input enables
   * header- and recipient-injection attacks. The rules are:
   *
   *  - Reject empty input and any CR/LF (header-injection) characters.
   *  - Reject control characters and whitespace anywhere in the address.
   *  - Reject comma/semicolon-separated multi-recipient strings
   *    (e.g. `a@b.com,c@d.com`).
   *  - Reject quoting/backslash forms (`"x"@y.com`, `a\b@c.com`) that SMTP can
   *    misinterpret.
   *  - Accept normal RFC-shaped single addresses with exactly one `@` and a
   *    dotted domain with a TLD.
   *
   * The method keeps its boolean contract and signature unchanged so callers and
   * the email transport can rely on deterministic behaviour.
   *
   * @param address The candidate recipient address.
   * @returns `true` if the address is a safe, single, RFC-shaped recipient.
   */
  private isValidEmail(address: string): boolean {
    if (!address) return false;
    // Header-injection protection: reject CR/LF and other control characters.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(address)) return false;
    // Reject multi-recipient separators that could smuggle extra recipients.
    if (/[,;]/.test(address)) return false;
    // Reject quoting/backslash forms that SMTP can misinterpret.
    if (/["\\]/.test(address)) return false;
    // Reject angle brackets / display-name forms.
    if (/[<>()[\]]/.test(address)) return false;
    // Exactly one '@' separating local part and domain.
    const parts = address.split('@');
    if (parts.length !== 2) return false;
    const [local, domain] = parts;
    if (!local || !domain) return false;
    // Strict, single-address shape with a dotted domain and a TLD.
    const re = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
    return re.test(address);
  }

  /**
   * Sends an email notification to the specified recipient.
   * Returns a structured result instead of a bare boolean.
   */
  public async sendEmail(to: string, event: KeyEscrowEvent, data?: any): Promise<NotificationResult> {
    try {
      if (!this.isValidEmail(to)) {
        logger.warn('[NotificationService:Email] Invalid email address');
        throw new Error('Invalid email address');
      }

      const payload: EmailPayload = {
        to,
        subject: `Notification: ${event}`,
        body: `Event ${event} has occurred with data: ${JSON.stringify(data || {})}`,
      };

      if (this.emailTransport.sendEmail) {
        const res = await this.emailTransport.sendEmail(payload);
        if (!res.success) {
          logger.error('[NotificationService:Email] Transport failed', {
            toRedacted: `${to.slice(0, 2)}***@${to.split('@')[1]}`,
            message: res.message,
          });
        }
        return res;
      }

      // Fallback behaviour
      logger.info('[NotificationService:Email] No email transport configured, using console', {
        toRedacted: `${to.slice(0, 2)}***@${to.split('@')[1]}`,
      });
      return { success: true };
    } catch (error) {
      logger.error('[NotificationService:Email] Failed to send email', {
        event,
        err: error,
      });
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * @notice Sends a web push/in-app notification to the specified user.
   * @dev In production, this would persist to a database or use WebSockets/Firebase Push.
   * Security constraints: The `userId` must be authorized against the active session
   * to prevent IDOR vulnerabilities (one user pushing notifications to another).
   * 
   * @param userId The unique identifier of the target user.
   * @param event The Key Escrow event triggering this notification.
   * @param data Optional context data for the UI payload.
   * @return A boolean indicating whether the notification was dispatched successfully.
   */
  /**
   * Sends a web/in-app notification and persists it so UI consumers can fetch
   * missed notifications after restarts. Returns a structured result.
   */
  public async sendWebNotification(userId: string, event: KeyEscrowEvent, data?: any): Promise<NotificationResult> {
    try {
      if (!userId || /[\r\n]/.test(userId)) {
        logger.warn('[NotificationService:Web] Invalid user ID');
        throw new Error('Invalid user ID');
      }

      const payload: WebPayload = {
        userId,
        title: `Alert: ${event}`,
        message: `Details: ${JSON.stringify(data || {})}`,
      };

      // Persist so the UI can read past notifications — propagate failure to caller
      try {
        await Promise.resolve(this.repo.saveWebNotification(payload.userId, payload.title, payload.message));
      } catch (err: unknown) {
        logger.error('[NotificationService:Web] Failed to persist web notification', { err });
        return { success: false, message: `Persistence failure: ${(err as Error).message}` };
      }

      if (this.webTransport.sendWebNotification) {
        const res = await this.webTransport.sendWebNotification(payload);
        if (!res.success) {
          logger.error('[NotificationService:Web] Transport failed', {
            userId,
            message: res.message,
          });
        }
        return res;
      }

      logger.info('[NotificationService:Web] No web transport configured, using console', {
        userId,
      });
      return { success: true };
    } catch (error) {
      logger.error('[NotificationService:Web] Failed to send web alert', {
        event,
        err: error,
      });
      return { success: false, message: (error as Error).message };
    }
  }
}

export const notificationService = new NotificationService();
