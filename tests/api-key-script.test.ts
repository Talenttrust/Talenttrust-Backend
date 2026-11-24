import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as path from 'path';
import {
  BASE62_CHARS,
  generateNewApiKey,
  hashApiKey,
  randomBase62,
} from '../scripts/new-api-key';
import { parseApiKeysConfig } from '../src/auth/apiKeysConfig';

describe('scripts/new-api-key', () => {
  describe('import side effects', () => {
    it('has no side effects at import time and does not call process.exit or console methods', () => {
      const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined as never) as any);
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      try {
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../scripts/new-api-key');
        });

        expect(exitSpy).not.toHaveBeenCalled();
        expect(logSpy).not.toHaveBeenCalled();
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
        logSpy.mockRestore();
        errorSpy.mockRestore();
      }
    });
  });

  describe('generateNewApiKey', () => {
    it('matches /^tt__[0-9A-Za-z]{32}$/', () => {
      const keyPattern = /^tt__[0-9A-Za-z]{32}$/;
      for (let i = 0; i < 50; i++) {
        const key = generateNewApiKey();
        expect(key).toMatch(keyPattern);
        expect(key).toHaveLength(36);
        expect(key.startsWith('tt__')).toBe(true);
      }
    });

    it('generates unique keys across calls', () => {
      const count = 500;
      const keys = new Set<string>();
      for (let i = 0; i < count; i++) {
        keys.add(generateNewApiKey());
      }
      expect(keys.size).toBe(count);
    });
  });

  describe('randomBase62 and modulo bias prevention', () => {
    it('generates strings of requested length containing only valid base62 characters', () => {
      expect(randomBase62(0)).toBe('');
      const str10 = randomBase62(10);
      expect(str10).toHaveLength(10);
      for (const char of str10) {
        expect(BASE62_CHARS).toContain(char);
      }

      const str64 = randomBase62(64);
      expect(str64).toHaveLength(64);
      for (const char of str64) {
        expect(BASE62_CHARS).toContain(char);
      }
    });

    it('produces a uniform distribution without modulo bias across all base62 characters', () => {
      const sampleSize = 62000;
      const str = randomBase62(sampleSize);
      expect(str).toHaveLength(sampleSize);

      const counts = new Map<string, number>();
      for (const char of BASE62_CHARS) {
        counts.set(char, 0);
      }
      for (const char of str) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
      }

      // Check all 62 characters appeared
      expect(counts.size).toBe(62);
      for (const [, count] of counts) {
        expect(count).toBeGreaterThan(0);
      }

      // Chi-squared test for goodness of fit:
      // Under H0 (uniform distribution), expected count E = sampleSize / 62 = 1000
      // Degrees of freedom = 61.
      // Critical value at alpha = 0.001 with df = 61 is ~101.
      // Under modulo bias (byte % 62), characters 0-7 have p = 5/256 (~1211), chars 8-61 have p = 4/256 (~969),
      // which yields chiSquared ~ 408 >> 101.
      const expected = sampleSize / 62;
      let chiSquared = 0;
      for (const [, count] of counts) {
        chiSquared += Math.pow(count - expected, 2) / expected;
      }

      // Assert that the distribution is consistent with uniform randomness
      expect(chiSquared).toBeLessThan(105);

      // Verify no modulo bias between first 8 chars ('0'-'7') and remaining 54 chars ('8'-'z')
      const first8Chars = BASE62_CHARS.slice(0, 8);
      const remainingChars = BASE62_CHARS.slice(8);

      let first8Sum = 0;
      for (const ch of first8Chars) first8Sum += counts.get(ch)!;
      let remainingSum = 0;
      for (const ch of remainingChars) remainingSum += counts.get(ch)!;

      const avgFirst8 = first8Sum / 8;
      const avgRemaining = remainingSum / 54;
      const ratio = avgFirst8 / avgRemaining;

      // With modulo bias (256 % 62 = 8), this ratio would be ~1.25 (5/4).
      // With uniform selection, ratio is expected to be ~1.00.
      expect(ratio).toBeGreaterThan(0.95);
      expect(ratio).toBeLessThan(1.05);
    });
  });

  describe('hashApiKey and parseApiKeysConfig integration', () => {
    it('produces sha256:<64 hex chars> matching sha256 of the plaintext key', () => {
      const key = generateNewApiKey();
      const hash = hashApiKey(key);

      expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);

      const expectedDigest = crypto.createHash('sha256').update(key).digest('hex');
      expect(hash).toBe(`sha256:${expectedDigest}`);
    });

    it('output is accepted by parseApiKeysConfig', () => {
      const key1 = generateNewApiKey();
      const key2 = generateNewApiKey();
      const hash1 = hashApiKey(key1);
      const hash2 = hashApiKey(key2);

      const rawJson = JSON.stringify([
        { id: 'ops-1', hash: hash1, scopes: ['disputes:resolve'] },
        { id: 'admin-1', hash: hash2, scopes: ['admin:read', 'contracts:write'], expiresAt: '2027-01-01T00:00:00.000Z' },
      ]);

      const parsed = parseApiKeysConfig(rawJson);
      expect(parsed.keys).toHaveLength(2);

      expect(parsed.keys[0].id).toBe('ops-1');
      expect(parsed.keys[0].hash).toBe(hash1);
      expect(parsed.keys[0].scopes).toEqual(['disputes:resolve']);

      expect(parsed.keys[1].id).toBe('admin-1');
      expect(parsed.keys[1].hash).toBe(hash2);
      expect(parsed.keys[1].scopes).toEqual(['admin:read', 'contracts:write']);
      expect(parsed.keys[1].expiresAt).toBe('2027-01-01T00:00:00.000Z');

      // Verify that byDigest maps correctly
      const digest1 = hash1.replace(/^sha256:/, '');
      expect(parsed.byDigest.get(digest1)?.id).toBe('ops-1');
    });
  });

  describe('CLI script execution', () => {
    const scriptPath = path.resolve(__dirname, '../scripts/new-api-key.ts');
    const tsNodeBin = path.resolve(__dirname, '../node_modules/.bin/ts-node');

    it('prints key and valid JSON entry that parses with parseApiKeysConfig', () => {
      const stdout = execFileSync(
        tsNodeBin,
        [scriptPath, 'ops-1', 'disputes:resolve'],
        { encoding: 'utf8' },
      );

      const lines = stdout.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);

      const keyLine = lines[0].trim();
      expect(keyLine).toMatch(/^tt__[0-9A-Za-z]{32}$/);

      const jsonPart = lines.slice(1).join('\n').trim();
      const parsedEntry = JSON.parse(jsonPart);

      expect(parsedEntry).toEqual({
        id: 'ops-1',
        hash: hashApiKey(keyLine),
        scopes: ['disputes:resolve'],
      });

      // Verify that the JSON entry parses with parseApiKeysConfig
      const parsedConfig = parseApiKeysConfig(JSON.stringify([parsedEntry]));
      expect(parsedConfig.keys).toHaveLength(1);
      expect(parsedConfig.keys[0].id).toBe('ops-1');
      expect(parsedConfig.keys[0].hash).toBe(parsedEntry.hash);
    });

    it('supports --expires-in-days flag when executed via CLI', () => {
      const stdout = execFileSync(
        tsNodeBin,
        [scriptPath, '--expires-in-days', '30', 'contractor-1', 'admin:read'],
        { encoding: 'utf8' },
      );

      const lines = stdout.trim().split('\n');
      const keyLine = lines[0].trim();
      expect(keyLine).toMatch(/^tt__[0-9A-Za-z]{32}$/);

      const jsonPart = lines.slice(1).join('\n').trim();
      const parsedEntry = JSON.parse(jsonPart);

      expect(parsedEntry.id).toBe('contractor-1');
      expect(parsedEntry.hash).toBe(hashApiKey(keyLine));
      expect(parsedEntry.scopes).toEqual(['admin:read']);
      expect(parsedEntry.expiresAt).toBeDefined();

      const parsedConfig = parseApiKeysConfig(JSON.stringify([parsedEntry]));
      expect(parsedConfig.keys).toHaveLength(1);
      expect(parsedConfig.keys[0].expiresAt).toBe(parsedEntry.expiresAt);
    });
  });
});
