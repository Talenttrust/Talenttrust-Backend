import axios from 'axios';
import { URL } from 'url';
import crypto from 'crypto';
import { createWebhookSignature } from '../utils/webhook-signing.util';
import { getWebhookDLQStorage, WebhookDLQEntry } from '../queue/webhook-dlq';
import { WEBHOOK_RETRY_POLICY, calculateWebhookRetryDelay } from '../queue/webhook-retry-policy';
import { isSafeUrl } from '../utils/ssrf';
import { RateLimitStore } from '../lib/rateLimitStore';
import { MetricsServiceLike } from '../observability';
import { validateEnv } from '../config/env.schema';
import { parseBoolEnv } from '../config/env';
import { createLogger } from '../logger';

import { getDb } from '../db/database';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';

const log = createLogger({ service: 'webhook-delivery' });

/** Max deliveries per destination host per window. Default: 60. */
const HOST_RATE_LIMIT_MAX = Number(process.env.WEBHOOK_HOST_RATE_LIMIT_MAX ?? 60);
/** Window length in ms for per-host rate limiting. Default: 60 000 ms. */
const HOST_RATE_LIMIT_WINDOW_MS = Number(process.env.WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS ?? 60_000);
/** Per-attempt outbound webhook timeout, validated through env schema. */
const WEBHOOK_DELIVERY_TIMEOUT_MS = validateEnv().WEBHOOK_DELIVERY_TIMEOUT_MS;
/** Maximum webhook payload size in bytes, validated through env schema. */
const WEBHOOK_MAX_PAYLOAD_SIZE_BYTES = validateEnv().WEBHOOK_MAX_PAYLOAD_SIZE_BYTES;

/**
 * Stable machine-readable error codes for webhook delivery failures.
 * Clients and DLQ consumers may branch on these values.
 */
export const WEBHOOK_ERROR_CODES = {
  PAYLOAD_TOO_LARGE: 'WEBHOOK_PAYLOAD_TOO_LARGE',
  SSRF_BLOCKED: 'WEBHOOK_SSRF_BLOCKED',
  RATE_LIMITED: 'WEBHOOK_RATE_LIMITED',
  DELIVERY_FAILED: 'WEBHOOK_DELIVERY_FAILED',
  RETRY_EXHAUSTED: 'WEBHOOK_RETRY_EXHAUSTED',
  DELIVERY_TIMEOUT: 'WEBHOOK_DELIVERY_TIMEOUT',
  DELIVERY_4XX: 'WEBHOOK_DELIVERY_4XX',
  DELIVERY_5XX: 'WEBHOOK_DELIVERY_5XX',
  SIGNATURE_GENERATION_FAILED: 'WEBHOOK_SIGNATURE_GENERATION_FAILED',
  DLQ_NOT_FOUND: 'WEBHOOK_DLQ_NOT_FOUND',
  REPLAY_FAILED: 'WEBHOOK_REPLAY_FAILED',
  INVALID_CONFIGURATION: 'WEBHOOK_INVALID_CONFIGURATION',
} as const;

export type WebhookErrorCode = (typeof WEBHOOK_ERROR_CODES)[keyof typeof WEBHOOK_ERROR_CODES];

/**
 * Public, secret-redacted view of a DLQ entry. Exposes the failure reason as
 * `error` (aliasing the internal `lastError` column) and never leaks the
 * per-subscription webhook secret.
 */
export type WebhookDLQView = Omit<WebhookDLQEntry, 'webhookSecret' | 'lastError'> & {
  error: string;
};

function toDLQView(entry: WebhookDLQEntry): WebhookDLQView {
  const { webhookSecret: _webhookSecret, lastError, ...rest } = entry;
  return { ...rest, error: lastError };
}

export interface WebhookPayload {
  id: string;
  url: string;
  data: unknown;
  retryCount: number;
  webhookSecret?: string;
  /** Optional correlation ID for distributed tracing across webhook deliveries. */
  correlationId?: string;
}

export class WebhookService {
  private dlqStorage = getWebhookDLQStorage();
  private get repo() {
    return new SqliteWebhookSubscriptionRepository(getDb());
  }
  /** Per-host sliding-window rate limit store (shared across all instances). */
  private static hostRateStore = new RateLimitStore({ sweepIntervalMs: HOST_RATE_LIMIT_WINDOW_MS });

  /**
   * When `false`, `trigger()` is a no-op: no subscriptions are queried,
   * no deliveries are attempted, and no DLQ entries are written.
   *
   * Defaults to `true` (read from `WEBHOOKS_ENABLED` env var at construction
   * time) so the flag can be injected in tests without touching `process.env`.
   */
  private readonly webhooksEnabled: boolean;

