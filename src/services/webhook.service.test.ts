import { WebhookService } from './webhook.service';
import { MetricsServiceLike } from '../observability';
import axios from 'axios';
import { createWebhookSignature } from '../utils/webhook-signing.util';
import * as ssrf from '../utils/ssrf';
import { RateLimitStore } from '../lib/rateLimitStore';
import { WEBHOOK_RETRY_POLICY } from '../queue/webhook-retry-policy';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../utils/webhook-signing.util');
const mockedCreateWebhookSignature = createWebhookSignature as jest.MockedFunction<typeof createWebhookSignature>;

jest.mock('../utils/ssrf');
const mockedIsSafeUrl = ssrf.isSafeUrl as jest.MockedFunction<typeof ssrf.isSafeUrl>;

describe('WebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsSafeUrl.mockReturnValue(true);
  });

  it('sends webhook without signature when no secret is provided', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://test.com',
      { event: 'test', data: {} },
      // objectContaining tolerates the per-request `timeout` option, which the
      // webhook.service.iterative suite (same source) requires to be present.
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json'
        }
      })
    );
  });

  it('sends webhook with HMAC signature when secret is provided', async () => {
    const mockSignature = 'sha256=abcdef1234567890';
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
      webhookSecret: 'test-secret'
    };

    await service.send(payload);

    expect(mockedCreateWebhookSignature).toHaveBeenCalledWith(
      { event: 'test', data: {} },
      'test-secret'
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://test.com',
      { event: 'test', data: {} },
      // objectContaining tolerates the per-request `timeout` option, which the
      // webhook.service.iterative suite (same source) requires to be present.
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': mockSignature,
          'X-Timestamp': mockTimestamp.toString()
        }
      })
    );
  });

  it('handles webhook delivery failure with HMAC signing', async () => {
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
      webhookSecret: 'test-secret'
    };

    // The bounded retry loop (webhook.service.iterative architecture) attempts
    // maxRetries + 1 times within a single send(), re-signing on every attempt.
    // Drive all backoff timers to completion so the loop resolves.
    jest.useFakeTimers();
    try {
      const sendOp = service.send(payload);

      await jest.runAllTimersAsync();

      await sendOp;

      const expectedAttempts = WEBHOOK_RETRY_POLICY.maxRetries + 1;
      expect(mockedCreateWebhookSignature).toHaveBeenCalledTimes(expectedAttempts);
      expect(mockedAxios.post).toHaveBeenCalledTimes(expectedAttempts);
    } finally {
      jest.useRealTimers();
    }
  });

  it('moves webhook with HMAC signing to DLQ after max retries', async () => {
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 4, // Start with 4 retries (will fail on 5th attempt)
      webhookSecret: 'test-secret'
    };

    await service.send(payload);

    expect(service.getDLQ().length).toBe(1);
    expect(service.getDLQ()[0].webhookId).toBe('123');
  });
});

/**
 * @module services/webhook.service.test
 * @description Unit tests for correlation ID propagation in webhook service.
 *
 * Tests:
 * - Correlation ID is included in webhook request headers
 * - Webhook headers are correctly formatted
 * - Correlation ID is optional (not sent if undefined)
 * - Signature headers are preserved alongside correlation ID
 */
describe('WebhookService with correlation ID propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsSafeUrl.mockReturnValue(true);
  });

  /**
   * Should include X-Correlation-Id header when correlation ID is provided.
   */
  it('should include X-Correlation-Id header when provided', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-123',
      url: 'https://example.com/webhook',
      data: { event: 'test' },
      retryCount: 0,
      correlationId: 'trace-webhook-456',
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      { event: 'test' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Correlation-Id': 'trace-webhook-456',
        }),
      })
    );
  });

  /**
   * Should not include X-Correlation-Id header when undefined.
   */
  it('should not include X-Correlation-Id when undefined', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-789',
      url: 'https://example.com/webhook',
      data: { event: 'test' },
      retryCount: 0,
      correlationId: undefined,
    };

    await service.send(payload);

    const callArgs = mockedAxios.post.mock.calls[0];
    expect(callArgs).toBeTruthy();
    expect(callArgs[2]).toBeTruthy();
    expect((callArgs[2] as any).headers['X-Correlation-Id']).toBeUndefined();
  });

  /**
   * Should include both signature and correlation ID headers.
   */
  it('should include both signature and correlation ID headers', async () => {
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'sig-abc123',
      timestamp: 1234567890,
    });

    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-sig-corr',
      url: 'https://example.com/webhook',
      data: { event: 'signed' },
      retryCount: 0,
      webhookSecret: 'secret-key',
      correlationId: 'trace-sig-corr-789',
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      { event: 'signed' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Signature': 'sha256=sig-abc123',
          'X-Timestamp': '1234567890',
          'X-Correlation-Id': 'trace-sig-corr-789',
        }),
      })
    );
  });

  /**
   * Should not include correlation ID in webhook body, only in headers.
   */
  it('should send correlation ID only in headers, not in body', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-body-test',
      url: 'https://example.com/webhook',
      data: { event: 'test', shouldNotHaveCorr: false },
      retryCount: 0,
      correlationId: 'trace-body-test',
    };

    await service.send(payload);

    const callArgs = mockedAxios.post.mock.calls[0];
    expect(callArgs).toBeTruthy();
    const bodyArg = callArgs[1];
    const headersArg = (callArgs[2] as any)?.headers;

    // Correlation ID should NOT be in body
    expect(bodyArg).toEqual({ event: 'test', shouldNotHaveCorr: false });
    expect(bodyArg).not.toHaveProperty('correlationId');

    // Correlation ID SHOULD be in headers
    expect(headersArg).toBeTruthy();
    expect(headersArg['X-Correlation-Id']).toBe('trace-body-test');
  });

  /**
   * Should support correlation ID with complex event data.
   */
  it('should propagate correlation ID with complex event data', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const complexData = {
      contractId: 'contract-123',
      eventType: 'escrow.released',
      amount: 10000,
      timestamp: new Date().toISOString(),
      metadata: {
        userId: 'user-456',
        region: 'us-west-2',
      },
    };

    const service = new WebhookService();
    const payload = {
      id: 'webhook-complex',
      url: 'https://example.com/webhook',
      data: complexData,
      retryCount: 0,
      correlationId: 'trace-complex-789',
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      complexData,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Correlation-Id': 'trace-complex-789',
        }),
      })
    );
  });
});

