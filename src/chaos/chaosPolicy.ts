import { AppConfig } from '../config';

export type ChaosResult = 'none' | 'error' | 'timeout';

/**
 * Decides whether to inject deterministic or probabilistic failures for a dependency call.
 */
export class ChaosPolicy {
  constructor(private readonly config: Pick<AppConfig, 'chaosMode' | 'chaosTargets' | 'chaosProbability'>) {}

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
      case 'random':
        return Math.random() < this.config.chaosProbability ? 'error' : 'none';
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
