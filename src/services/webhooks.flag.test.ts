/**
 * @file webhooks.flag.test.ts
 *
 * Unit tests for the WEBHOOKS_ENABLED feature flag in WebhookService.
 *
 * Covers:
 *  - Default behaviour (flag is true when env var is absent)
 *  - Flag ON  — trigger() queries subscriptions and delivers events
 *  - Flag OFF — trigger() is a no-op: no repo calls, no deliveries, no DLQ
 *  - Constructor injection (no process.env mutation needed in individual tests)
 *  - parseBoolEnv reading from process.env at construction time
 *  - Edge cases: empty string, 'true', 'false', '1', '0'
 */

import { WebhookService } from './webhook.service';

// ── Module mocks ──────────────────────────────────────────────────────────────

jest.mock('axios');

// Capture a stable reference to the mock findAll so we can assert on it
const mockFindAll = jest.fn().mockResolvedValue([]);

jest.mock('../db/database', () => ({
  getDb: jest.fn().mockReturnValue({}),
}));

jest.mock('../repositories/webhook-subscription.repository', () => ({
  SqliteWebhookSubscriptionRepository: jest.fn().mockImplementation(() => ({
    findAll: mockFindAll,
    create: jest.fn(),
    findAllPaginated: jest.fn(),
    findById: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  })),
}));

jest.mock('../queue/webhook-dlq', () => ({
  getWebhookDLQStorage: jest.fn().mockReturnValue({
    addEntry: jest.fn().mockResolvedValue(undefined),
    listEntries: jest.fn().mockReturnValue([]),
    getEntry: jest.fn().mockReturnValue(null),
    getStats: jest.fn().mockReturnValue({ total: 0, pending: 0, replayed: 0 }),
    checkDedupe: jest.fn().mockReturnValue({ exists: false }),
    markReplayed: jest.fn(),
  }),
}));

jest.mock('../utils/ssrf', () => ({
  isSafeUrl: jest.fn().mockReturnValue(true),
}));

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  mockFindAll.mockResolvedValue([]);
  delete process.env.WEBHOOKS_ENABLED;
});

afterAll(() => {
  delete process.env.WEBHOOKS_ENABLED;
});

// ── Default behaviour ─────────────────────────────────────────────────────────

describe('WEBHOOKS_ENABLED default behaviour', () => {
  it('defaults to enabled (true) when env var is absent', () => {
    delete process.env.WEBHOOKS_ENABLED;
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(true);
  });

  it('defaults to enabled when env var is empty string', () => {
    process.env.WEBHOOKS_ENABLED = '';
    // parseBoolEnv treats empty string as undefined → uses default true
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(true);
  });
});

// ── Constructor injection ─────────────────────────────────────────────────────

describe('constructor injection', () => {
  it('respects webhooksEnabled=true injected directly', () => {
    const service = new WebhookService(undefined, true);
    expect((service as any).webhooksEnabled).toBe(true);
  });

  it('respects webhooksEnabled=false injected directly', () => {
    const service = new WebhookService(undefined, false);
    expect((service as any).webhooksEnabled).toBe(false);
  });

  it('injected flag takes precedence over process.env', () => {
    process.env.WEBHOOKS_ENABLED = 'false';
    const service = new WebhookService(undefined, true);
    expect((service as any).webhooksEnabled).toBe(true);
  });
});

// ── process.env reading ───────────────────────────────────────────────────────

describe('WEBHOOKS_ENABLED env var reading', () => {
  it('reads true when WEBHOOKS_ENABLED=true', () => {
    process.env.WEBHOOKS_ENABLED = 'true';
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(true);
  });

  it('reads false when WEBHOOKS_ENABLED=false', () => {
    process.env.WEBHOOKS_ENABLED = 'false';
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(false);
  });

  it('reads true when WEBHOOKS_ENABLED=1', () => {
    process.env.WEBHOOKS_ENABLED = '1';
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(true);
  });

  it('reads false when WEBHOOKS_ENABLED=0', () => {
    process.env.WEBHOOKS_ENABLED = '0';
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(false);
  });

  it('reads true when WEBHOOKS_ENABLED=TRUE (case-insensitive)', () => {
    process.env.WEBHOOKS_ENABLED = 'TRUE';
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(true);
  });

  it('reads false when WEBHOOKS_ENABLED=FALSE (case-insensitive)', () => {
    process.env.WEBHOOKS_ENABLED = 'FALSE';
    const service = new WebhookService();
    expect((service as any).webhooksEnabled).toBe(false);
  });
});

// ── Flag ON behaviour ─────────────────────────────────────────────────────────

