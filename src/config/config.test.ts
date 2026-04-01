import { loadConfig } from './index';
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

describe('loadConfig', () => {
  const savedEnv = { ...process.env };

  beforeEach(() => {
    clearConfigEnvVars();
  });

  afterAll(() => {
    process.env = savedEnv;
  });

  it('loads defaults when no env vars are set', () => {
    const cfg = loadConfig();
    expect(cfg.server.port).toBe(3001);
    expect(cfg.server.nodeEnv).toBe('development');
    expect(cfg.server.isProduction).toBe(false);
    expect(cfg.stellar.horizonUrl).toBe(
      'https://horizon-testnet.stellar.org',
    );
    expect(cfg.stellar.networkPassphrase).toBe(
      'Test SDF Network ; September 2015',
    );
    expect(cfg.soroban.rpcUrl).toBe('https://soroban-testnet.stellar.org');
    expect(cfg.soroban.contractId).toBe('');
  });

  it('loads custom server values from environment', () => {
    process.env.PORT = '4000';
    process.env.NODE_ENV = 'production';

    const cfg = loadConfig();
    expect(cfg.server.port).toBe(4000);
    expect(cfg.server.nodeEnv).toBe('production');
    expect(cfg.server.isProduction).toBe(true);
  });

  it('loads custom Stellar values from environment', () => {
    process.env.STELLAR_HORIZON_URL = 'https://horizon.stellar.org';
    process.env.STELLAR_NETWORK_PASSPHRASE =
      'Public Global Stellar Network ; September 2015';

    const cfg = loadConfig();
    expect(cfg.stellar.horizonUrl).toBe('https://horizon.stellar.org');
    expect(cfg.stellar.networkPassphrase).toBe(
      'Public Global Stellar Network ; September 2015',
    );
  });

  it('loads custom Soroban values from environment', () => {
    process.env.SOROBAN_RPC_URL = 'https://soroban.stellar.org';
    process.env.SOROBAN_CONTRACT_ID = 'CABC123';

    const cfg = loadConfig();
    expect(cfg.soroban.rpcUrl).toBe('https://soroban.stellar.org');
    expect(cfg.soroban.contractId).toBe('CABC123');
  });

  it('throws when PORT is not a valid integer', () => {
    process.env.PORT = 'not-a-number';
    expect(() => loadConfig()).toThrow('must be a valid integer');
  });

  it('treats empty PORT as missing and uses default', () => {
    process.env.PORT = '';
    const cfg = loadConfig();
    expect(cfg.server.port).toBe(3001);
  });

  it('treats whitespace-only PORT as missing and uses default', () => {
    process.env.PORT = '   ';
    const cfg = loadConfig();
    expect(cfg.server.port).toBe(3001);
  });

  it('sets isProduction to false for non-production NODE_ENV', () => {
    process.env.NODE_ENV = 'staging';
    const cfg = loadConfig();
    expect(cfg.server.isProduction).toBe(false);
  });

  it('returns a frozen config object', () => {
    const cfg = loadConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.server)).toBe(true);
    expect(Object.isFrozen(cfg.stellar)).toBe(true);
    expect(Object.isFrozen(cfg.soroban)).toBe(true);
  });

  it('produces independent snapshots on repeated calls', () => {
    process.env.PORT = '5000';
    const first = loadConfig();

    process.env.PORT = '6000';
    const second = loadConfig();

    expect(first.server.port).toBe(5000);
    expect(second.server.port).toBe(6000);
  });
});
