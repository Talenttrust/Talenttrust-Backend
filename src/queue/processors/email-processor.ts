/**
 * Email Notification Processor
 *
 * Handles asynchronous email sending for notifications.
 * Validates email addresses and handles delivery failures.
 */

import { EmailNotificationPayload, JobResult } from '../types';
import { createLogger } from '../../logger';
import {
  assertSafeEmailHeaders,
  isValidRecipientEmail,
  resolveEmailTransport,
} from './email.transport';

/**
 * Generate a cryptographically-strong unique tracking ID for an outbound email.
 *
 * Uses `crypto.randomUUID()` (RFC 4122 v4) so that IDs are collision-resistant
 * even under rapid successive calls, unlike the previous `Date.now() +
 * Math.random()` approach which could produce duplicates under load.
 *
 * @returns A UUID v4 string prefixed with `email_` for readability in logs.
 */
export function generateEmailId(): string {
  return `email_${crypto.randomUUID()}`;
}

/**
 * Process email notification job
 *
 * Validates the recipient, guards against header injection, dispatches through
 * the configured {@link EmailTransport}, and surfaces provider failures so the
 * queue manager can retry the job.
 *
 * @param payload - Email notification data
 * @returns Job result with success status
 * @throws Error if validation or delivery fails
 */
export async function processEmailNotification(
  payload: EmailNotificationPayload,
): Promise<JobResult> {
  const log = createLogger({
    processor: 'email',
    ...(payload.correlationId && { correlationId: payload.correlationId }),
    ...(payload.requestId && { requestId: payload.requestId }),
  });

  if (!isValidRecipientEmail(payload.to)) {
    log.warn('Email validation failed: invalid address format');
    throw new Error(`Invalid email address: ${payload.to}`);
  }

  if (!payload.subject || !payload.body) {
    log.warn('Email validation failed: missing subject or body');
    throw new Error('Email subject and body are required');
  }

  assertSafeEmailHeaders({
    to: payload.to,
    subject: payload.subject,
    body: payload.body,
    templateId: payload.templateId,
  });

  log.info('Sending email notification', {
    subject: payload.subject,
    templateId: payload.templateId,
  });

  const emailId = generateEmailId();
  const transport = resolveEmailTransport();

  await transport.send(
    {
      to: payload.to,
      subject: payload.subject,
      body: payload.body,
      templateId: payload.templateId,
    },
    log,
  );

  log.info('Email notification delivered', { emailId, subject: payload.subject });

  return {
    success: true,
    message: `Email sent to ${payload.to}`,
    data: { emailId },
  };
}
