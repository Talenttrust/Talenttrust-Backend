import {
  validateCreateAuditEntryInput,
  validateMetadata,
  MAX_METADATA_BYTES,
  MAX_METADATA_STRING_LENGTH,
  validateCreateAuditEntry,
  readValidatedBody,
} from './inputValidation';
import type { Request, Response } from 'express';

const body = (metadata: unknown = {}) => ({
  action: 'CONTRACT_CREATED',
  severity: 'INFO',
  actor: 'user-1',
  resource: 'contract',
  resourceId: 'c-1',
  metadata,
});

describe('audit validation boundary regressions', () => {
  it('clears an earlier validated handoff when a subsequent validation fails', () => {
    const response = { locals: {}, status: jest.fn().mockReturnThis(), json: jest.fn() };
    const res = response as unknown as Response;
    const next = jest.fn();
    validateCreateAuditEntry({ body: body() } as Request, res, next);
    expect(readValidatedBody(res).actor).toBe('user-1');
    validateCreateAuditEntry({ body: {} } as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(() => readValidatedBody(res)).toThrow(/middleware must run/);
  });

  it('bounds traversal of shared expanding trees and limits reported problems', () => {
    const leaf = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`v${i}`, 0]));
    const branch = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`v${i}`, leaf]));
    const large = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`v${i}`, branch]));
    const issues = validateMetadata(large);
    expect(issues.some((issue) => issue.code === 'metadata_too_large')).toBe(true);
    expect(issues.length).toBeLessThanOrEqual(64);
    const invalid = validateCreateAuditEntryInput({
      ...body(),
      ...Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`extra${i}`, true])),
    });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues).toHaveLength(64);
  });

  it.each([new Date(), new Map(), new Set(), /secret/, Object.create({ inherited: true })])(
    'rejects non-JSON record metadata %p',
    (metadata) => {
      expect(validateMetadata(metadata).length).toBeGreaterThan(0);
      expect(validateCreateAuditEntryInput(body({ nested: metadata })).ok).toBe(false);
    },
  );

  it('never invokes metadata getters or serialization hooks', () => {
    const getter = jest.fn(() => 'safe');
    const metadata = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: getter,
    });
    expect(validateCreateAuditEntryInput(body(metadata)).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const toJSON = jest.fn(() => ({ injected: 'secret' }));
    const hiddenHook = Object.defineProperty({ safe: true }, 'toJSON', { value: toJSON });
    const result = validateCreateAuditEntryInput(body(hiddenHook));
    if (result.ok) expect(JSON.stringify(result.data.metadata)).toBe('{"safe":true}');
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('does not throw or execute accessors on the outer payload', () => {
    const getter = jest.fn(() => {
      throw new Error('secret-token');
    });
    const input = Object.defineProperty(body(), 'actor', {
      enumerable: true,
      get: getter,
    });
    expect(() => validateCreateAuditEntryInput(input)).not.toThrow();
    expect(validateCreateAuditEntryInput(input).ok).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(() => validateCreateAuditEntryInput(proxy)).not.toThrow();
    expect(validateCreateAuditEntryInput(proxy).ok).toBe(false);
  });

  it('publishes an independent JSON snapshot for repeated and concurrent producers', async () => {
    const shared = { items: [1, { amount: 2 }] };
    const input = body({ a: shared, b: shared });
    const results = await Promise.all([0, 1].map(async () => validateCreateAuditEntryInput(input)));
    shared.items.push(999);
    for (const result of results) {
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data.metadata).toEqual({
          a: { items: [1, { amount: 2 }] },
          b: { items: [1, { amount: 2 }] },
        });
    }
    expect((input.metadata as { a: unknown }).a).toBe(shared);
  });

  it('rejects sparse arrays rather than silently serializing holes as null', () => {
    expect(validateCreateAuditEntryInput(body({ items: new Array(2) })).ok).toBe(false);
  });

  it('does not expose hostile field names in validation diagnostics', () => {
    const secret = 'secret-token\n'.repeat(500);
    const result = validateCreateAuditEntryInput({ ...body(), [secret]: true });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-token');
    expect(JSON.stringify(result).length).toBeLessThan(1000);
    const nested = validateCreateAuditEntryInput(body({ [secret]: true }));
    expect(JSON.stringify(nested)).not.toContain('secret-token');
  });

  it('accepts exact serialized byte limit and rejects one byte beyond it', () => {
    const metadata = {
      a: 'x'.repeat(MAX_METADATA_STRING_LENGTH),
      b: 'x'.repeat(MAX_METADATA_STRING_LENGTH),
      c: 'x'.repeat(MAX_METADATA_STRING_LENGTH),
      d: '',
    };
    const overhead = Buffer.byteLength(JSON.stringify(metadata));
    metadata.d = 'x'.repeat(MAX_METADATA_BYTES - overhead);
    expect(validateCreateAuditEntryInput(body(metadata)).ok).toBe(true);
    metadata.d += 'x';
    expect(validateCreateAuditEntryInput(body(metadata)).ok).toBe(false);
  });
});
