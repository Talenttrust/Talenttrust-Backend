/**
 * @module email.transport
 * @description Pluggable email transport for the queue email-notification processor.
 *
 * Transports are selected from validated environment configuration and can be
 * replaced in tests via {@link setEmailTransportOverride}.
 */

import axios, { AxiosError } from 'axios';
import * as tls from 'tls';
import { EnvConfig, validateEnv } from '../../config/env.schema';
import { createLogger, Logger } from '../../logger';
import { redactSecret } from '../../utils/redact';

/** Outbound email fields consumed by {@link EmailTransport.send}. */
export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
  templateId?: string;
}

/** Result returned by a successful provider dispatch. */
export interface EmailSendResult {
  /** Provider-assigned message identifier, when available. */
  providerMessageId?: string;
}

/**
 * Pluggable email delivery contract for the queue processor.
 *
 * Implementations must reject unsafe payloads (header injection) and propagate
 * provider failures by throwing so BullMQ can retry the job.
 */
export interface EmailTransport {
  /**
   * Deliver an email through the configured provider.
   *
   * @param message - Validated recipient, subject, and body.
   * @param log - Structured logger scoped to the current job.
   * @returns Provider metadata on success.
   * @throws Error when delivery fails or the payload is unsafe.
   */
  send(message: EmailMessage, log: Logger): Promise<EmailSendResult>;
}

let transportOverride: EmailTransport | undefined;

/** Test-only hook to inject a mock transport. */
export function setEmailTransportOverride(transport: EmailTransport | undefined): void {
  transportOverride = transport;
}

/** Redact an email address for logging (local part only). */
export function redactEmailAddress(email: string): string {
  if (!email) return '[REDACTED]';
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return '[REDACTED]';
  return `[REDACTED]@${email.slice(atIndex + 1)}`;
}

/**
 * Strict single-recipient validation aligned with {@link NotificationService}.
 *
 * Rejects header-injection characters, multi-recipient separators, and
 * non-RFC-shaped addresses before they reach a real transport.
 */
export function isValidRecipientEmail(address: string): boolean {
  if (!address) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(address)) return false;
  if (/[,;]/.test(address)) return false;
  if (/["\\]/.test(address)) return false;
  if (/[<>()[\]]/.test(address)) return false;

  const parts = address.split('@');
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  if (!local || !domain) return false;

  const re = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
  return re.test(address);
}

/** Reject CR/LF in recipient and headers to prevent SMTP header injection. */
export function assertSafeEmailHeaders(message: EmailMessage): void {
  const unsafe = /[\r\n]/;
  if (
    unsafe.test(message.to) ||
    unsafe.test(message.subject) ||
    unsafe.test(message.body)
  ) {
    throw new Error('Unsafe email payload: header injection characters detected');
  }
}

/** Resolve the active transport from config or a test override. */
export function resolveEmailTransport(env: EnvConfig = validateEnv()): EmailTransport {
  if (transportOverride) {
    return transportOverride;
  }
  return createEmailTransportFromEnv(env);
}

/**
 * Build an {@link EmailTransport} from validated configuration.
 *
 * | `EMAIL_PROVIDER` | Transport            | Required config                          |
 * | ---------------- | -------------------- | ---------------------------------------- |
 * | `smtp`           | {@link SmtpEmailTransport}      | `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`    |
 * | `ses`            | {@link SesEmailTransport}       | `SMTP_FROM`, `AWS_REGION`                |
 * | `sendgrid`       | {@link SendGridEmailTransport}  | `SMTP_FROM`, `SENDGRID_API_KEY`          |
 * | _unset / other_  | {@link ConsoleEmailTransport}   | —                                        |
 */
export function createEmailTransportFromEnv(env: EnvConfig): EmailTransport {
  const timeoutMs = env.EMAIL_SEND_TIMEOUT_MS;

  if (env.EMAIL_PROVIDER === 'smtp') {
    if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
      throw new Error(
        'SMTP email transport selected but SMTP_HOST, SMTP_PORT, and SMTP_FROM are required',
      );
    }
    return new SmtpEmailTransport(
      {
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.SMTP_FROM,
        secure: env.SMTP_SECURE ?? false,
      },
      timeoutMs,
    );
  }

  if (env.EMAIL_PROVIDER === 'ses') {
    if (!env.SMTP_FROM || !env.AWS_REGION) {
      throw new Error('SES email transport selected but SMTP_FROM and AWS_REGION are required');
    }
    return new SesEmailTransport(
      {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        region: env.AWS_REGION,
        from: env.SMTP_FROM,
      },
      timeoutMs,
    );
  }

  if (env.EMAIL_PROVIDER === 'sendgrid') {
    if (!env.SMTP_FROM || !env.SENDGRID_API_KEY) {
      throw new Error(
        'SendGrid email transport selected but SMTP_FROM and SENDGRID_API_KEY are required',
      );
    }
    return new SendGridEmailTransport(
      {
        apiKey: env.SENDGRID_API_KEY,
        from: env.SMTP_FROM,
      },
      timeoutMs,
    );
  }

  return new ConsoleEmailTransport();
}

