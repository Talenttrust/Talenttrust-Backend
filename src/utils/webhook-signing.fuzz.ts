/**
 * Deterministic pseudo-random helpers for webhook HMAC property tests (issue #277).
 * Uses a fixed seed so CI runs are reproducible.
 */

/** Mulberry32 PRNG — returns floats in [0, 1). */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(rng: () => number, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

export function randomBytesHex(rng: () => number, byteLength: number): string {
  let hex = '';
  for (let i = 0; i < byteLength; i++) {
    hex += randomInt(rng, 0, 255).toString(16).padStart(2, '0');
  }
  return hex;
}

export function randomAscii(rng: () => number, length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=\n\r\t';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += chars[randomInt(rng, 0, chars.length - 1)];
  }
  return out;
}