/**
 * SSRF guard tests — delivery must be rejected and DLQ'd for private/internal URLs.
 */
describe('WebhookService SSRF guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('DLQs immediately when isSafeUrl returns false and does not call axios', async () => {
    mockedIsSafeUrl.mockReturnValue(false);

    const service = new WebhookService();
    const payload = {
      id: 'ssrf-1',
      url: 'http://192.168.1.1/hook',
      data: { event: 'test' },
      retryCount: 0,
    };

    await service.send(payload);

    expect(mockedAxios.post).not.toHaveBeenCalled();
    const dlq = service.getDLQ();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].webhookId).toBe('ssrf-1');
    expect(dlq[0].error).toContain('SSRF_BLOCKED');
  });

  it('DLQs on every retry attempt when isSafeUrl consistently returns false', async () => {
    mockedIsSafeUrl.mockReturnValue(false);

    const service = new WebhookService();
    await service.send({ id: 'ssrf-2', url: 'http://localhost/hook', data: {}, retryCount: 0 });

    // isSafeUrl should be checked once (immediate reject, no retries)
    expect(mockedIsSafeUrl).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('re-checks isSafeUrl on each retry attempt', async () => {
    // Passes first check, fails on second (simulates DNS rebinding between retries)
    mockedIsSafeUrl
      .mockReturnValueOnce(true)   // attempt 0 — passes SSRF, but network fails
      .mockReturnValueOnce(false); // attempt 1 — DLQ

    mockedAxios.post.mockRejectedValueOnce(new Error('Network Error'));

    const service = new WebhookService();
    jest.useFakeTimers();
    try {
      const op = service.send({ id: 'ssrf-3', url: 'https://example.com/hook', data: {}, retryCount: 0 });
      await jest.runOnlyPendingTimersAsync();
      await op;
    } finally {
      jest.useRealTimers();
    }

    expect(mockedIsSafeUrl).toHaveBeenCalledTimes(2);
    expect(mockedAxios.post).toHaveBeenCalledTimes(1); // only the first attempt fired
    const dlq = service.getDLQ();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toContain('SSRF_BLOCKED');
  });
});

/**
 * Per-host rate-limit tests.
 */
describe('WebhookService per-host rate limiting', () => {
  const ORIG_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedIsSafeUrl.mockReturnValue(true);
    // Reset shared store between tests
    (WebhookService as any).hostRateStore = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
    process.env = { ...ORIG_ENV, WEBHOOK_HOST_RATE_LIMIT_MAX: '3', WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS: '60000' };
  });

  afterEach(() => {
    process.env = ORIG_ENV;
  });

  it('allows delivery when under the rate limit', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    await service.send({ id: 'rl-1', url: 'https://example.com/hook', data: {}, retryCount: 0 });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(service.getDLQ()).toHaveLength(0);
  });

  it('DLQs with RATE_LIMITED error when host limit is exceeded', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    // Set limit to 1 so second call triggers it
    (WebhookService as any).hostRateStore = new RateLimitStore({ sweepIntervalMs: 9_999_999 });

    // Manually pre-fill the store to simulate limit reached
    const store: RateLimitStore = (WebhookService as any).hostRateStore;
    store.set('example.com', { count: 60, windowStart: Date.now(), blocked: false, blockedUntil: 0 });

    const service = new WebhookService();
    await service.send({ id: 'rl-2', url: 'https://example.com/hook', data: {}, retryCount: 0 });

    expect(mockedAxios.post).not.toHaveBeenCalled();
    const dlq = service.getDLQ();
    expect(dlq).toHaveLength(1);
    expect(dlq[0].error).toContain('RATE_LIMITED');
    expect(dlq[0].error).toContain('example.com');
  });

  it('does not cross-limit different hostnames', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const store: RateLimitStore = (WebhookService as any).hostRateStore;
    // Fill up example.com but not other.com
    store.set('example.com', { count: 60, windowStart: Date.now(), blocked: false, blockedUntil: 0 });

    const service = new WebhookService();
    await service.send({ id: 'rl-3', url: 'https://other.com/hook', data: {}, retryCount: 0 });

    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(service.getDLQ()).toHaveLength(0);
  });

  it('DLQs on rate limit without retrying', async () => {
    const store: RateLimitStore = (WebhookService as any).hostRateStore;
    store.set('example.com', { count: 60, windowStart: Date.now(), blocked: false, blockedUntil: 0 });

    const service = new WebhookService();
    await service.send({ id: 'rl-4', url: 'https://example.com/hook', data: {}, retryCount: 0 });

    // isSafeUrl called once; axios never called
    expect(mockedIsSafeUrl).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});
