import { AppConfig } from '../appConfiguration';

export type ChaosResult = 'none' | 'error' | 'timeout';

/**
 * Factory function type for random number generation.
 * Allows injection of deterministic RNG for testing and reproducibility.
 */
export type RandomFn = () => number;

/**
 * Decides whether to inject deterministic or probabilistic failures for a dependency call.
 *
 * Decision Matrix:
 * 1. Target match: If `chaosTargets` is empty, all dependencies match. Otherwise, matched case-insensitively. If no match, returns 'none'.
 * 2. Mode dispatch:
 *    - 'error': returns 'error'
 *    - 'timeout': returns 'timeout'
 *    - 'random': evaluates `random() < chaosProbability` ? 'error' : 'none'
 *    - default (e.g. 'off' or unknown): returns 'none'
 *
 * @security Chaos can never be active in production by default; it is gated on `chaosMode`.
 * The default `Math.random` source provides cryptographic-quality randomness in Node.js, but the
 * injected function allows deterministic sequences for chaos testing and incident reproduction.
 */
export class ChaosPolicy {
  constructor(
    private readonly config: Pick<AppConfig, 'chaosMode' | 'chaosTargets' | 'chaosProbability'>,
    private readonly random: RandomFn = Math.random,
  ) {}

  decide(dependencyName: string): ChaosResult {
    const dependency = dependencyName.toLowerCase();

    if (!this.isTargeted(dependency)) {
      return 'none';
    }

    switch (this.config.chaosMode) {
      case 'error':
        return 'error';
      case 'timeout':
        return 'timeout';
      case 'random': {
        const probability = this.config.chaosProbability;
        // Boundary handling: probability 0 never injects, probability 1 always injects.
        if (probability <= 0) {
          return 'none';
        }
        if (probability >= 1) {
          return 'error';
        }
        return this.random() < probability ? 'error' : 'none';
      }
      default:
        return 'none';
    }
  }

  private isTargeted(dependencyName: string): boolean {
    if (this.config.chaosTargets.length === 0) {
      return true;
    }

    return this.config.chaosTargets.includes(dependencyName);
  }
}
