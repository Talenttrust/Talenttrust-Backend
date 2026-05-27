import { buildEtag, isIfNoneMatchSatisfied } from './etag';

describe('etag utils', () => {
  it('builds stable etags for the same scope and payload', () => {
    const payload = { records: [{ id: '1', value: '***REDACTED***' }], total: 1 };
    const tag1 = buildEtag('contract-metadata:list:contract-1', payload);
    const tag2 = buildEtag('contract-metadata:list:contract-1', payload);

    expect(tag1).toBe(tag2);
    expect(tag1.startsWith('"')).toBe(true);
    expect(tag1.endsWith('"')).toBe(true);
  });

  it('changes etag when payload changes', () => {
    const tag1 = buildEtag('contract-metadata:item:meta-1', { value: 'v1' });
    const tag2 = buildEtag('contract-metadata:item:meta-1', { value: 'v2' });

    expect(tag1).not.toBe(tag2);
  });

  it('matches If-None-Match for exact and weak tags', () => {
    const etag = buildEtag('scope', { ok: true });
    expect(isIfNoneMatchSatisfied(etag, etag)).toBe(true);
    expect(isIfNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
    expect(isIfNoneMatchSatisfied(`"other", W/${etag}`, etag)).toBe(true);
  });

  it('supports wildcard If-None-Match', () => {
    const etag = buildEtag('scope', { ok: true });
    expect(isIfNoneMatchSatisfied('*', etag)).toBe(true);
  });

  it('returns false when If-None-Match does not match', () => {
    const etag = buildEtag('scope', { ok: true });
    expect(isIfNoneMatchSatisfied('"different"', etag)).toBe(false);
    expect(isIfNoneMatchSatisfied(undefined, etag)).toBe(false);
  });
});
