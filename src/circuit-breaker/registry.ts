/**
 * registry.ts — Singleton registry for named CircuitBreaker instances.
 *
 * Centralises breaker creation so any module can retrieve the same instance
 * by name, and the admin status endpoint can enumerate all breakers.
 */

import { CircuitBreaker, CircuitBreakerOptions, CircuitStats } from './CircuitBreaker';
import { AppError } from '../errors/appError';
import { auditService } from '../audit/service';

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

  /**
   * Resets a breaker by name and records an audit log entry.
   *
   * @param name - Breaker name to reset.
   * @param performedBy - Identifier of the admin performing the reset (e.g., userId).
   * @throws {@link AppError} with status 400 if breaker does not exist.
   */
  resetBreaker(name: string, performedBy: string): void {
    if (!this.reset(name)) {
      throw new AppError(400, 'bad_request', `Circuit breaker "${name}" not found`);
    }
    auditService.log({
      action: 'ADMIN_ACTION',
      severity: 'INFO',
      actor: performedBy,
      resource: 'circuit_breaker',
      resourceId: name,
      metadata: {},
    });
  }

  /** Exposed for testing — clears all registered breakers. */
  clear(): void {
    this.breakers.clear();
    this.configs.clear();
  }
}

export const circuitBreakerRegistry = new CircuitBreakerRegistry();
