import { DeduplicationManager } from '../../src/utils/deduplication';


describe('comparePayloadHashes', () => {
  it('returns true for identical hashes', () => {
    const payload = { data: 'same' };
    const hash = DeduplicationManager.computePayloadHash(payload);
    expect(DeduplicationManager.comparePayloadHashes(hash, hash)).toBe(true);
  });

  it('returns false for different hashes of equal length', () => {
    const hash1 = DeduplicationManager.computePayloadHash({ a: 1 });
    const hash2 = DeduplicationManager.computePayloadHash({ a: 2 });
    expect(hash1).not.toBe(hash2);
    expect(DeduplicationManager.comparePayloadHashes(hash1, hash2)).toBe(false);
  });

  it('handles different length hashes without throwing and does not compare mismatched buffers', () => {
    const shortHash = 'abcd'; // intentionally short, not a valid SHA-256 but triggers length guard
    const longHash = 'abcd1234';
    const spy = jest.spyOn(require('crypto'), 'timingSafeEqual');
    const result = DeduplicationManager.comparePayloadHashes(shortHash, longHash);
    expect(result).toBe(false);
    // The guard calls timingSafeEqual once with identical buffers
    expect(spy).toHaveBeenCalledTimes(1);
    const [buf1, buf2] = spy.mock.calls[0];
    expect(buf1.equals(buf2)).toBe(true);
    spy.mockRestore();
  });
});