/** Local/test fallback — completes without network I/O. */
export class ConsoleEmailTransport implements EmailTransport {
  async send(message: EmailMessage, log: Logger): Promise<EmailSendResult> {
    assertSafeEmailHeaders(message);
    log.debug('Console email transport dispatch complete', {
      toRedacted: redactEmailAddress(message.to),
      subject: message.subject,
      templateId: message.templateId,
    });
    return {};
  }
}

/** SendGrid v3 mail/send via HTTP. */
export class SendGridEmailTransport implements EmailTransport {
  constructor(
    private readonly config: { apiKey: string; from: string },
    private readonly timeoutMs: number,
  ) {}

  async send(message: EmailMessage, log: Logger): Promise<EmailSendResult> {
    assertSafeEmailHeaders(message);
    log.debug('SendGrid email transport preparing dispatch', {
      toRedacted: redactEmailAddress(message.to),
      fromRedacted: redactEmailAddress(this.config.from),
      apiKeyRedacted: redactSecret(this.config.apiKey),
    });

    try {
      const response = await axios.post(
        'https://api.sendgrid.com/v3/mail/send',
        {
          personalizations: [{ to: [{ email: message.to }] }],
          from: { email: this.config.from },
          subject: message.subject,
          content: [{ type: 'text/plain', value: message.body }],
        },
        {
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: this.timeoutMs,
          validateStatus: (status) => status >= 200 && status < 300,
        },
      );

      const providerMessageId = response.headers['x-message-id'] as string | undefined;
      log.info('SendGrid email dispatch accepted', {
        providerMessageId,
        subject: message.subject,
      });
      return { providerMessageId };
    } catch (err: unknown) {
      const messageText = extractProviderError(err);
      log.error('SendGrid email dispatch failed', {
        err,
        subject: message.subject,
        toRedacted: redactEmailAddress(message.to),
      });
      throw new Error(`SendGrid delivery failed: ${messageText}`);
    }
  }
}

/** Generic SMTP transport using a minimal TLS client (no third-party SDK). */
export class SmtpEmailTransport implements EmailTransport {
  constructor(
    private readonly config: {
      host: string;
      port: number;
      user?: string;
      password?: string;
      from: string;
      secure?: boolean;
    },
    private readonly timeoutMs: number,
  ) {}

  async send(message: EmailMessage, log: Logger): Promise<EmailSendResult> {
    assertSafeEmailHeaders(message);
    log.debug('SMTP email transport preparing dispatch', {
      host: this.config.host,
      port: this.config.port,
      toRedacted: redactEmailAddress(message.to),
      fromRedacted: redactEmailAddress(this.config.from),
    });

    try {
      await sendViaSmtp(
        {
          ...this.config,
          to: message.to,
          subject: message.subject,
          body: message.body,
        },
        this.timeoutMs,
      );
      log.info('SMTP email dispatch accepted', { subject: message.subject });
      return {};
    } catch (err: unknown) {
      log.error('SMTP email dispatch failed', {
        err,
        subject: message.subject,
        toRedacted: redactEmailAddress(message.to),
      });
      throw new Error(`SMTP delivery failed: ${(err as Error).message}`);
    }
  }
}

/**
 * AWS SES transport using the regional HTTPS SendEmail API.
 *
 * Credentials are read from configuration; requests are signed with AWS SigV4.
 */
export class SesEmailTransport implements EmailTransport {
  constructor(
    private readonly config: {
      accessKeyId?: string;
      secretAccessKey?: string;
      region: string;
      from: string;
    },
    private readonly timeoutMs: number,
  ) {}

  async send(message: EmailMessage, log: Logger): Promise<EmailSendResult> {
    assertSafeEmailHeaders(message);
    log.debug('SES email transport preparing dispatch', {
      region: this.config.region,
      toRedacted: redactEmailAddress(message.to),
      fromRedacted: redactEmailAddress(this.config.from),
    });

    if (!this.config.accessKeyId || !this.config.secretAccessKey) {
      throw new Error('SES delivery failed: AWS credentials are not configured');
    }

    try {
      const providerMessageId = await sendViaSes(
        {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
          region: this.config.region,
          from: this.config.from,
          to: message.to,
          subject: message.subject,
          body: message.body,
        },
        this.timeoutMs,
      );
      log.info('SES email dispatch accepted', {
        providerMessageId,
        subject: message.subject,
      });
      return { providerMessageId };
    } catch (err: unknown) {
      log.error('SES email dispatch failed', {
        err,
        subject: message.subject,
        toRedacted: redactEmailAddress(message.to),
      });
      throw new Error(`SES delivery failed: ${(err as Error).message}`);
    }
  }
}

