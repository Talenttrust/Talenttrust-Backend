import { InMemoryIdempotencyStore } from '../db/idempotencyStore';
import {
  hashEventPayload,
  IdempotencyConflictError,
  runIdempotentEvent,
} from './idempotency';
import { redact } from './redact';

describe('event idempotency', () => {
  it('stores the payload hash and result on the first write path', async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await runIdempotentEvent(
      'event-1',
      { amount: 100, currency: 'USD' },
      () => ({ accepted: true }),
      { store },
    );

    expect(result).toEqual({
      result: { accepted: true },
      replayed: false,
      payloadHash: hashEventPayload({ currency: 'USD', amount: 100 }),
    });
    expect(store.get('event-1')).toMatchObject({
      key: 'event-1',
      payloadHash: result.payloadHash,
      result: { accepted: true },
    });
  });

  it('returns the cached result for duplicate keys with identical canonical payloads', async () => {
    const store = new InMemoryIdempotencyStore();
    const handler = jest.fn(() => ({ status: 'processed' }));

    await runIdempotentEvent(
      'event-2',
      { nested: { b: 2, a: 1 }, tags: ['escrow', 'funded'] },
      handler,
      { store },
    );
    const replay = await runIdempotentEvent(
      'event-2',
      { tags: ['escrow', 'funded'], nested: { a: 1, b: 2 } },
      () => ({ status: 'should-not-run' }),
      { store },
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      result: { status: 'processed' },
      replayed: true,
    });
  });

  it('rejects duplicate keys with conflicting payloads as a safe 409', async () => {
    const store = new InMemoryIdempotencyStore();
    const logger = { warn: jest.fn() };

    await runIdempotentEvent('event-3', { amount: 100 }, () => ({ accepted: true }), {
      store,
      logger,
    });

    await expect(
      runIdempotentEvent('event-3', { amount: 200 }, () => ({ accepted: false }), {
        store,
        logger,
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_PAYLOAD_CONFLICT',
      statusCode: 409,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      'Rejected conflicting event idempotency replay',
      expect.objectContaining({
        idempotencyKey: 'event-3',
        receivedPayload: '[REDACTED_PAYLOAD]',
      }),
    );
  });

  it('rejects empty idempotency keys before hashing or processing', async () => {
    await expect(
      runIdempotentEvent('   ', { amount: 100 }, () => ({ accepted: true })),
    ).rejects.toThrow(TypeError);
  });

  it('exposes a conflict error that can be translated directly to HTTP 409', () => {
    const error = new IdempotencyConflictError('event-4');

    expect(error.message).not.toContain('event-4');
    expect(error.statusCode).toBe(409);
  });

  it('handles malformed stored hashes without leaking comparison timing errors', async () => {
    const store = new InMemoryIdempotencyStore();

    store.set({
      key: 'event-5',
      payloadHash: '00',
      result: { accepted: true },
      createdAt: new Date(),
    });

    await expect(
      runIdempotentEvent('event-5', { amount: 100 }, () => ({ accepted: false }), { store }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('supports clearing stored idempotency records', () => {
    const store = new InMemoryIdempotencyStore();

    store.set({
      key: 'event-6',
      payloadHash: hashEventPayload({ amount: 100 }),
      result: { accepted: true },
      createdAt: new Date(),
    });
    store.clear();

    expect(store.get('event-6')).toBeUndefined();
  });

  it('redacts nested arrays and secret-bearing metadata fields', () => {
    expect(
      redact({
        headers: [{ authorization: 'Bearer secret' }],
        nested: { apiKey: 'key', safe: 'visible' },
      }),
    ).toEqual({
      headers: [{ authorization: '[REDACTED]' }],
      nested: { apiKey: '[REDACTED]', safe: 'visible' },
    });
  });
});
