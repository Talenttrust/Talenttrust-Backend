import { Registry } from 'prom-client';
import {
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
}

/** Sanitizes provider to a known finite value, preventing label cardinality explosion. */
function sanitizeProvider(raw: string): Provider {
  const normalized = raw.toLowerCase() as Provider;
  return PROVIDERS.includes(normalized) ? normalized : 'generic';
}

export class WebhookDeliveryService {
  private readonly metrics: WebhookMetrics;

  constructor(private readonly registry: Registry) {
    this.metrics = createWebhookMetrics(registry);
  }

  /**
   * Delivers a webhook payload to the target URL.
   * Wraps the HTTP call with latency tracking and structured failure recording.
   */
  async deliver(
    payload: DeliveryPayload,
    httpClient: (url: string, body: Record<string, unknown>) => Promise<{ statusCode: number }>,
  ): Promise<DeliveryResult> {
    const provider = sanitizeProvider(payload.provider);
    const endTimer = this.metrics.deliveryLatencySeconds.startTimer({ provider });

    let statusCode: number | undefined;
    let errorType: string | undefined;

    try {
      const response = await httpClient(payload.url, payload.body);
      statusCode = response.statusCode;
    } catch (err: unknown) {
      // Extract only the error code — never log raw error messages that may contain PII
      errorType = (err as NodeJS.ErrnoException).code ?? 'unknown';
    }

    const { status, reason } = getLabelValues(statusCode, errorType);
    const durationSeconds = endTimer({ status });

    this.metrics.deliveryAttemptsTotal.inc({ status, provider, reason });

    return {
      success: status === 'success',
      statusCode,
      durationSeconds,
    };
  }
}