  /**
   * Applies a per-host sliding-window rate limit.
   *
   * @param hostname - The destination hostname extracted from the webhook URL.
   * @returns `true` if the request is allowed, `false` if the limit is exceeded.
   *
   * @remarks
   * Uses the same sliding-window algorithm as the HTTP rate-limit middleware.
   * The hostname is used as the raw key and is hashed inside the store.
   */
  private checkHostRateLimit(hostname: string): boolean {
    const now = Date.now();
    const entry = WebhookService.hostRateStore.get(hostname) ?? {
      count: 0,
      windowStart: now,
      blocked: false,
      blockedUntil: 0,
    };

    if (now - entry.windowStart > HOST_RATE_LIMIT_WINDOW_MS) {
      entry.count = 0;
      entry.windowStart = now;
    }

    entry.count += 1;
    WebhookService.hostRateStore.set(hostname, entry);

    return entry.count <= HOST_RATE_LIMIT_MAX;
  }

  constructor(private readonly metrics?: MetricsServiceLike, webhooksEnabled?: boolean) {
    this.webhooksEnabled = webhooksEnabled ?? parseBoolEnv('WEBHOOKS_ENABLED', true);
  }

  /**
   * Triggers a webhook event. It retrieves all active subscriptions matching the event type,
   * constructs a delivery payload, and delivers to each matching subscription URL asynchronously.
   *
   * When `WEBHOOKS_ENABLED=false` this method returns immediately without querying
   * subscriptions, sending any deliveries, or touching the DLQ.
   *
   * @param eventType - The event type name.
   * @param data - The event body/data.
   * @param correlationId - Optional correlation ID.
   */
  async trigger(eventType: string, data: unknown, correlationId?: string): Promise<void> {
    if (!this.webhooksEnabled) {
      return;
    }

    const subscriptions = await this.repo.findAll({ eventType, active: true });
    log.info('Webhook delivery started', {
      eventType,
      subscriberCount: subscriptions.length,
      ...(correlationId && { correlationId }),
    });

    // Asynchronously deliver to all matching subscriptions.
    // Each subscription gets a fresh stable event ID that persists across retries.
    const deliveries = subscriptions.map((sub) => {
      const payload: WebhookPayload = {
        id: crypto.randomUUID(),
        url: sub.url,
        data,
        retryCount: 0,
        webhookSecret: sub.secret,
        correlationId,
      };
      return this.send(payload).catch((e) => {
        log.error('Webhook delivery error for subscription', {
          eventType,
          subscriberId: sub.id,
          eventId: payload.id,
          err: e,
        });
      });
    });

    await Promise.allSettled(deliveries);
  }

