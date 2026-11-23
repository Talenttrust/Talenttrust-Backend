import { envInt } from '../src/config';

const NUMERIC_ENV_VARS = [
  'TX_TIMEOUT_SECONDS',
  'DISPUTE_SLA_HOURS',
  'RPC_TIMEOUT_MS',
  'CHAIN_STATUS_TTL_MS',
  'CHAIN_REFRESH_MIN_INTERVAL_MS',
  'CHAIN_READ_TTL_MS',
  'REPUTATION_PRIOR_WEIGHT',
  'PAUSE_CHECK_TTL_MS',
  'INDEXER_INTERVAL_MS',
  'HEALTH_CHECK_TIMEOUT_MS',
  'HEALTH_CACHE_MS',
  'TX_CACHE_MAX',
] as const;

const POSITIVE_ONLY_VARS = [
  'TX_TIMEOUT_SECONDS',
  'DISPUTE_SLA_HOURS',
  'RPC_TIMEOUT_MS',
  'CHAIN_STATUS_TTL_MS',
  'CHAIN_REFRESH_MIN_INTERVAL_MS',
  'PAUSE_CHECK_TTL_MS',
  'HEALTH_CHECK_TIMEOUT_MS',
  'HEALTH_CACHE_MS',
  'TX_CACHE_MAX',
] as const;

const ALLOW_ZERO_VARS = [
  'INDEXER_INTERVAL_MS',
  'CHAIN_READ_TTL_MS',
  'REPUTATION_PRIOR_WEIGHT',
] as const;

function loadConfigWithEnv(overrides: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const key of NUMERIC_ENV_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = saved[k] ?? process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    let loaded!: typeof import('../src/config').config;
    jest.isolateModules(() => {
      loaded = require('../src/config').config;
    });
    return loaded;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('envInt', () => {
  const TEST_VAR = 'TEST_ENV_INT_PARSER';

  afterEach(() => {
    delete process.env[TEST_VAR];
  });

  it('returns default when unset or empty string', () => {
    delete process.env[TEST_VAR];
    expect(envInt(TEST_VAR, { default: 42 })).toBe(42);
    process.env[TEST_VAR] = '';
    expect(envInt(TEST_VAR, { default: 42 })).toBe(42);
  });

  it('parses valid integers and trims surrounding whitespace', () => {
    process.env[TEST_VAR] = '123';
    expect(envInt(TEST_VAR, { default: 1 })).toBe(123);
    process.env[TEST_VAR] = '  75  ';
    expect(envInt(TEST_VAR, { default: 1 })).toBe(75);
  });

  it('enforces allowZero, min, and max bounds', () => {
    process.env[TEST_VAR] = '0';
    expect(() => envInt(TEST_VAR, { default: 5 })).toThrow('Invalid TEST_ENV_INT_PARSER: "0"');
    expect(envInt(TEST_VAR, { default: 5, allowZero: true })).toBe(0);

    process.env[TEST_VAR] = '9';
    expect(() => envInt(TEST_VAR, { default: 10, min: 10, max: 20 })).toThrow('Invalid TEST_ENV_INT_PARSER: "9"');
    process.env[TEST_VAR] = '21';
    expect(() => envInt(TEST_VAR, { default: 10, min: 10, max: 20 })).toThrow('Invalid TEST_ENV_INT_PARSER: "21"');
    process.env[TEST_VAR] = '15';
    expect(envInt(TEST_VAR, { default: 10, min: 10, max: 20 })).toBe(15);
  });

  it.each(['abc', '12.5', '-1', '   ', 'NaN', 'Infinity', '1e3', '10ms'])(
    'throws naming the variable for invalid value %j',
    (raw) => {
      process.env[TEST_VAR] = raw;
      expect(() => envInt(TEST_VAR, { default: 10, allowZero: true })).toThrow(`Invalid ${TEST_VAR}: "${raw}"`);
    },
  );
});

describe('config numeric environment variables', () => {
  it('uses unchanged defaults when all numeric env vars are unset', () => {
    const cfg = loadConfigWithEnv({});
    expect(cfg.txTimeoutSeconds).toBe(300);
    expect(cfg.disputeSlaHours).toBe(72);
    expect(cfg.rpcTimeoutMs).toBe(4000);
    expect(cfg.chainStatusTtlMs).toBe(15000);
    expect(cfg.chainRefreshMinIntervalMs).toBe(5000);
    expect(cfg.chainReadTtlMs).toBe(5000);
    expect(cfg.reputationPriorWeight).toBe(5);
    expect(cfg.pauseCheckTtlMs).toBe(10000);
    expect(cfg.indexerIntervalMs).toBe(0);
    expect(cfg.healthCheckTimeoutMs).toBe(2000);
    expect(cfg.healthCacheMs).toBe(10000);
    expect(cfg.txCacheMax).toBe(200);
  });

  it('parses valid values for every numeric env var', () => {
    const cfg = loadConfigWithEnv({
      TX_TIMEOUT_SECONDS: '600',
      DISPUTE_SLA_HOURS: '48',
      RPC_TIMEOUT_MS: '2500',
      CHAIN_STATUS_TTL_MS: '30000',
      CHAIN_REFRESH_MIN_INTERVAL_MS: '1000',
      CHAIN_READ_TTL_MS: '250',
      REPUTATION_PRIOR_WEIGHT: '12',
      PAUSE_CHECK_TTL_MS: '15000',
      INDEXER_INTERVAL_MS: '5000',
      HEALTH_CHECK_TIMEOUT_MS: '1500',
      HEALTH_CACHE_MS: '8000',
      TX_CACHE_MAX: '500',
    });
    expect(cfg.txTimeoutSeconds).toBe(600);
    expect(cfg.disputeSlaHours).toBe(48);
    expect(cfg.rpcTimeoutMs).toBe(2500);
    expect(cfg.chainStatusTtlMs).toBe(30000);
    expect(cfg.chainRefreshMinIntervalMs).toBe(1000);
    expect(cfg.chainReadTtlMs).toBe(250);
    expect(cfg.reputationPriorWeight).toBe(12);
    expect(cfg.pauseCheckTtlMs).toBe(15000);
    expect(cfg.indexerIntervalMs).toBe(5000);
    expect(cfg.healthCheckTimeoutMs).toBe(1500);
    expect(cfg.healthCacheMs).toBe(8000);
    expect(cfg.txCacheMax).toBe(500);
  });

  it('accepts zero for allowZero env vars', () => {
    const cfg = loadConfigWithEnv({
      INDEXER_INTERVAL_MS: '0',
      CHAIN_READ_TTL_MS: '0',
      REPUTATION_PRIOR_WEIGHT: '0',
    });
    expect(cfg.indexerIntervalMs).toBe(0);
    expect(cfg.chainReadTtlMs).toBe(0);
    expect(cfg.reputationPriorWeight).toBe(0);
  });

  it.each(POSITIVE_ONLY_VARS)('rejects zero for %s', (name) => {
    expect(() => loadConfigWithEnv({ [name]: '0' })).toThrow(`Invalid ${name}: "0"`);
  });

  it.each([...POSITIVE_ONLY_VARS, ...ALLOW_ZERO_VARS])('fails fast on invalid value for %s', (name) => {
    expect(() => loadConfigWithEnv({ [name]: 'not-a-number' })).toThrow(`Invalid ${name}: "not-a-number"`);
    expect(() => loadConfigWithEnv({ [name]: '-5' })).toThrow(`Invalid ${name}: "-5"`);
    expect(() => loadConfigWithEnv({ [name]: '3.14' })).toThrow(`Invalid ${name}: "3.14"`);
  });
});
