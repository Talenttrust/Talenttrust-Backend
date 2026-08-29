import { WebhookService, WebhookPayload } from './webhook.service';

// Mock axios
jest.mock('axios', () => ({
  post: jest.fn(),
}));

// Mock webhook signing
jest.mock('../utils/webhook-signing.util', () => ({
  createWebhookSignature: jest.fn().mockReturnValue({
    signature: 'test-signature',
    timestamp: 1234567890,
  }),
}));

// Mock retry policy — use 0ms delays for fast tests
jest.mock('../queue/webhook-retry-policy', () => ({
  WEBHOOK_RETRY_POLICY: {
    maxRetries: 3,
    maxAttempts: 4,
    initialDelayMs: 0,
    maxDelayMs: 0,
    multiplier: 2,
    jitter: 0,
  },
  calculateWebhookRetryDelay: jest.fn().mockReturnValue(0),
}));

// Mock DLQ storage using factory to avoid hoisting issues
jest.mock('../queue/webhook-dlq', () => ({
  getWebhookDLQStorage: jest.fn().mockReturnValue({
    addEntry: jest.fn(),
    listEntries: jest.fn().mockReturnValue([]),
    getEntry: jest.fn(),
    checkDedupe: jest.fn().mockReturnValue({ exists: false }),
    markReplayed: jest.fn(),
    getStats: jest.fn().mockReturnValue({ total: 0, pending: 0, replayed: 0 }),
  }),
}));

import axios from 'axios';
import { getWebhookDLQStorage } from '../queue/webhook-dlq';

const makePayload = (overrides: Partial<WebhookPayload> = {}): WebhookPayload => ({
  id: 'webhook-1',
  url: 'https://example.com/hook',
  data: { event: 'test' },
  retryCount: 0,
  ...overrides,
});

describe('WebhookService (iterative retry)', () => {
  let service: WebhookService;
  let mockDLQ: ReturnType<typeof getWebhookDLQStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new WebhookService();
    mockDLQ = getWebhookDLQStorage();
  });

  it('succeeds on first attempt without retrying', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });
    await service.send(makePayload());
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(mockDLQ.addEntry).not.toHaveBeenCalled();
  });

  it('retries and succeeds on second attempt', async () => {
    (axios.post as jest.Mock)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload());
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(mockDLQ.addEntry).not.toHaveBeenCalled();
  });

  it('passes a bounded timeout to each delivery attempt', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload());

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        timeout: 10_000,
      }),
    );
  });

  it('treats axios timeout errors as retryable failures', async () => {
    const timeoutError = Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    (axios.post as jest.Mock)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce({ status: 200 });

    const payload = makePayload();
    await service.send(payload);

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(payload.retryCount).toBe(1);
    expect(mockDLQ.addEntry).not.toHaveBeenCalled();
  });

  it('DLQs after all timeout attempts are exhausted', async () => {
    const timeoutError = Object.assign(new Error('timeout of 10000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    (axios.post as jest.Mock).mockRejectedValue(timeoutError);
    (mockDLQ.addEntry as jest.Mock).mockResolvedValueOnce(undefined);

    await service.send(makePayload());

    expect(axios.post).toHaveBeenCalledTimes(4);
    expect(mockDLQ.addEntry).toHaveBeenCalledWith(
      'webhook-1',
      'https://example.com/hook',
      { event: 'test' },
      expect.any(Number),
      expect.stringContaining('timeout of 10000ms exceeded'),
      undefined,
    );
  });

  it('retries and succeeds mid-retry', async () => {
    (axios.post as jest.Mock)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload());
    expect(axios.post).toHaveBeenCalledTimes(3);
    expect(mockDLQ.addEntry).not.toHaveBeenCalled();
  });

  it('sends to DLQ after all retries exhausted', async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error('connection refused'));
    (mockDLQ.addEntry as jest.Mock).mockResolvedValueOnce(undefined);

    await service.send(makePayload());

    expect(axios.post).toHaveBeenCalledTimes(4);
    expect(mockDLQ.addEntry).toHaveBeenCalledTimes(1);
    expect(mockDLQ.addEntry).toHaveBeenCalledWith(
      'webhook-1',
      'https://example.com/hook',
      { event: 'test' },
      expect.any(Number),
      expect.stringContaining('connection refused'),
      undefined,
    );
  });

  it('handles duplicate DLQ entry gracefully', async () => {
    (axios.post as jest.Mock).mockRejectedValue(new Error('fail'));
    (mockDLQ.addEntry as jest.Mock).mockRejectedValueOnce(new Error('DUPLICATE_ENTRY'));

    await expect(service.send(makePayload())).resolves.not.toThrow();
  });

  it('propagates correlation ID header', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload({ correlationId: 'trace-abc' }));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Correlation-Id': 'trace-abc',
        }),
      }),
    );
  });

  it('omits invalid correlation ID header values', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload({ correlationId: 'trace\nX-Injected: true' }));

    const call = (axios.post as jest.Mock).mock.calls[0];
    expect(call[2].headers).not.toHaveProperty('X-Correlation-Id');
  });

  it('adds signature headers when webhookSecret provided', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload({ webhookSecret: 'secret-key' }));

    expect(axios.post).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Signature': 'sha256=test-signature',
          'X-Timestamp': '1234567890',
        }),
      }),
    );
  });

  it('does not add signature headers without webhookSecret', async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({ status: 200 });

    await service.send(makePayload());

    const call = (axios.post as jest.Mock).mock.calls[0];
    expect(call[2].headers).not.toHaveProperty('X-Signature');
  });
});
