import { CircuitBreakerRegistry, circuitBreakerRegistry } from './registry';
import { CircuitBreaker } from './CircuitBreaker';

// Use a fresh registry for each test to avoid cross-test pollution
let registry: CircuitBreakerRegistry;

beforeEach(() => {
  registry = new CircuitBreakerRegistry();
});

describe('CircuitBreakerRegistry', () => {
  it('creates a new breaker on first access', () => {
    const breaker = registry.getOrCreate('test-dep');
    expect(breaker).toBeInstanceOf(CircuitBreaker);
  });

  it('returns the same instance on subsequent calls', () => {
    const a = registry.getOrCreate('test-dep');
    const b = registry.getOrCreate('test-dep');
    expect(a).toBe(b);
  });

  it('getAll returns an entry for each registered breaker', () => {
    registry.getOrCreate('dep-a', { failureThreshold: 3 });
    registry.getOrCreate('dep-b', { failureThreshold: 7 });
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    expect(all.map((b) => b.name)).toEqual(expect.arrayContaining(['dep-a', 'dep-b']));
  });

  it('getAll includes config and stats', () => {
    registry.getOrCreate('dep-a', { failureThreshold: 3, successThreshold: 2, timeout: 10_000 });
    const [entry] = registry.getAll();
    expect(entry.config).toEqual({ failureThreshold: 3, successThreshold: 2, timeoutMs: 10_000 });
    expect(entry.state).toBe('CLOSED');
    expect(entry.failureCount).toBe(0);
    expect(entry.lastFailureTime).toBeNull();
  });

  it('reset returns false for unknown breaker', () => {
    expect(registry.reset('nonexistent')).toBe(false);
  });

  it('reset returns true and resets the breaker', async () => {
    const breaker = registry.getOrCreate('dep-a', { failureThreshold: 1 });
    await expect(breaker.execute(async () => { throw new Error('fail'); })).rejects.toThrow();
    expect(breaker.getState()).toBe('OPEN');

    expect(registry.reset('dep-a')).toBe(true);
    expect(breaker.getState()).toBe('CLOSED');
  });

  it('clear removes all breakers', () => {
    registry.getOrCreate('dep-a');
    registry.getOrCreate('dep-b');
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });
});

describe('circuitBreakerRegistry singleton', () => {
  afterEach(() => {
    circuitBreakerRegistry.clear();
  });

  it('is exported as a singleton', () => {
    expect(circuitBreakerRegistry).toBeDefined();
  });

  it('persists breakers across calls', () => {
    const a = circuitBreakerRegistry.getOrCreate('singleton-dep');
    const b = circuitBreakerRegistry.getOrCreate('singleton-dep');
    expect(a).toBe(b);
  });
});
