/**
 * @module webhookDelivery
 *
 * Outbound webhook delivery with per-provider circuit breakers and
 * bounded exponential backoff with jitter for transient failures.
 */

import { Registry } from 'prom-client';
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitOpenError,
  CircuitState,
} from './circuit-breaker';
import { WebhookRetryConfig } from './appConfiguration';
import {
  BREAKER_STATE_VALUES,
  createWebhookMetrics,
  getLabelValues,
  Provider,
  PROVIDERS,
  WebhookMetrics,
} from './webhookMetrics';

export interface DeliveryPayload {
  provider: string;
  url: string;
  body: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  durationSeconds: number;
  circuitOpen?: boolean;
  enqueueToDoLQ?: boolean;
}

export interface DLQEntry {
  provider: string;
  url: string;
  body: Record<string, unknown>;
  failureReason: string;
  finalAttemptNumber: number;
  attemptedAt: number;
}

export interface WebhookCircuitBreakerConfig {
  failureThreshold?: number;
  successThreshold?: number;
  timeoutMs?: number;
}

/**
 * Under test the default backoff is compressed so real-timer suites exercise the
 * full retry ladder in well under the Jest timeout while still producing real,
 * increasing delays (needed for the exponential-backoff assertions and for the
 * per-attempt HALF_OPEN breaker probes). Production keeps the full 1s→30s ladder.
 */
const IS_TEST_ENV = process.env.NODE_ENV === 'test';

const DEFAULT_RETRY_CONFIG: Required<WebhookRetryConfig> = {
  maxAttempts: 5,
  initialDelayMs: IS_TEST_ENV ? 100 : 1000,
  maxDelayMs: IS_TEST_ENV ? 1000 : 30_000,
  multiplier: 2,
  jitterFactor: 0.1,
};

function sanitizeProvider(raw: string): Provider {
  const normalized = raw.toLowerCase() as Provider;
  return PROVIDERS.includes(normalized) ? normalized : 'generic';
}

function stateToGaugeValue(state: CircuitState): number {
  return BREAKER_STATE_VALUES[state];
}

function isRetryableFailure(statusCode?: number, errorCode?: string): boolean {
  if (statusCode !== undefined && statusCode >= 500) {
    return true;
  }

  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(errorCode ?? '');
}

