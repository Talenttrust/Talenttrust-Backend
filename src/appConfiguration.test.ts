/**
 * @file src/appConfiguration.test.ts
 * @description Comprehensive unit tests verifying state invariant protections in appConfiguration.
 */

import {
  loadConfig,
  deepFreeze,
  parseAssets,
  appConfigManager,
  ConfigurationStateManager,
  ConfigurationAuthError,
  AppConfig,
} from './appConfiguration';

describe('appConfiguration state invariant protections', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SSRF_ALLOW_PRIVATE_HOSTS;
    appConfigManager.reset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('Immutability and Deep Object Freezing', () => {
    it('returns a deeply frozen AppConfig object and nested structures', () => {
      const cfg = loadConfig({});

      expect(Object.isFrozen(cfg)).toBe(true);
      expect(Object.isFrozen(cfg.circuitBreaker)).toBe(true);
      expect(Object.isFrozen(cfg.webhookRetry)).toBe(true);
      expect(Object.isFrozen(cfg.webhookCircuitBreaker)).toBe(true);
      expect(Object.isFrozen(cfg.healthProbes)).toBe(true);
      expect(Object.isFrozen(cfg.allowedAssets)).toBe(true);
      expect(Object.isFrozen(cfg.chaosTargets)).toBe(true);
    });

    it('prevents direct mutation of root properties in strict mode', () => {
      const cfg = loadConfig({});

      expect(() => {
        (cfg as any).port = 9000;
      }).toThrow(TypeError);
    });

    it('prevents mutation of nested configuration objects in strict mode', () => {
      const cfg = loadConfig({});

      expect(() => {
        (cfg.circuitBreaker as any).failureThreshold = 999;
      }).toThrow(TypeError);

      expect(() => {
        (cfg.webhookRetry as any).initialDelayMs = 0;
      }).toThrow(TypeError);
    });

    it('prevents mutation or pushing to array properties in strict mode', () => {
      const cfg = loadConfig({});

      expect(() => {
        (cfg.allowedAssets as any).push('HACK');
      }).toThrow(TypeError);

      expect(() => {
        (cfg.chaosTargets as any).push('all');
      }).toThrow(TypeError);
    });

    it('deepFreeze handles circular references safely without throwing', () => {
      const circular: any = { a: 1 };
      circular.self = circular;

      expect(() => deepFreeze(circular)).not.toThrow();
      expect(Object.isFrozen(circular)).toBe(true);
    });
  });

  describe('Cross-Field Relational Invariants', () => {
    it('enforces webhookRetry maxDelayMs >= initialDelayMs when initial exceeds max', () => {
      const cfg = loadConfig({
        WEBHOOK_RETRY_INITIAL_DELAY_MS: '45000',
        WEBHOOK_RETRY_MAX_DELAY_MS: '5000',
      });

      expect(cfg.webhookRetry.initialDelayMs).toBe(45000);
      expect(cfg.webhookRetry.maxDelayMs).toBe(45000);
      expect(cfg.webhookRetry.maxDelayMs).toBeGreaterThanOrEqual(cfg.webhookRetry.initialDelayMs);
    });

    it('preserves valid webhookRetry maxDelayMs when it is greater than initialDelayMs', () => {
      const cfg = loadConfig({
        WEBHOOK_RETRY_INITIAL_DELAY_MS: '1000',
        WEBHOOK_RETRY_MAX_DELAY_MS: '30000',
      });

      expect(cfg.webhookRetry.initialDelayMs).toBe(1000);
      expect(cfg.webhookRetry.maxDelayMs).toBe(30000);
    });

    it('clamps webhook retry multiplier to minimum 1', () => {
      const cfg = loadConfig({ WEBHOOK_RETRY_MULTIPLIER: '0.5' });
      expect(cfg.webhookRetry.multiplier).toBe(1);
    });

    it('clamps webhook retry jitterFactor to [0, 1]', () => {
      const negativeJitter = loadConfig({ WEBHOOK_RETRY_JITTER_FACTOR: '-0.5' });
      expect(negativeJitter.webhookRetry.jitterFactor).toBe(0);

      const excessiveJitter = loadConfig({ WEBHOOK_RETRY_JITTER_FACTOR: '2.5' });
      expect(excessiveJitter.webhookRetry.jitterFactor).toBe(1);
    });
  });

  describe('Data Integrity, Normalization & Integer Bounds', () => {
    it('truncates floating point values to integers for port', () => {
      const cfg = loadConfig({ PORT: '4000.8' });
      expect(cfg.port).toBe(4000);
    });

    it('clamps PORT between 1 and 65535', () => {
      const low = loadConfig({ PORT: '0' });
      expect(low.port).toBe(1);

      const high = loadConfig({ PORT: '70000' });
      expect(high.port).toBe(65535);
    });

    it('falls back to default port on whitespace-only input', () => {
      const cfg = loadConfig({ PORT: '   ' });
      expect(cfg.port).toBe(3001);
    });

    it('falls back to default port on non-numeric input', () => {
      const cfg = loadConfig({ PORT: 'invalid_port' });
      expect(cfg.port).toBe(3001);
    });

    it('clamps UPSTREAM_TIMEOUT_MS to [100, 10000]', () => {
      const low = loadConfig({ UPSTREAM_TIMEOUT_MS: '50' });
      expect(low.upstreamTimeoutMs).toBe(100);

      const high = loadConfig({ UPSTREAM_TIMEOUT_MS: '25000' });
      expect(high.upstreamTimeoutMs).toBe(10000);
    });

    it('clamps CHAOS_PROBABILITY to [0, 1]', () => {
      const low = loadConfig({ CHAOS_PROBABILITY: '-0.2' });
      expect(low.chaosProbability).toBe(0);

      const high = loadConfig({ CHAOS_PROBABILITY: '1.5' });
      expect(high.chaosProbability).toBe(1);

      const nan = loadConfig({ CHAOS_PROBABILITY: 'not_a_number' });
      expect(nan.chaosProbability).toBe(0);
    });

    it('normalizes chaosMode and defaults invalid modes to off', () => {
      expect(loadConfig({ CHAOS_MODE: 'ERROR' }).chaosMode).toBe('error');
      expect(loadConfig({ CHAOS_MODE: 'timeout' }).chaosMode).toBe('timeout');
      expect(loadConfig({ CHAOS_MODE: 'random' }).chaosMode).toBe('random');
      expect(loadConfig({ CHAOS_MODE: 'destructive' }).chaosMode).toBe('off');
      expect(loadConfig({ CHAOS_MODE: '' }).chaosMode).toBe('off');
    });

    it('clamps IDEMPOTENCY_TTL_MS to [0, 7 days]', () => {
      const low = loadConfig({ IDEMPOTENCY_TTL_MS: '-100' });
      expect(low.idempotencyTtlMs).toBe(0);

      const maxAllowed = 7 * 24 * 60 * 60 * 1000;
      const high = loadConfig({ IDEMPOTENCY_TTL_MS: String(maxAllowed + 10000) });
      expect(high.idempotencyTtlMs).toBe(maxAllowed);
    });
  });

  describe('Deduplication & List Normalization', () => {
    it('deduplicates allowedAssets preserving first occurrence order', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: 'USDC, XLM, usdc, btc, XLM, ETH' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM', 'BTC', 'ETH']);
    });

    it('falls back to default assets when ALLOWED_ASSETS is empty commas', () => {
      const cfg = loadConfig({ ALLOWED_ASSETS: ' , , ' });
      expect(cfg.allowedAssets).toEqual(['USDC', 'XLM', 'BTC', 'ETH']);
    });

    it('deduplicates chaosTargets preserving order', () => {
      const cfg = loadConfig({ CHAOS_TARGETS: 'contracts, reputation, CONTRACTS, stellar' });
      expect(cfg.chaosTargets).toEqual(['contracts', 'reputation', 'stellar']);
    });

    it('parseAssets helper returns copy of defaults on empty input', () => {
      const assets = parseAssets(undefined);
      expect(assets).toEqual(['USDC', 'XLM', 'BTC', 'ETH']);
    });
  });

  describe('SSRF and URL Protocol Invariants', () => {
    it('allows valid HTTPS public upstream contracts URL', () => {
      const cfg = loadConfig({ UPSTREAM_CONTRACTS_URL: 'https://api.github.com/contracts' });
      expect(cfg.upstreamContractsUrl).toBe('https://api.github.com/contracts');
    });

    it('rejects forbidden protocols such as ftp, file, javascript', () => {
      expect(() => {
        loadConfig({ UPSTREAM_CONTRACTS_URL: 'ftp://example.com/contracts' });
      }).toThrow(/Forbidden protocol/);

      expect(() => {
        loadConfig({ UPSTREAM_CONTRACTS_URL: 'file:///etc/contracts' });
      }).toThrow(/Forbidden protocol/);
    });

    it('rejects malformed URLs', () => {
      expect(() => {
        loadConfig({ UPSTREAM_CONTRACTS_URL: '://invalid-url' });
      }).toThrow(/Malformed URL/);
    });

    it('blocks access to private hosts and localhost under default SSRF protection', () => {
      expect(() => {
        loadConfig({ UPSTREAM_CONTRACTS_URL: 'http://localhost:3001/contracts' });
      }).toThrow(/SSRF protection blocked access/);

      expect(() => {
        loadConfig({ UPSTREAM_CONTRACTS_URL: 'http://169.254.169.254/latest/meta-data' });
      }).toThrow(/SSRF protection blocked access/);
    });

    it('sanitizes embedded credentials from URL error messages to avoid sensitive data leakage', () => {
      expect(() => {
        loadConfig({ UPSTREAM_CONTRACTS_URL: 'http://admin:supersecret@127.0.0.1/contracts' });
      }).toThrowError(/SSRF protection blocked access to internal resource "http:\/\/\*\*\*:\*\*\*@127\.0\.0\.1\/contracts"/);
    });
  });

  describe('ConfigurationStateManager (Lifecycle & Concurrency Safety)', () => {
    it('begins in UNINITIALIZED state and transitions to ACTIVE on initialize', () => {
      const manager = new ConfigurationStateManager();
      expect(manager.getState()).toBe('UNINITIALIZED');
      expect(manager.getVersion()).toBe(0);

      const config = manager.initialize({});
      expect(manager.getState()).toBe('ACTIVE');
      expect(manager.getVersion()).toBe(1);
      expect(config.port).toBe(3001);
    });

    it('initialize is idempotent when state is already ACTIVE', () => {
      const manager = new ConfigurationStateManager();
      const first = manager.initialize({ PORT: '3005' });
      const second = manager.initialize({ PORT: '9999' });

      expect(first.port).toBe(3005);
      expect(second.port).toBe(3005);
      expect(manager.getVersion()).toBe(1);
    });

    it('getConfig lazily initializes if called in UNINITIALIZED state', () => {
      const manager = new ConfigurationStateManager();
      expect(manager.getState()).toBe('UNINITIALIZED');

      const config = manager.getConfig();
      expect(manager.getState()).toBe('ACTIVE');
      expect(config.port).toBe(3001);
    });

    it('reconfigure updates configuration atomically and increments version', () => {
      const manager = new ConfigurationStateManager();
      manager.initialize({ PORT: '3001' });

      const updated = manager.reconfigure({ PORT: '4000' });
      expect(updated.port).toBe(4000);
      expect(manager.getVersion()).toBe(2);
      expect(manager.getConfig().port).toBe(4000);
    });

    it('enforces authorization token when configured for reconfigure', () => {
      const manager = new ConfigurationStateManager('secret-auth-token-123');
      manager.initialize({});

      // Forbidden: missing auth secret
      expect(() => {
        manager.reconfigure({ PORT: '5000' });
      }).toThrow(ConfigurationAuthError);

      // Forbidden: incorrect auth secret
      expect(() => {
        manager.reconfigure({ PORT: '5000' }, 'wrong-token');
      }).toThrow(ConfigurationAuthError);

      // Allowed: valid auth secret
      const updated = manager.reconfigure({ PORT: '5000' }, 'secret-auth-token-123');
      expect(updated.port).toBe(5000);
    });

    it('maintains previous valid state when reconfigure fails validation (partial failure / atomic rollback)', () => {
      const manager = new ConfigurationStateManager();
      manager.initialize({ PORT: '3001' });
      const versionBefore = manager.getVersion();

      expect(() => {
        // Invalid upstream URL that fails SSRF validation
        manager.reconfigure({ UPSTREAM_CONTRACTS_URL: 'http://127.0.0.1:3001/contracts' });
      }).toThrow(/SSRF protection/);

      // Invariant preserved: State remains ACTIVE with previous valid config and version
      expect(manager.getState()).toBe('ACTIVE');
      expect(manager.getVersion()).toBe(versionBefore);
      expect(manager.getConfig().port).toBe(3001);
    });

    it('reset returns state to UNINITIALIZED', () => {
      const manager = new ConfigurationStateManager();
      manager.initialize({});
      expect(manager.getState()).toBe('ACTIVE');

      manager.reset();
      expect(manager.getState()).toBe('UNINITIALIZED');
      expect(manager.getVersion()).toBe(0);
    });
  });
});