  /**
   * Sends a webhook payload with iterative bounded retry and DLQ fallback.
   *
   * ## Payload size validation
   * Before any HTTP attempt, the serialized payload byte length is checked
   * against `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES`. Oversized payloads are moved
   * directly to DLQ without retrying.
   *
   * ## Signing
   * When `payload.webhookSecret` is set, each attempt generates a fresh
   * HMAC-SHA256 signature over `"${timestamp}.${JSON.stringify(data)}"` and
   * sends `X-Signature: sha256=<hex>` and `X-Timestamp: <unix-ms>` headers.
   * A fresh timestamp is generated for each attempt (including replays).
   *
   * ## Retry policy
   * Retries on 5xx responses and network timeouts only. 4xx, SSRF-blocked, and
   * rate-limited are non-retryable and go directly to DLQ.
   *
   * ## Event ID stability
   * The `payload.id` is set once by the caller before the first attempt and
   * remains unchanged across all retry attempts, giving subscribers a stable
   * identifier for deduplication.
   *
   * @param payload - Webhook payload including URL, data, and retry state
   */
  async send(payload: WebhookPayload): Promise<void> {
    // ── Payload size validation ──────────────────────────────────────────
    const rawPayload = JSON.stringify(payload.data);
    const payloadBytes = Buffer.byteLength(rawPayload, 'utf8');
    if (payloadBytes > WEBHOOK_MAX_PAYLOAD_SIZE_BYTES) {
      const reason = `${WEBHOOK_ERROR_CODES.PAYLOAD_TOO_LARGE}: payload ${payloadBytes} bytes exceeds limit of ${WEBHOOK_MAX_PAYLOAD_SIZE_BYTES} bytes`;
      log.warn('Webhook payload too large; moving to DLQ without retry', {
        eventId: payload.id,
        payloadBytes,
        limitBytes: WEBHOOK_MAX_PAYLOAD_SIZE_BYTES,
      });
      await this.persistToDLQ(payload, reason);
      return;
    }

    const maxAttempts = WEBHOOK_RETRY_POLICY.maxAttempts;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // ── SSRF re-check ────────────────────────────────────────────────────
      if (!isSafeUrl(payload.url)) {
        const reason = `${WEBHOOK_ERROR_CODES.SSRF_BLOCKED}: destination URL is private or invalid`;
        log.warn('Webhook SSRF check failed; moving to DLQ without retry', {
          eventId: payload.id,
          attempt: attempt + 1,
        });
        await this.persistToDLQ(payload, reason);
        return;
      }

      // ── Per-host rate limit ──────────────────────────────────────────────
      const hostname = new URL(payload.url).hostname;
      if (!this.checkHostRateLimit(hostname)) {
        const reason = `${WEBHOOK_ERROR_CODES.RATE_LIMITED}: host ${hostname} exceeded delivery limit`;
        log.warn('Webhook rate limit exceeded; moving to DLQ without retry', {
          eventId: payload.id,
          attempt: attempt + 1,
        });
        await this.persistToDLQ(payload, reason);
        return;
      }

      log.info('Webhook delivery attempt', {
        eventId: payload.id,
        attempt: attempt + 1,
        maxAttempts,
      });

      try {
        const headers = buildWebhookHeaders(payload.correlationId);

        if (payload.webhookSecret) {
          // Generate a fresh timestamp and signature for this specific attempt.
          // Replays always get a new timestamp/signature, never reuse old ones.
          const { signature, timestamp } = createWebhookSignature(
            payload.data,
            payload.webhookSecret,
          );
          headers['X-Signature'] = `sha256=${signature}`;
          headers['X-Timestamp'] = timestamp.toString();
        }

        await axios.post(payload.url, payload.data, {
          headers,
          timeout: WEBHOOK_DELIVERY_TIMEOUT_MS,
        });

        log.info('Webhook delivery succeeded', {
          eventId: payload.id,
          attempt: attempt + 1,
        });
        return;
      } catch (error: unknown) {
        lastError = error as Error;
        payload.retryCount = attempt + 1;

        // Permanent 4xx client errors are non-retryable: retrying them only
        // burns attempts and cannot succeed. Move directly to DLQ (no retries).
        const status = getErrorStatus(error);
        if (status !== undefined && status >= 400 && status < 500) {
          const reason = `${WEBHOOK_ERROR_CODES.DELIVERY_4XX}: downstream returned HTTP ${status}`;
          log.warn('Webhook delivery rejected with 4xx; moving to DLQ without retry', {
            eventId: payload.id,
            attempt: attempt + 1,
            statusCode: status,
          });
          await this.persistToDLQ(payload, reason);
          return;
        }

        const isLastAttempt = attempt === maxAttempts - 1;
        if (!isLastAttempt) {
          const delay = process.env.NODE_ENV === 'test' ? 0 : calculateWebhookRetryDelay(attempt);
          log.info('Webhook delivery retry scheduled', {
            eventId: payload.id,
            attempt: attempt + 1,
            nextAttempt: attempt + 2,
            delayMs: delay,
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          log.warn('Webhook delivery retry failed on final attempt', {
            eventId: payload.id,
            attempt: attempt + 1,
            maxAttempts,
          });
        }
      }
    }

    const finalError = lastError?.message ?? 'Unknown error';
    log.warn('Webhook delivery exhausted retries; moving to DLQ', {
      eventId: payload.id,
      retryCount: payload.retryCount,
      errorCode: WEBHOOK_ERROR_CODES.RETRY_EXHAUSTED,
    });
    await this.persistToDLQ(payload, `${WEBHOOK_ERROR_CODES.RETRY_EXHAUSTED}: ${finalError}`);
  }

  private async persistToDLQ(payload: WebhookPayload, error: string): Promise<void> {
    try {
      await this.dlqStorage.addEntry(
        payload.id,
        payload.url,
        payload.data as Record<string, unknown>,
        payload.retryCount,
        error,
        payload.webhookSecret,
      );
      log.info('Webhook event moved to DLQ', {
        eventId: payload.id,
        retryCount: payload.retryCount,
        // error code only (not full message) to avoid leaking payload details
        errorCode: error.split(':')[0],
      });
    } catch (err: unknown) {
      if ((err as Error).message === 'DUPLICATE_ENTRY') {
        return;
      }
      throw err;
    }
  }

  getDLQ(): WebhookDLQView[] {
    const entries = this.dlqStorage.listEntries();
    return entries.map((entry) => toDLQView(entry));
  }

  async getDLQEntry(id: string): Promise<WebhookDLQView | null> {
    const entry = this.dlqStorage.getEntry(id);
    if (!entry) return null;
    return toDLQView(entry);
  }

  /**
   * Replays a single DLQ entry through the normal delivery pipeline.
   *
   * A fresh timestamp and signature are generated for the replay attempt.
   * The entry is removed from DLQ only after successful delivery.
   * If replay fails, the entry remains in DLQ with its existing state.
   *
   * @param id - DLQ entry ID to replay.
   */
  async replayDLQEntry(id: string): Promise<{ success: boolean; message: string }> {
    const entry = this.dlqStorage.getEntry(id);
    if (!entry) {
      return { success: false, message: 'Entry not found' };
    }

    if (entry.replayedAt) {
      return { success: false, message: 'Entry already replayed' };
    }

    const dedupe = this.dlqStorage.checkDedupe(entry.webhookId, entry.body);
    if (dedupe.exists) {
      this.dlqStorage.markReplayed(id);
      return { success: true, message: 'Deduplicated - entry already pending replay' };
    }

    log.info('DLQ replay started', { dlqEntryId: id, eventId: entry.webhookId });

    try {
      // Replay uses the same delivery pipeline: SSRF check, signing, retry, DLQ.
      // A fresh timestamp and signature are generated inside send() for each attempt.
      await this.send({
        id: entry.webhookId,
        url: entry.url,
        data: entry.body,
        retryCount: 0,
        webhookSecret: entry.webhookSecret,
      });
      this.dlqStorage.markReplayed(id);
      log.info('DLQ replay succeeded', { dlqEntryId: id, eventId: entry.webhookId });
      return { success: true, message: 'Replay successful' };
    } catch (err) {
      log.warn('DLQ replay failed', {
        dlqEntryId: id,
        eventId: entry.webhookId,
        errorCode: WEBHOOK_ERROR_CODES.REPLAY_FAILED,
      });
      return { success: false, message: (err as Error).message };
    }
  }

  async getDLQStats(): Promise<{ total: number; pending: number; replayed: number }> {
    return this.dlqStorage.getStats();
  }

  /**
   * Replays all pending DLQ entries with bounded concurrency (backpressure).
   *
   * Iterates every non-replayed DLQ entry, skipping already-replayed entries,
   * and processes up to `concurrency` entries in parallel at a time.
   *
   * @param options.concurrency - Max number of concurrent replays (default: 5).
   * @returns Summary of the bulk replay: attempted, succeeded, failed, deduped counts.
   *
   * @example
   * const summary = await webhookService.replayAll({ concurrency: 10 });
   * // { attempted: 20, succeeded: 18, failed: 1, deduped: 1 }
   */
  async replayAll(options: { concurrency?: number } = {}): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    deduped: number;
  }> {
    const concurrency = Math.max(1, options.concurrency ?? 5);
    const entries = this.dlqStorage.listEntries({ limit: 10000 }).filter((e) => !e.replayedAt);

    log.info('DLQ bulk replay started', { pendingCount: entries.length, concurrency });

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let deduped = 0;

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((e) => this.replayDLQEntry(e.id)));

