/**
 * index.ts — Barrel export for the circuit-breaker module.
 *
 * Import from here to keep import paths stable as the module grows:
 *   import { CircuitBreaker, CircuitOpenError } from '../circuit-breaker';
 */

export { CircuitBreaker } from "./CircuitBreaker";
export type {
  CircuitBreakerOptions,
  CircuitState,
  CircuitStats,
} from "./CircuitBreaker";
export { CircuitOpenError } from "./errors";
