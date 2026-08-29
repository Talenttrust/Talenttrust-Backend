/**
 * Tests for reputation client configuration loading and validation.
 */

import { loadReputationClientConfig, DEFAULT_REPUTATION_CLIENT_CONFIG } from './reputationConfig';

describe('loadReputationClientConfig', () => {
  it('returns defaults when no env vars are set', () => {
    const cfg = loadReputationClientConfig({});
    expect(cfg.baseUrl).toBe(DEFAULT_REPUTATION_CLIENT_CONFIG.baseUrl);
    expect(cfg.timeoutMs).toBe(DEFAULT_REPUTATION_CLIENT_CONFIG.timeoutMs);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.baseDelayMs).toBe(200);
    expect(cfg.maxDelayMs).toBe(5000);
    expect(cfg.cbFailureThreshold).toBe(5);
    expect(cfg.cbSuccessThreshold).toBe(1);
    expect(cfg.cbTimeoutMs).toBe(30000);
  });

  it('parses string env vars into numbers', () => {
    const cfg = loadReputationClientConfig({
      REPUTATION_CLIENT_MAX_ATTEMPTS: '10',
      REPUTATION_CLIENT_BASE_DELAY_MS: '500',
      REPUTATION_CLIENT_CB_FAILURE_THRESHOLD: '3',
      REPUTATION_CLIENT_CB_TIMEOUT_MS: '60000',
    });
    expect(cfg.maxAttempts).toBe(10);
    expect(cfg.baseDelayMs).toBe(500);
    expect(cfg.cbFailureThreshold).toBe(3);
    expect(cfg.cbTimeoutMs).toBe(60000);
  });

  it('rejects maxAttempts < 1', () => {
    expect(() => loadReputationClientConfig({ REPUTATION_CLIENT_MAX_ATTEMPTS: '0' })).toThrow();
  });

  it('rejects maxAttempts > 20', () => {
    expect(() => loadReputationClientConfig({ REPUTATION_CLIENT_MAX_ATTEMPTS: '21' })).toThrow();
  });

  it('rejects maxDelayMs < baseDelayMs', () => {
    expect(() => loadReputationClientConfig({
      REPUTATION_CLIENT_BASE_DELAY_MS: '10000',
      REPUTATION_CLIENT_MAX_DELAY_MS: '5000',
    })).toThrow(/>=/);
  });

  it('rejects cbTimeoutMs < 1000', () => {
    expect(() => loadReputationClientConfig({ REPUTATION_CLIENT_CB_TIMEOUT_MS: '999' })).toThrow();
  });

  it('rejects non-numeric values', () => {
    expect(() => loadReputationClientConfig({ REPUTATION_CLIENT_MAX_ATTEMPTS: 'abc' })).toThrow();
  });

  it('accepts valid overrides for all fields', () => {
    const cfg = loadReputationClientConfig({
      REPUTATION_CLIENT_MAX_ATTEMPTS: '5',
      REPUTATION_CLIENT_BASE_DELAY_MS: '300',
      REPUTATION_CLIENT_MAX_DELAY_MS: '9999',
      REPUTATION_CLIENT_CB_FAILURE_THRESHOLD: '7',
      REPUTATION_CLIENT_CB_SUCCESS_THRESHOLD: '2',
      REPUTATION_CLIENT_CB_TIMEOUT_MS: '45000',
    });
    expect(cfg.maxAttempts).toBe(5);
    expect(cfg.baseDelayMs).toBe(300);
    expect(cfg.maxDelayMs).toBe(9999);
    expect(cfg.cbFailureThreshold).toBe(7);
    expect(cfg.cbSuccessThreshold).toBe(2);
    expect(cfg.cbTimeoutMs).toBe(45000);
  });

  it('freezes the returned config', () => {
    const cfg = loadReputationClientConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('uses the safe defaults when env is empty', () => {
    const cfg = loadReputationClientConfig({});
    expect(cfg.baseUrl).toBe('https://example.invalid/reputation');
    expect(cfg.cbSuccessThreshold).toBe(1);
  });
});