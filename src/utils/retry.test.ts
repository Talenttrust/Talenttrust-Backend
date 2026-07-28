import { withRetry, calculateDelay, parseRetryAfter } from './retry';

describe('parseRetryAfter', () => {
  it('parses delta-seconds as milliseconds', () => {
    expect(parseRetryAfter('120', 300000)).toBe(120000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('1')).toBe(1000);
  });

  it('clamps to maxRetryAfterMs', () => {
    expect(parseRetryAfter('999999', 5000)).toBe(5000);
  });

  it('parses HTTP-date format', () => {
    const future = new Date(Date.now() + 30000);
    const result = parseRetryAfter(future.toUTCString(), 60000);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(60000);
  });

  it('returns 0 for past HTTP-date', () => {
    const past = new Date(Date.now() - 60000);
    expect(parseRetryAfter(past.toUTCString())).toBe(0);
  });

  it('returns null for malformed values', () => {
    expect(parseRetryAfter('not-a-date')).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
  });
});

describe('calculateDelay', () => {
  it('returns exponential backoff', () => {
    expect(calculateDelay(0, 200, 5000, false)).toBe(200);
    expect(calculateDelay(1, 200, 5000, false)).toBe(400);
    expect(calculateDelay(2, 200, 5000, false)).toBe(800);
  });

  it('caps at maxDelayMs', () => {
    expect(calculateDelay(10, 200, 500, false)).toBe(500);
  });

  it('applies jitter within range', () => {
    const delay = calculateDelay(1, 200, 5000, true);
    expect(delay).toBeGreaterThanOrEqual(200);
    expect(delay).toBeLessThanOrEqual(400);
  });
});

describe('withRetry', () => {
  it('returns on first success', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and eventually succeeds', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, { baseDelayMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after max attempts', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('always fails'));
    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 0 })
    ).rejects.toThrow('always fails');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry if isRetryable returns false', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('not retryable'));
    await expect(
      withRetry(fn, { isRetryable: () => false, baseDelayMs: 0 })
    ).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('honors retryAfterHeader over calculated backoff', async () => {
    const fn = jest.fn()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValue('ok');
    await expect(
      withRetry(fn, { maxAttempts: 2, retryAfterHeader: '1' })
    ).resolves.toBe('ok');
  });
});