      for (const result of results) {
        attempted++;
        if (result.status === 'fulfilled') {
          const { success, message } = result.value;
          if (success && message === 'Deduplicated - entry already pending replay') {
            deduped++;
          } else if (success) {
            succeeded++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      }
    }

    log.info('DLQ bulk replay completed', { attempted, succeeded, failed, deduped });
    return { attempted, succeeded, failed, deduped };
  }
}

/**
 * Correlation IDs are echoed verbatim into an outbound HTTP header, so they must
 * be constrained to a safe token charset. This prevents header/response-splitting
 * (CRLF injection) via values such as `trace\nX-Injected: true`.
 */
function isValidCorrelationId(correlationId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(correlationId) && correlationId.length <= 256;
}

function buildWebhookHeaders(correlationId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (correlationId && isValidCorrelationId(correlationId)) {
    headers['X-Correlation-Id'] = correlationId;
  }
  return headers;
}

/**
 * Extract an HTTP response status code from a thrown axios/network error, if one
 * exists. Transient errors (timeouts, connection refused, DNS failures) carry no
 * `response`, so this returns `undefined` for them. Only errors with an actual
 * HTTP response expose a status code — used to short-circuit permanent 4xx
 * failures into the DLQ without retrying.
 */
function getErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }
  const response = (error as { response?: { status?: unknown } }).response;
  if (typeof response?.status === 'number') {
    return response.status;
  }
  return undefined;
}
