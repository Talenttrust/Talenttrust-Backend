/**
 * Email Processor Tests
 *
 * Covers: structured log shape, PII redaction, crypto-strong unique ID,
 * correlation context propagation, and all validation branches.
 */

import { processEmailNotification, generateEmailId } from './email-processor';
import {
  EmailTransport,
  setEmailTransportOverride,
} from './email.transport';
import { EmailNotificationPayload } from '../types';
import { setWriteRecordImpl, LogRecord } from '../../logger';

// ── helpers ──────────────────────────────────────────────────────────────────

function captureRecords(): { records: LogRecord[]; restore: () => void } {
  const records: LogRecord[] = [];
  const original = (global as any).__writeRecordImpl;
  setWriteRecordImpl((r) => records.push(r));
  return {
    records,
    restore: () => setWriteRecordImpl(original ?? ((r: LogRecord) => {
      const line = JSON.stringify(r);
      (r.level === 'error' ? process.stderr : process.stdout).write(line + '\n');
    })),
  };
}

const BASE_PAYLOAD: EmailNotificationPayload = {
  to: 'user@example.com',
  subject: 'Welcome',
  body: 'Welcome to TalentTrust',
};

// ── generateEmailId ───────────────────────────────────────────────────────────

describe('generateEmailId', () => {
  it('returns an email_ prefixed UUID v4', () => {
    const id = generateEmailId();
    expect(id).toMatch(/^email_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('generates unique IDs across rapid successive calls', () => {
    const ids = Array.from({ length: 50 }, generateEmailId);
    const unique = new Set(ids);
    expect(unique.size).toBe(50);
  });
});

// ── processEmailNotification ──────────────────────────────────────────────────

describe('processEmailNotification', () => {
  afterEach(() => {
    setEmailTransportOverride(undefined);
  });

  describe('happy path', () => {
    it('returns success with a crypto-strong emailId', async () => {
      const result = await processEmailNotification(BASE_PAYLOAD);
      expect(result.success).toBe(true);
      expect(result.message).toContain('Email sent');
      expect((result.data as any).emailId).toMatch(/^email_[0-9a-f-]{36}$/i);
    });

    it('works with optional templateId', async () => {
      const result = await processEmailNotification({
        ...BASE_PAYLOAD,
        templateId: 'welcome-v2',
      });
      expect(result.success).toBe(true);
    });

    it('accepts common valid email formats', async () => {
      const emails = [
        'simple@example.com',
        'user.name@example.com',
        'user+tag@example.co.uk',
      ];
      for (const to of emails) {
        const r = await processEmailNotification({ ...BASE_PAYLOAD, to });
        expect(r.success).toBe(true);
      }
    });
  });

  describe('validation errors', () => {
    it('throws on invalid email address', async () => {
      await expect(
        processEmailNotification({ ...BASE_PAYLOAD, to: 'invalid-email' }),
      ).rejects.toThrow('Invalid email address');
    });

    it('throws on header-injection in recipient', async () => {
      await expect(
        processEmailNotification({
          ...BASE_PAYLOAD,
          to: 'user@example.com\r\nBcc: evil@example.com',
        }),
      ).rejects.toThrow('Invalid email address');
    });

    it('throws on header-injection in subject', async () => {
      await expect(
        processEmailNotification({
          ...BASE_PAYLOAD,
          subject: 'Hello\r\nBcc: evil@example.com',
        }),
      ).rejects.toThrow('header injection');
    });

    it('throws on missing subject', async () => {
      await expect(
        processEmailNotification({ ...BASE_PAYLOAD, subject: '' }),
      ).rejects.toThrow('Email subject and body are required');
    });

    it('throws on missing body', async () => {
      await expect(
        processEmailNotification({ ...BASE_PAYLOAD, body: '' }),
      ).rejects.toThrow('Email subject and body are required');
    });
  });

  describe('structured log shape', () => {
    it('emits JSON records (not console.log strings)', async () => {
      const { records, restore } = captureRecords();
      try {
        await processEmailNotification(BASE_PAYLOAD);
      } finally {
        restore();
      }

      expect(records.length).toBeGreaterThan(0);
      for (const r of records) {
        expect(r).toHaveProperty('timestamp');
        expect(r).toHaveProperty('level');
        expect(r).toHaveProperty('message');
        expect(r).toHaveProperty('service', 'talenttrust-backend');
        expect(typeof r.timestamp).toBe('string');
      }
    });

    it('includes correlationId and requestId when provided', async () => {
      const { records, restore } = captureRecords();
      try {
        await processEmailNotification({
          ...BASE_PAYLOAD,
          correlationId: 'corr-abc',
          requestId: 'req-123',
        });
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      expect(infoRecords.length).toBeGreaterThan(0);
      for (const r of infoRecords) {
        expect(r.correlationId).toBe('corr-abc');
        expect(r.requestId).toBe('req-123');
      }
    });

    it('does not log the recipient email address at info level', async () => {
      const { records, restore } = captureRecords();
      try {
        await processEmailNotification(BASE_PAYLOAD);
      } finally {
        restore();
      }

      const infoRecords = records.filter((r) => r.level === 'info');
      for (const r of infoRecords) {
        const serialised = JSON.stringify(r);
        expect(serialised).not.toContain('user@example.com');
      }
    });

    it('does not log the recipient email address in warn records', async () => {
      const { records, restore } = captureRecords();
      try {
        await processEmailNotification({
          ...BASE_PAYLOAD,
          to: 'bad-email',
        }).catch(() => {/* expected */});
      } finally {
        restore();
      }

      const warnRecords = records.filter((r) => r.level === 'warn');
      expect(warnRecords.length).toBeGreaterThan(0);
      for (const r of warnRecords) {
        const serialised = JSON.stringify(r);
        expect(serialised).not.toContain('bad-email');
      }
    });

    it('propagates transport failures so the job can be retried', async () => {
      const failingTransport: EmailTransport = {
        send: async () => {
          throw new Error('Provider unavailable');
        },
      };
      setEmailTransportOverride(failingTransport);

      await expect(processEmailNotification(BASE_PAYLOAD)).rejects.toThrow(
        'Provider unavailable',
      );
    });

    it('invokes the injected transport on success', async () => {
      const send = jest.fn().mockResolvedValue({ providerMessageId: 'msg-1' });
      setEmailTransportOverride({ send });

      const result = await processEmailNotification(BASE_PAYLOAD);

      expect(send).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
    });

    it('includes emailId in the delivery log record', async () => {
      const { records, restore } = captureRecords();
      let result: Awaited<ReturnType<typeof processEmailNotification>>;
      try {
        result = await processEmailNotification(BASE_PAYLOAD);
      } finally {
        restore();
      }

      const deliveryRecord = records.find(
        (r) => r.level === 'info' && typeof r.message === 'string' && r.message.includes('delivered'),
      );
      expect(deliveryRecord).toBeDefined();
      expect(deliveryRecord!.emailId).toBe((result!.data as any).emailId);
    });
  });
});
