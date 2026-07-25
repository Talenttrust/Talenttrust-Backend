import { ConsoleTransport, SMTPTransport, SESTransport, SendGridTransport, WebhookTransport } from './notification.transport';
import { EmailPayload, WebPayload } from '../types/notification.types';
import { EmailTransport } from '../queue/processors/email.transport';
import { WebhookService } from './webhook.service';

describe('notification email transports', () => {
  const payload: EmailPayload = { to: 'recipient@example.com', subject: 'Escrow update', body: 'Your escrow changed.' };
  const provider = () => ({ send: jest.fn().mockResolvedValue({ providerMessageId: 'message-1' }) });

  it('delivers valid SMTP email through the injected provider', async () => {
    const mock = provider();
    const transport = new SMTPTransport({ host: 'smtp.example.com', port: 465, from: 'notices@example.com' }, 1_000, mock);

    await expect(transport.sendEmail!(payload)).resolves.toEqual({ success: true });
    expect(mock.send).toHaveBeenCalledWith(payload, expect.anything());
  });

  it.each([
    ['SMTP', (mock: Pick<EmailTransport, 'send'>) => new SMTPTransport({ host: 'smtp.example.com', port: 465, from: 'notices@example.com' }, 1_000, mock)],
    ['SES', (mock: Pick<EmailTransport, 'send'>) => new SESTransport({ region: 'us-east-1', from: 'notices@example.com' }, 1_000, mock)],
    ['SendGrid', (mock: Pick<EmailTransport, 'send'>) => new SendGridTransport({ apiKey: 'test-key', from: 'notices@example.com' }, 1_000, mock)],
  ])('%s returns a failure result when the provider throws', async (_name, create) => {
    const failedProvider = { send: jest.fn().mockRejectedValue(new Error('provider unavailable')) };
    const transport = create(failedProvider);
    const result = await transport.sendEmail!(payload);
    expect(result).toEqual({ success: false, message: 'provider unavailable' });
    expect(failedProvider.send).toHaveBeenCalled();
  });

  it('rejects an invalid recipient before provider dispatch', async () => {
    const mock = provider();
    const transport = new SMTPTransport({ host: 'smtp.example.com', port: 465, from: 'notices@example.com' }, 1_000, mock);
    const result = await transport.sendEmail!({ ...payload, to: 'not an email' });
    expect(result).toEqual({ success: false, message: 'Invalid email address' });
    expect(mock.send).not.toHaveBeenCalled();
  });

  it.each([
    ['SMTP', () => new SMTPTransport({ host: '', port: 465, from: 'notices@example.com' })],
    ['SES', () => new SESTransport({ region: '', from: 'notices@example.com' })],
    ['SendGrid', () => new SendGridTransport({ apiKey: '', from: 'notices@example.com' })],
  ])('%s rejects missing selected-provider configuration', (_name, create) => {
    expect(create).toThrow(/required/);
  });

  it('rejects CRLF header injection before provider dispatch', async () => {
    const mock = provider();
    const transport = new SMTPTransport({ host: 'smtp.example.com', port: 465, from: 'notices@example.com' }, 1_000, mock);
    const result = await transport.sendEmail!({ ...payload, subject: 'Hello\r\nBcc: attacker@example.com' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Unsafe email payload/);
    expect(mock.send).not.toHaveBeenCalled();
  });

  it('keeps ConsoleTransport as an explicit safe dev/test default', async () => {
    await expect(ConsoleTransport.sendEmail!(payload)).resolves.toEqual({ success: true });
  });
});

describe('WebhookTransport id uniqueness', () => {
  const userId = 'user-abc';
  const webPayload: WebPayload = { userId, title: 'Escrow update', message: 'Your escrow has been funded.' };

  let webhookService: WebhookService;

  beforeEach(() => {
    webhookService = new WebhookService();
  });

  it('generates ids with the userId prefix for log correlation', async () => {
    const ids: string[] = [];
    jest.spyOn(webhookService, 'send').mockImplementation(async (p) => {
      ids.push(p.id);
    });

    const transport = new WebhookTransport(webhookService, 'https://example.test/webhook');
    await transport.sendWebNotification!(webPayload);

    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(new RegExp(`^${userId}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`));
  });

  it('produces distinct ids across 1000 concurrent sends for one user', async () => {
    const ids: string[] = [];
    jest.spyOn(webhookService, 'send').mockImplementation(async (p) => {
      ids.push(p.id);
    });

    const transport = new WebhookTransport(webhookService, 'https://example.test/webhook');

    // Fire 1000 concurrent sends to stress-test collision resistance
    await Promise.all(
      Array.from({ length: 1000 }, () => transport.sendWebNotification!(webPayload))
    );

    expect(ids).toHaveLength(1000);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(1000);
  });

  it('produces distinct ids for different users', async () => {
    const ids: string[] = [];
    jest.spyOn(webhookService, 'send').mockImplementation(async (p) => {
      ids.push(p.id);
    });

    const transport = new WebhookTransport(webhookService, 'https://example.test/webhook');

    await transport.sendWebNotification!({ userId: 'user-a', title: 'Test', message: 'A' });
    await transport.sendWebNotification!({ userId: 'user-b', title: 'Test', message: 'B' });

    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^user-a:/);
    expect(ids[1]).toMatch(/^user-b:/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('returns failure result when webhookService.send throws', async () => {
    jest.spyOn(webhookService, 'send').mockRejectedValue(new Error('Network timeout'));

    const transport = new WebhookTransport(webhookService, 'https://example.test/webhook');
    const result = await transport.sendWebNotification!(webPayload);

    expect(result).toEqual({ success: false, message: 'Network timeout' });
  });
});
