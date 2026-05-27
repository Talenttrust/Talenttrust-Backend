import { loadConfig } from '../appConfiguration';
import {
  getEnv,
  requireEnv,
  optionalEnv,
  parseIntEnv,
  parseBoolEnv,
} from './env';

const CONFIG_ENV_KEYS = [
  'NODE_ENV',
  'PORT',
  'STELLAR_HORIZON_URL',
  'STELLAR_NETWORK_PASSPHRASE',
  'SOROBAN_RPC_URL',
  'SOROBAN_CONTRACT_ID',
  'ALLOWED_ASSETS',
];

function clearConfigEnvVars(): void {
  for (const key of CONFIG_ENV_KEYS) {
    delete process.env[key];
  }
}

describe('env utilities', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    clearConfigEnvVars();
    delete process.env.TEST_VAR;
    delete process.env.TEST_PORT;
    delete process.env.TEST_BOOL;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  describe('getEnv', () => {
    it('returns the value when set', () => {
      process.env.TEST_VAR = 'hello';
      expect(getEnv('TEST_VAR')).toBe('hello');
    });

    it('returns undefined for missing variable', () => {
      expect(getEnv('NONEXISTENT_VAR_XYZ')).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      process.env.TEST_VAR = '';
      expect(getEnv('TEST_VAR')).toBeUndefined();
    });

    it('returns undefined for whitespace-only string', () => {
      process.env.TEST_VAR = '   ';
      expect(getEnv('TEST_VAR')).toBeUndefined();
    });

    it('trims surrounding whitespace', () => {
      process.env.TEST_VAR = '  hello  ';
      expect(getEnv('TEST_VAR')).toBe('hello');
    });
  });

  describe('requireEnv', () => {
    it('returns the value when set', () => {
      process.env.TEST_VAR = 'required_value';
      expect(requireEnv('TEST_VAR')).toBe('required_value');
    });

    it('throws for missing variable', () => {
      expect(() => requireEnv('MISSING_VAR_XYZ')).toThrow(
        'Missing required environment variable: MISSING_VAR_XYZ',
      );
    });

    it('throws for empty string', () => {
      process.env.TEST_VAR = '';
      expect(() => requireEnv('TEST_VAR')).toThrow(
        'Missing required environment variable: TEST_VAR',
      );
    });

    it('throws for whitespace-only string', () => {
      process.env.TEST_VAR = '   ';
      expect(() => requireEnv('TEST_VAR')).toThrow(
        'Missing required environment variable: TEST_VAR',
      );
    });
  });

  describe('optionalEnv', () => {
    it('returns the value when set', () => {
      process.env.TEST_VAR = 'custom';
      expect(optionalEnv('TEST_VAR', 'default')).toBe('custom');
    });

    it('returns default when missing', () => {
      expect(optionalEnv('MISSING_VAR_XYZ', 'fallback')).toBe('fallback');
    });

    it('returns default for empty string', () => {
      process.env.TEST_VAR = '';
      expect(optionalEnv('TEST_VAR', 'fallback')).toBe('fallback');
    });

    it('returns default for whitespace-only string', () => {
      process.env.TEST_VAR = '   ';
      expect(optionalEnv('TEST_VAR', 'fallback')).toBe('fallback');
    });
  });

  describe('parseIntEnv', () => {
    it('parses a valid integer', () => {
      process.env.TEST_PORT = '8080';
      expect(parseIntEnv('TEST_PORT', 3000)).toBe(8080);
    });

    it('parses zero', () => {
      process.env.TEST_PORT = '0';
      expect(parseIntEnv('TEST_PORT', 3000)).toBe(0);
    });

    it('parses negative integer', () => {
      process.env.TEST_PORT = '-1';
      expect(parseIntEnv('TEST_PORT', 3000)).toBe(-1);
    });

    it('returns default when missing', () => {
      expect(parseIntEnv('MISSING_PORT_XYZ', 3000)).toBe(3000);
    });

    it('returns default for empty string', () => {
      process.env.TEST_PORT = '';
      expect(parseIntEnv('TEST_PORT', 3000)).toBe(3000);
    });

    it('throws for non-numeric value', () => {
      process.env.TEST_PORT = 'abc';
      expect(() => parseIntEnv('TEST_PORT', 3000)).toThrow(
        'must be a valid integer',
      );
    });

    it('throws for float value', () => {
      process.env.TEST_PORT = '3.14';
      expect(() => parseIntEnv('TEST_PORT', 3000)).toThrow(
        'must be a valid integer',
      );
    });

    it('throws for Infinity', () => {
      process.env.TEST_PORT = 'Infinity';
      expect(() => parseIntEnv('TEST_PORT', 3000)).toThrow(
        'must be a valid integer',
      );
    });

    it('throws for NaN', () => {
      process.env.TEST_PORT = 'NaN';
      expect(() => parseIntEnv('TEST_PORT', 3000)).toThrow(
        'must be a valid integer',
      );
    });
  });

  describe('parseBoolEnv', () => {
    it('parses "true"', () => {
      process.env.TEST_BOOL = 'true';
      expect(parseBoolEnv('TEST_BOOL', false)).toBe(true);
    });

    it('parses "TRUE" (case-insensitive)', () => {
      process.env.TEST_BOOL = 'TRUE';
      expect(parseBoolEnv('TEST_BOOL', false)).toBe(true);
    });

    it('parses "True" (mixed case)', () => {
      process.env.TEST_BOOL = 'True';
      expect(parseBoolEnv('TEST_BOOL', false)).toBe(true);
    });

    it('parses "1" as true', () => {
      process.env.TEST_BOOL = '1';
      expect(parseBoolEnv('TEST_BOOL', false)).toBe(true);
    });

    it('parses "false"', () => {
      process.env.TEST_BOOL = 'false';
      expect(parseBoolEnv('TEST_BOOL', true)).toBe(false);
    });

    it('parses "FALSE" (case-insensitive)', () => {
      process.env.TEST_BOOL = 'FALSE';
      expect(parseBoolEnv('TEST_BOOL', true)).toBe(false);
    });

    it('parses "0" as false', () => {
      process.env.TEST_BOOL = '0';
      expect(parseBoolEnv('TEST_BOOL', true)).toBe(false);
    });

    it('returns default when missing', () => {
      expect(parseBoolEnv('MISSING_BOOL_XYZ', true)).toBe(true);
    });

    it('returns default for empty string', () => {
      process.env.TEST_BOOL = '';
      expect(parseBoolEnv('TEST_BOOL', true)).toBe(true);
    });

    it('throws for invalid boolean string', () => {
      process.env.TEST_BOOL = 'yes';
      expect(() => parseBoolEnv('TEST_BOOL', false)).toThrow(
        'must be "true" or "false"',
      );
    });

    it('throws for arbitrary string', () => {
      process.env.TEST_BOOL = 'maybe';
      expect(() => parseBoolEnv('TEST_BOOL', false)).toThrow(
        'must be "true" or "false"',
      );
    });
  });
});

