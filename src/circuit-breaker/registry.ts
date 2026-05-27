/**
 * registry.ts — Singleton registry for named CircuitBreaker instances.
 *
 * Centralises breaker creation so any module can retrieve the same instance
 * by name, and the admin status endpoint can enumerate all breakers.
 */

import { CircuitBreaker, CircuitBreakerOptions, CircuitStats } from './CircuitBreaker';

export interface BreakerStatus extends CircuitStats {
  name: string;
  config: {
    failureThreshold: number;
    successThreshold: number;
    timeoutMs: number;
  };
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly configs = new Map<string, Required<Pick<CircuitBreakerOptions, 'failureThreshold' | 'successThreshold' | 'timeout'>>>();

  /**
   * Returns an existing breaker by name, or creates one with the given options.
   */
  getOrCreate(name: string, options: CircuitBreakerOptions = {}): CircuitBreaker {
    if (!this.breakers.has(name)) {
      const opts: CircuitBreakerOptions = { name, ...options };
      this.breakers.set(name, new CircuitBreaker(opts));
      this.configs.set(name, {
        failureThreshold: opts.failureThreshold ?? 5,
        successThreshold: opts.successThreshold ?? 1,
        timeout: opts.timeout ?? 30_000,
      });
    }
    return this.breakers.get(name)!;
  }

  /**
   * Returns a status snapshot for every registered breaker.
   */
  getAll(): BreakerStatus[] {
    return Array.from(this.breakers.entries()).map(([name, breaker]) => {
      const cfg = this.configs.get(name)!;
      return {
        name,
        ...breaker.getStats(),
        config: {
          failureThreshold: cfg.failureThreshold,
          successThreshold: cfg.successThreshold,
          timeoutMs: cfg.timeout,
        },
      };
    });
  }

  /** Resets a single breaker by name. Returns false if not found. */
  reset(name: string): boolean {
    const breaker = this.breakers.get(name);
    if (!breaker) return false;
    breaker.reset();
    return true;
  }

  /** Exposed for testing — clears all registered breakers. */
  clear(): void {
    this.breakers.clear();
    this.configs.clear();
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();