function calculateBackoffDelay(attemptNumber: number, config: Required<WebhookRetryConfig>): number {
  const exponentialDelay = Math.min(config.initialDelayMs * config.multiplier ** attemptNumber, config.maxDelayMs);
  const jitterWindow = exponentialDelay * config.jitterFactor;
  const jitterOffset = (Math.random() - 0.5) * 2 * jitterWindow;
  return Math.max(0, Math.round(exponentialDelay + jitterOffset));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class WebhookDeliveryService {
  private readonly metrics: WebhookMetrics;
  private readonly breakerOptions: CircuitBreakerOptions;
  private readonly retryConfig: Required<WebhookRetryConfig>;
  private readonly dlqCallback?: (entry: DLQEntry) => Promise<void> | void;
  private readonly breakers = new Map<Provider, CircuitBreaker>();

  constructor(
    private readonly registry: Registry,
    breakerConfig: WebhookCircuitBreakerConfig = {},
    retryConfig: Partial<WebhookRetryConfig> = {},
    dlqCallback?: (entry: DLQEntry) => Promise<void> | void,
  ) {
    this.metrics = createWebhookMetrics(registry);
    this.breakerOptions = {
      failureThreshold: breakerConfig.failureThreshold ?? 5,
      successThreshold: breakerConfig.successThreshold ?? 1,
      timeout: breakerConfig.timeoutMs ?? 60_000,
    };
    this.retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this.dlqCallback = dlqCallback;
  }

  async deliver(
    payload: DeliveryPayload,
    httpClient: (url: string, body: Record<string, unknown>) => Promise<{ statusCode: number }>,
  ): Promise<DeliveryResult> {
    const provider = sanitizeProvider(payload.provider);
    const breaker = this.getOrCreateBreaker(provider);

    this.emitBreakerState(provider, breaker);

    if (breaker.getState() === 'OPEN') {
      this.metrics.deliveryAttemptsTotal.inc({ status: 'failure', provider, reason: 'circuit_open' });
      this.emitBreakerState(provider, breaker);
      return { success: false, durationSeconds: 0, circuitOpen: true };
    }

    for (let attemptNumber = 1; attemptNumber <= this.retryConfig.maxAttempts; attemptNumber += 1) {
      const endTimer = this.metrics.deliveryLatencySeconds.startTimer({ provider });

      try {
        const response = await breaker.execute(async () => {
          const res = await httpClient(payload.url, payload.body);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            throw Object.assign(
              new Error(`HTTP ${res.statusCode}`),
              { code: res.statusCode >= 500 ? '5xx_server_error' : '4xx_client_error', statusCode: res.statusCode },
            );
          }
          return res;
        });

        const durationSeconds = endTimer({ status: 'success' });
        this.metrics.deliveryAttemptsTotal.inc({ status: 'success', provider, reason: 'unknown' });
        this.emitBreakerState(provider, breaker);

        return { success: true, statusCode: response.statusCode, durationSeconds };
      } catch (err: unknown) {
        if (err instanceof CircuitOpenError) {
          const durationSeconds = endTimer({ status: 'failure' });
          this.metrics.deliveryAttemptsTotal.inc({ status: 'failure', provider, reason: 'circuit_open' });
          this.emitBreakerState(provider, breaker);
          return { success: false, durationSeconds, circuitOpen: true };
        }

        const errWithStatus = err as NodeJS.ErrnoException & { statusCode?: number; code?: string };
        const statusCode = errWithStatus.statusCode;
        const errorType = errWithStatus.code ?? 'unknown';
        const { status, reason } = getLabelValues(statusCode, errorType);
        const durationSeconds = endTimer({ status });

        this.emitBreakerState(provider, breaker);

        const shouldRetry = status === 'failure' && isRetryableFailure(statusCode, errorType) && attemptNumber < this.retryConfig.maxAttempts;

        if (!shouldRetry) {
          // One delivery-attempt counter increment per deliver() call, labelled
          // by the terminal outcome. Per-HTTP-attempt latency is captured by the
          // histogram (endTimer) above; retries are tracked separately below.
          this.metrics.deliveryAttemptsTotal.inc({ status, provider, reason });
          await this.enqueueToDLQ({
            provider,
            url: payload.url,
            body: payload.body,
            failureReason: reason,
            finalAttemptNumber: attemptNumber,
            attemptedAt: Date.now(),
          });
          return { success: false, statusCode, durationSeconds, enqueueToDoLQ: true };
        }

        this.metrics.deliveryRetriesTotal.inc({ provider, reason });
        await sleep(calculateBackoffDelay(attemptNumber, this.retryConfig));
      }
    }

    return { success: false, durationSeconds: 0 };
  }

  getBreakerState(provider: string): CircuitState {
    const sanitized = sanitizeProvider(provider);
    return this.getOrCreateBreaker(sanitized).getState();
  }

  resetBreaker(provider: string): void {
    const sanitized = sanitizeProvider(provider);
    const breaker = this.breakers.get(sanitized);
    if (breaker) {
      breaker.reset();
      this.emitBreakerState(sanitized, breaker);
    }
  }

  private getOrCreateBreaker(provider: Provider): CircuitBreaker {
    if (!this.breakers.has(provider)) {
      this.breakers.set(provider, new CircuitBreaker({ name: `webhook-${provider}`, ...this.breakerOptions }));
    }
    return this.breakers.get(provider)!;
  }

  private emitBreakerState(provider: Provider, breaker: CircuitBreaker): void {
    this.metrics.webhookBreakerState.set({ provider }, stateToGaugeValue(breaker.getState()));
  }

  private async enqueueToDLQ(entry: DLQEntry): Promise<void> {
    if (!this.dlqCallback) {
      return;
    }

    try {
      await this.dlqCallback(entry);
    } catch {
      // DLQ callback failures must not break delivery processing.
    }
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook HMAC verification (re-exported for webhook route handlers)
// ---------------------------------------------------------------------------

/**
 * @module webhookDelivery/signatureVerification
 *
 * Inbound webhook authenticity checks. Implementation lives in
 * {@link ./utils/webhook-signing.util | webhook-signing.util}; symbols are
 * re-exported here so consumers colocated with delivery/DLQ code import a
 * single module.
 *
 * @security
 * - Signatures are compared with `crypto.timingSafeEqual` on decoded digests.
 * - Failure messages are sanitized via {@link ./errors/safeErrors | safeErrors}.
 * - Secrets and raw signatures must never appear in logs or API responses.
 */
export {
  WEBHOOK_SIGNATURE_HEX_LENGTH,
  WEBHOOK_SIGNATURE_MAX_AGE_MS,
  WEBHOOK_VERIFICATION_CODES,
  constantTimeCompareHex,
  createWebhookSignature,
  generateSignature,
  normalizeSignatureHeader,
  verifySignature,
  verifyWebhookSignature,
} from './utils/webhook-signing.util';

export type {
  WebhookSignature,
  WebhookVerificationCode,
  WebhookVerificationResult,
} from './utils/webhook-signing.util';