describe('loadConfig (appConfiguration)', () => {
  const savedEnv = { ...process.env };

  afterAll(() => {
    process.env = savedEnv;
  });

  it('applies default port and upstream when env is minimal', () => {
    clearConfigEnvVars();
    delete process.env.PORT;
    const cfg = loadConfig();
    expect(cfg.port).toBe(3001);
    expect(cfg.upstreamContractsUrl).toBe('https://example.invalid/contracts');
  });

  describe('allowedAssets', () => {
    beforeEach(() => {
      clearConfigEnvVars();
      delete process.env.ALLOWED_ASSETS;
    });

    it('returns default assets when ALLOWED_ASSETS is not set', () => {
      const cfg = loadConfig({});
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM', 'BTC', 'ETH']);
    });

    it('parses a comma-separated list from ALLOWED_ASSETS', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: 'USDC,XLM' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM']);
    });

    it('normalises asset codes to uppercase', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: 'usdc,xlm,eth' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM', 'ETH']);
    });

    it('trims whitespace from each asset code', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: ' USDC , XLM ' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM']);
    });

    it('filters out empty segments from ALLOWED_ASSETS', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: 'USDC,,XLM,' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM']);
    });

    it('returns a single-element list when one asset is provided', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: 'USDC' });
      expect(cfg.allowedAssets).toEqual(['USDC']);
    });

    it('returns default assets when ALLOWED_ASSETS is an empty string', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: '' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM', 'BTC', 'ETH']);
    });
  });
});

describe('loadConfig — circuit breaker config', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    delete process.env.CB_FAILURE_THRESHOLD;
    delete process.env.CB_SUCCESS_THRESHOLD;
    delete process.env.CB_TIMEOUT_MS;
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('uses defaults when CB env vars are absent', () => {
    const cfg = loadConfig({});
    expect(cfg.circuitBreaker).toEqual({
      failureThreshold: 5,
      successThreshold: 1,
      timeoutMs: 30_000,
    });
  });

  it('reads CB_FAILURE_THRESHOLD from env', () => {
    const cfg = loadConfig({ CB_FAILURE_THRESHOLD: '10' });
    expect(cfg.circuitBreaker.failureThreshold).toBe(10);
  });

  it('reads CB_SUCCESS_THRESHOLD from env', () => {
    const cfg = loadConfig({ CB_SUCCESS_THRESHOLD: '3' });
    expect(cfg.circuitBreaker.successThreshold).toBe(3);
  });

  it('reads CB_TIMEOUT_MS from env', () => {
    const cfg = loadConfig({ CB_TIMEOUT_MS: '60000' });
    expect(cfg.circuitBreaker.timeoutMs).toBe(60_000);
  });

  it('clamps CB_FAILURE_THRESHOLD to minimum of 1', () => {
    const cfg = loadConfig({ CB_FAILURE_THRESHOLD: '0' });
    expect(cfg.circuitBreaker.failureThreshold).toBe(1);
  });

  it('clamps CB_TIMEOUT_MS to minimum of 1000', () => {
    const cfg = loadConfig({ CB_TIMEOUT_MS: '0' });
    expect(cfg.circuitBreaker.timeoutMs).toBe(1_000);
  });
});