describe('WEBHOOKS_ENABLED=true (flag ON)', () => {
  it('trigger() queries subscriptions when flag is on', async () => {
    const service = new WebhookService(undefined, true);
    await service.trigger('contract.created', { id: 'abc' });

    expect(mockFindAll).toHaveBeenCalledTimes(1);
    expect(mockFindAll).toHaveBeenCalledWith({ eventType: 'contract.created', active: true });
  });

  it('trigger() delivers to each active matching subscription', async () => {
    const mockSubscriptions = [
      { id: 'sub-1', url: 'https://example.com/webhook', eventType: 'contract.created', secret: 'secret1', active: true },
      { id: 'sub-2', url: 'https://other.com/hook', eventType: 'contract.created', secret: undefined, active: true },
    ];
    mockFindAll.mockResolvedValueOnce(mockSubscriptions);

    const axios = require('axios');
    axios.post = jest.fn().mockResolvedValue({ status: 200 });

    const service = new WebhookService(undefined, true);
    await service.trigger('contract.created', { id: 'abc' });

    // Both subscriptions should have received delivery attempts
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.anything(),
      expect.anything(),
    );
    expect(axios.post).toHaveBeenCalledWith(
      'https://other.com/hook',
      expect.anything(),
      expect.anything(),
    );
  });

  it('trigger() passes correlationId through to deliveries', async () => {
    const mockSubscriptions = [
      { id: 'sub-1', url: 'https://example.com/webhook', eventType: 'dispute.resolved', secret: undefined, active: true },
    ];
    mockFindAll.mockResolvedValueOnce(mockSubscriptions);

    const axios = require('axios');
    axios.post = jest.fn().mockResolvedValue({ status: 200 });

    const service = new WebhookService(undefined, true);
    await service.trigger('dispute.resolved', { disputeId: 'xyz' }, 'corr-abc-123');

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-Correlation-Id': 'corr-abc-123' }),
      }),
    );
  });

  it('trigger() with no matching subscriptions calls findAll but sends nothing', async () => {
    mockFindAll.mockResolvedValueOnce([]);

    const axios = require('axios');
    axios.post = jest.fn();

    const service = new WebhookService(undefined, true);
    await service.trigger('contract.created', { id: 'abc' });

    expect(mockFindAll).toHaveBeenCalledTimes(1);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ── Flag OFF behaviour ────────────────────────────────────────────────────────

describe('WEBHOOKS_ENABLED=false (flag OFF)', () => {
  it('trigger() returns immediately without querying subscriptions', async () => {
    const service = new WebhookService(undefined, false);
    await service.trigger('contract.created', { id: 'abc' });

    expect(mockFindAll).not.toHaveBeenCalled();
  });

  it('trigger() does not make any HTTP delivery calls', async () => {
    const axios = require('axios');
    axios.post = jest.fn();

    const service = new WebhookService(undefined, false);
    await service.trigger('contract.created', { id: 'abc' });

    expect(axios.post).not.toHaveBeenCalled();
  });

  it('trigger() does not write to DLQ', async () => {
    const { getWebhookDLQStorage } = require('../queue/webhook-dlq');
    const dlqStorage = getWebhookDLQStorage();

    const service = new WebhookService(undefined, false);
    await service.trigger('contract.created', { id: 'abc' });

    expect(dlqStorage.addEntry).not.toHaveBeenCalled();
  });

  it('trigger() resolves successfully (no exception thrown)', async () => {
    const service = new WebhookService(undefined, false);
    await expect(service.trigger('contract.created', { id: 'abc' })).resolves.toBeUndefined();
  });

  it('trigger() is a no-op for any event type when disabled', async () => {
    const service = new WebhookService(undefined, false);
    await service.trigger('contract.created', {});
    await service.trigger('dispute.initiated', {});
    await service.trigger('escrow.completed', {});

    expect(mockFindAll).not.toHaveBeenCalled();
  });

  it('trigger() is a no-op when flag is read from WEBHOOKS_ENABLED=false env var', async () => {
    process.env.WEBHOOKS_ENABLED = 'false';
    const service = new WebhookService();
    await service.trigger('contract.created', { id: 'abc' });

    expect(mockFindAll).not.toHaveBeenCalled();
  });

  it('trigger() is a no-op when WEBHOOKS_ENABLED=0', async () => {
    process.env.WEBHOOKS_ENABLED = '0';
    const service = new WebhookService();
    await service.trigger('contract.created', { id: 'abc' });

    expect(mockFindAll).not.toHaveBeenCalled();
  });
});

// ── Non-trigger methods unaffected by flag ────────────────────────────────────

describe('non-trigger methods are unaffected by the flag', () => {
  it('getDLQ() works regardless of flag value', () => {
    const serviceOn = new WebhookService(undefined, true);
    const serviceOff = new WebhookService(undefined, false);
    expect(serviceOn.getDLQ()).toEqual([]);
    expect(serviceOff.getDLQ()).toEqual([]);
  });

  it('getDLQStats() works regardless of flag value', async () => {
    const serviceOn = new WebhookService(undefined, true);
    const serviceOff = new WebhookService(undefined, false);
    await expect(serviceOn.getDLQStats()).resolves.toEqual({ total: 0, pending: 0, replayed: 0 });
    await expect(serviceOff.getDLQStats()).resolves.toEqual({ total: 0, pending: 0, replayed: 0 });
  });

  it('getDLQEntry() works regardless of flag value', async () => {
    const serviceOn = new WebhookService(undefined, true);
    const serviceOff = new WebhookService(undefined, false);
    await expect(serviceOn.getDLQEntry('nonexistent')).resolves.toBeNull();
    await expect(serviceOff.getDLQEntry('nonexistent')).resolves.toBeNull();
  });
});
