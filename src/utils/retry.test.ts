import { withRetry, calculateDelay, sleep } from './retry';

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
});