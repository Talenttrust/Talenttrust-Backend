import { ConsoleTransport, SMTPTransport, SESTransport, SendGridTransport } from './notification.transport';
import { EmailPayload } from '../types/notification.types';
import { EmailTransport } from '../queue/processors/email.transport';

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