function extractProviderError(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const axiosErr = err as AxiosError<{ errors?: Array<{ message?: string }> }>;
    const detail = axiosErr.response?.data?.errors?.[0]?.message;
    return detail ?? axiosErr.message;
  }
  return (err as Error).message ?? 'Unknown provider error';
}

async function sendViaSmtp(
  options: {
    host: string;
    port: number;
    secure?: boolean;
    user?: string;
    password?: string;
    from: string;
    to: string;
    subject: string;
    body: string;
  },
  timeoutMs: number,
): Promise<void> {
  const lines: string[] = [
    `From: ${options.from}`,
    `To: ${options.to}`,
    `Subject: ${options.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body,
  ];
  const messageData = lines.join('\r\n');

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      {
        host: options.host,
        port: options.port,
        rejectUnauthorized: process.env.NODE_ENV !== 'test',
      },
      () => {
        let stage = 'greeting';
        let buffer = '';

        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`SMTP timeout after ${timeoutMs}ms`));
        }, timeoutMs);

        const send = (command: string) => {
          socket.write(`${command}\r\n`);
        };

        const finish = (err?: Error) => {
          clearTimeout(timer);
          socket.end();
          if (err) reject(err);
          else resolve();
        };

        socket.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const responses = buffer.split('\r\n').filter(Boolean);
          buffer = '';

          for (const response of responses) {
            const code = Number.parseInt(response.slice(0, 3), 10);
            if (Number.isNaN(code)) continue;

            if (stage === 'greeting' && code === 220) {
              send(`EHLO ${options.host}`);
              stage = 'ehlo';
            } else if (stage === 'ehlo' && code === 250) {
              if (options.user && options.password) {
                send('AUTH LOGIN');
                stage = 'auth-offer';
              } else {
                send(`MAIL FROM:<${options.from}>`);
                stage = 'mail-from';
              }
            } else if (stage === 'auth-offer' && code === 334) {
              send(Buffer.from(options.user!, 'utf8').toString('base64'));
              stage = 'auth-user';
            } else if (stage === 'auth-user' && code === 334) {
              send(Buffer.from(options.password!, 'utf8').toString('base64'));
              stage = 'auth-pass';
            } else if (stage === 'auth-pass' && code === 235) {
              send(`MAIL FROM:<${options.from}>`);
              stage = 'mail-from';
            } else if (stage === 'mail-from' && code === 250) {
              send(`RCPT TO:<${options.to}>`);
              stage = 'rcpt-to';
            } else if (stage === 'rcpt-to' && code === 250) {
              send('DATA');
              stage = 'data';
            } else if (stage === 'data' && code === 354) {
              send(`${messageData}\r\n.`);
              stage = 'done';
            } else if (stage === 'done' && code === 250) {
              send('QUIT');
              finish();
            } else if (code >= 400) {
              finish(new Error(response));
            }
          }
        });

        socket.on('error', (err) => finish(err));
      },
    );

    socket.on('error', reject);
  });
}

async function sendViaSes(
  options: {
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
    from: string;
    to: string;
    subject: string;
    body: string;
  },
  timeoutMs: number,
): Promise<string | undefined> {
  const endpoint = `https://email.${options.region}.amazonaws.com/`;
  const payload = new URLSearchParams({
    Action: 'SendEmail',
    Version: '2010-12-01',
    Source: options.from,
    'Destination.ToAddresses.member.1': options.to,
    'Message.Subject.Data': options.subject,
    'Message.Body.Text.Data': options.body,
  }).toString();

  const { createHash, createHmac } = await import('crypto');
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const service = 'ses';
  const host = `email.${options.region}.amazonaws.com`;
  const canonicalHeaders = `host:${host}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-date';
  const payloadHash = createHash('sha256').update(payload).digest('hex');
  const canonicalRequest = [
    'POST',
    '/',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/${options.region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');

  const hmac = (key: Buffer | string, data: string) =>
    createHmac('sha256', key).update(data).digest();
  const kDate = hmac(`AWS4${options.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, options.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  const response = await axios.post(endpoint, payload, {
    headers: {
      Authorization: authorization,
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Amz-Date': amzDate,
      Host: host,
    },
    timeout: timeoutMs,
    validateStatus: (status) => status >= 200 && status < 300,
  });

  const match = typeof response.data === 'string'
    ? response.data.match(/<MessageId>([^<]+)<\/MessageId>/)
    : null;
  return match?.[1];
}

/** Default module logger for transport factory warnings. */
export const transportLogger = createLogger({ component: 'email-transport' });
