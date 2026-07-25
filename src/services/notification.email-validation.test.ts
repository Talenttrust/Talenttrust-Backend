/**
 * Email validator hardening tests.
 *
 * `isValidEmail` is private, so it is exercised through the public `sendEmail`
 * path. A stub transport that always succeeds lets us assert that valid
 * addresses reach the transport (`success: true`) while invalid/injection forms
 * are rejected before dispatch with `success: false` and the
 * `Invalid email address` message.
 */

import { NotificationService } from './notification.service';
import { NotificationTransport, NotificationResult } from './notification.transport';
import { KeyEscrowEvent } from '../types/notification.types';

describe('NotificationService email validation', () => {
  let sendEmailSpy: jest.Mock;
  let service: NotificationService;

  beforeEach(() => {
    sendEmailSpy = jest.fn(async (): Promise<NotificationResult> => ({ success: true }));
    const transport: NotificationTransport = { sendEmail: sendEmailSpy };
    // A no-op repo stub so the constructor does not open a real database.
    const repo = { saveWebNotification: jest.fn(), findByUser: jest.fn() } as never;
    service = new NotificationService({ emailTransport: transport, repo });
  });

  const event = 'KEY_REQUESTED' as unknown as KeyEscrowEvent;

  const validAddresses = [
    'user@example.com',
    'first.last@sub.example.co.uk',
    'a+tag@example.io',
    'name_123@example-domain.com',
  ];

  const invalidAddresses = [
    '', // empty
    'plainaddress', // no @ / domain
    'user@example', // missing TLD
    'user@@example.com', // two @
    'a@b,c@d.com', // multi-recipient (comma)
    'a@b.com;c@d.com', // multi-recipient (semicolon)
    '"x"@y.com', // quoted local part
    'a\\b@c.com', // backslash
    'user@exam ple.com', // whitespace
    'foo<bar>@example.com', // angle brackets
    'user@example.com\r\nBcc: evil@example.com', // CRLF header injection
    'user@example.com\ninjected', // LF injection
  ];

  it.each(validAddresses)('accepts valid address %p', async (addr) => {
    const res = await service.sendEmail(addr, event, { ok: true });
    expect(res.success).toBe(true);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
  });

  it.each(invalidAddresses)('rejects invalid/injection address %p', async (addr) => {
    const res = await service.sendEmail(addr, event, { ok: true });
    expect(res.success).toBe(false);
    expect(res.message).toBe('Invalid email address');
    // Validation must happen before any dispatch.
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});
