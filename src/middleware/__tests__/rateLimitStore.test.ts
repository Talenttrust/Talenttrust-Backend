/**
 * @description Unit tests for RateLimitStore.
 *
 * Coverage targets:
 *   - key hashing (opaque, deterministic)
 *   - get / set / delete CRUD
 *   - sweep removes expired-window + expired-block entries
 *   - sweep retains entries that are still within window or still blocked
 *   - destroy stops the timer and clears the store
 */

import { RateLimitStore, RateLimitEntry } from '../../lib/rateLimitStore';

//  Helpers 

function makeEntry(overrides: Partial<RateLimitEntry> = {}): RateLimitEntry {
  return {
    count: 1,
    windowStart: Date.now(),
    blocked: false,
    blockedUntil: 0,
    ...overrides,
  };
}

// Tests

describe('RateLimitStore', () => {
  let store: RateLimitStore;

  beforeEach(() => {
    // sweepIntervalMs=0 disables the background timer (Infinity avoids firing)
    store = new RateLimitStore({ sweepIntervalMs: 9_999_999 });
  });

  afterEach(() => {
    store.destroy();
  });


  describe('hashKey', () => {
    it('returns a 64-char hex string', () => {
      const hash = RateLimitStore.hashKey('127.0.0.1');
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('is deterministic for the same input', () => {
      expect(RateLimitStore.hashKey('192.168.1.1')).toBe(
        RateLimitStore.hashKey('192.168.1.1'),
      );
    });

    it('produces different hashes for different inputs', () => {
      expect(RateLimitStore.hashKey('1.1.1.1')).not.toBe(
        RateLimitStore.hashKey('8.8.8.8'),
      );
    });

    it('does NOT expose the raw key in the hash', () => {
      const hash = RateLimitStore.hashKey('192.168.0.1');
      expect(hash).not.toContain('192.168.0.1');
    });
  });

  describe('get / set / delete', () => {
    it('returns undefined for an unknown key', () => {
      expect(store.get('unknown-key')).toBeUndefined();
    });

    it('stores and retrieves an entry', () => {
      const entry = makeEntry({ count: 5 });
      store.set('ip-a', entry);
      expect(store.get('ip-a')).toEqual(entry);
    });

    it('increments size on set', () => {
      store.set('ip-a', makeEntry());
      store.set('ip-b', makeEntry());
      expect(store.size).toBe(2);
    });

    it('overwrites an existing entry', () => {
      store.set('ip-a', makeEntry({ count: 1 }));
      store.set('ip-a', makeEntry({ count: 99 }));
      expect(store.get('ip-a')?.count).toBe(99);
    });

    it('deletes an entry', () => {
      store.set('ip-a', makeEntry());
      store.delete('ip-a');
      expect(store.get('ip-a')).toBeUndefined();
      expect(store.size).toBe(0);
    });

    it('delete on a missing key is a no-op', () => {
      expect(() => store.delete('nonexistent')).not.toThrow();
    });
  });

  describe('sweep', () => {
    const WINDOW = 60_000;

    it('removes entries whose window has expired and are not blocked', () => {
      const old = makeEntry({ windowStart: Date.now() - WINDOW - 1 });
      store.set('old-ip', old);
      store.sweep(WINDOW);
      expect(store.get('old-ip')).toBeUndefined();
    });

    it('retains entries still within the active window', () => {
      const fresh = makeEntry({ windowStart: Date.now() });
      store.set('fresh-ip', fresh);
      store.sweep(WINDOW);
      expect(store.get('fresh-ip')).toBeDefined();
    });

    it('retains entries that are hard-blocked even if window expired', () => {
      const blocked = makeEntry({
        windowStart: Date.now() - WINDOW - 1,
        blocked: true,
        blockedUntil: Date.now() + 60_000,
      });
      store.set('blocked-ip', blocked);
      store.sweep(WINDOW);
      expect(store.get('blocked-ip')).toBeDefined();
    });

    it('removes entries whose block has also expired', () => {
      const expiredBlock = makeEntry({
        windowStart: Date.now() - WINDOW - 1,
        blocked: true,
        blockedUntil: Date.now() - 1, // already in the past
      });
      store.set('expired-block-ip', expiredBlock);
      store.sweep(WINDOW);
      expect(store.get('expired-block-ip')).toBeUndefined();
    });

    it('only removes qualifying entries, leaving others intact', () => {
      const old = makeEntry({ windowStart: Date.now() - WINDOW - 1 });
      const fresh = makeEntry({ windowStart: Date.now() });
      store.set('old-ip', old);
      store.set('fresh-ip', fresh);
      store.sweep(WINDOW);
      expect(store.get('old-ip')).toBeUndefined();
      expect(store.get('fresh-ip')).toBeDefined();
    });
  });


  describe('destroy', () => {
    it('clears all entries', () => {
      store.set('ip-a', makeEntry());
      store.set('ip-b', makeEntry());
      store.destroy();
      expect(store.size).toBe(0);
    });

    it('can be called multiple times without throwing', () => {
      expect(() => {
        store.destroy();
        store.destroy();
      }).not.toThrow();
    });
  });
});