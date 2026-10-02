import {
  canonicalizeJson,
  computeIdempotencyFingerprint,
} from './idempotencyFingerprint';

describe('canonicalizeJson', () => {
  it('is order-insensitive for object keys', () => {
    expect(canonicalizeJson({ a: 1, b: 2 })).toBe(
      canonicalizeJson({ b: 2, a: 1 }),
    );
  });

  it('handles nested objects and arrays deterministically', () => {
    const value = { a: [1, { b: 2, c: [3, 4] }], d: null };
    expect(canonicalizeJson(value)).toBe(canonicalizeJson(value));
  });

  it('preserves array order (arrays are not sorted)', () => {
    expect(canonicalizeJson([1, 2])).not.toBe(canonicalizeJson([2, 1]));
  });

  it('canonicalizes undefined to null', () => {
    expect(canonicalizeJson(undefined)).toBe('null');
  });

  it('canonicalizes primitives', () => {
    expect(canonicalizeJson('x')).toBe('"x"');
    expect(canonicalizeJson(5)).toBe('5');
    expect(canonicalizeJson(null)).toBe('null');
  });
});

describe('computeIdempotencyFingerprint', () => {
  const base = {
    method: 'POST',
    path: '/api/v1/contracts',
    tenantId: 'user-1',
    body: { title: 'Milestone', budget: 100 },
  };

  it('is deterministic for identical input', () => {
    expect(computeIdempotencyFingerprint(base)).toBe(
      computeIdempotencyFingerprint(base),
    );
  });

  it('is body-order-insensitive', () => {
    expect(
      computeIdempotencyFingerprint({
        ...base,
        body: { budget: 100, title: 'Milestone' },
      }),
    ).toBe(computeIdempotencyFingerprint(base));
  });

  it('differs when the body changes', () => {
    expect(
      computeIdempotencyFingerprint({ ...base, body: { title: 'Other' } }),
    ).not.toBe(computeIdempotencyFingerprint(base));
  });

  it('differs when the tenant changes', () => {
    expect(
      computeIdempotencyFingerprint({ ...base, tenantId: 'user-2' }),
    ).not.toBe(computeIdempotencyFingerprint(base));
  });

  it('differs when the method or path changes', () => {
    expect(computeIdempotencyFingerprint({ ...base, method: 'PATCH' })).not.toBe(
      computeIdempotencyFingerprint(base),
    );
    expect(
      computeIdempotencyFingerprint({ ...base, path: '/api/v1/other' }),
    ).not.toBe(computeIdempotencyFingerprint(base));
  });
});
