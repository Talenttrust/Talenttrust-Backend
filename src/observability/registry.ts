/**
 * @module observability/registry
 * @description Singleton instances for observability services.
 *
 * Provides global access to the metrics service instance without requiring
 * it to be passed through every module's dependency injection chain.
 *
 * This follows the registry pattern: centralized instances that can be
 * initialized once and accessed globally.
 */

import type { MetricsServiceLike } from './metrics-service';

/**
 * Global singleton for metrics service.
 * Initialized by the app factory and accessed by cache interceptors and other
 * modules that need to emit metrics.
 *
 * @internal Assigned by app.ts during application setup
 */
let _metricsService: MetricsServiceLike | null = null;

/**
 * Sets the global metrics service instance.
 * Called once during app initialization.
 *
 * @param service - The MetricsService instance to use globally
 */
export function setMetricsService(service: MetricsServiceLike): void {
  _metricsService = service;
}

/**
 * Gets the global metrics service instance.
 * Returns a no-op stub if the service hasn't been initialized yet,
 * preventing null-pointer errors in modules that load before initialization.
 *
 * @returns The MetricsServiceLike instance
 */
export function getMetricsService(): MetricsServiceLike {
  if (_metricsService === null) {
    // Return a no-op stub to prevent errors during testing or initialization
    return {
      contentType: 'text/plain',
      trackHttpRequest: () => {},
      getMetrics: async () => '',
      recordHealthStatus: () => {},
      recordWebhookDelivery: () => {},
      setWebhookDlqDepth: () => {},
      recordCacheHit: () => {},
      recordCacheMiss: () => {},
    };
  }
  return _metricsService;
}

/**
 * Convenience export for metrics service as the default import.
 * This allows cache interceptors and other modules to use:
 *   import { metricsService } from './observability/registry'
 */
export const metricsService = new Proxy({} as MetricsServiceLike, {
  get(target, prop) {
    const service = getMetricsService();
    return (service as any)[prop];
  },
});
