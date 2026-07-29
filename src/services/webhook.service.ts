
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

import { getDb } from '../db/database';
import { SqliteWebhookSubscriptionRepository } from '../repositories/webhook-subscription.repository';
import {
  webhookEventTypeSchema,
  webhookTriggerDataSchema,
  webhookSendPayloadSchema,
  webhookCorrelationIdSchema,
} from '../modules/webhooks/dto/webhook-payload.dto';
import { ZodError } from 'zod';

/** Max deliveries per destination host per window. Default: 60. */
const HOST_RATE_LIMIT_MAX = Number(process.env.WEBHOOK_HOST_RATE_LIMIT_MAX ?? 60);
/** Window length in ms for per-host rate limiting. Default: 60 000 ms. */
const HOST_RATE_LIMIT_WINDOW_MS = Number(process.env.WEBHOOK_HOST_RATE_LIMIT_WINDOW_MS ?? 60_000);
/** Per-attempt outbound webhook timeout, validated through env schema. */
const WEBHOOK_DELIVERY_TIMEOUT_MS = validateEnv().WEBHOOK_DELIVERY_TIMEOUT_MS;
/** Maximum webhook payload size in bytes, validated through env schema. */
const _WEBHOOK_MAX_PAYLOAD_SIZE_BYTES = validateEnv().WEBHOOK_MAX_PAYLOAD_SIZE_BYTES;

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

    // ── Schema-validate webhook trigger inputs ───────────────────────────
    try {
      webhookEventTypeSchema.parse(eventType);
      webhookTriggerDataSchema.parse(data);
      if (correlationId !== undefined) {
        webhookCorrelationIdSchema.parse(correlationId);
      }
    } catch (err) {
      if (err instanceof ZodError) {
        throw Object.assign(
          new Error(`Webhook trigger validation failed: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`),
          { code: 'webhook_validation_error', issues: err.issues },
        );
      }
      throw err;
    }

    const subscriptions = await this.repo.findAll({ eventType, active: true });
    console.log("TRIGGER FINDALL:", subscriptions.length, "subs for", eventType);

    // Asynchronously deliver to all matching subscriptions
    const deliveries = subscriptions.map((sub) => {
      const payload: WebhookPayload = {
        id: crypto.randomUUID(),
        url: sub.url,
        data,
        retryCount: 0,
        webhookSecret: sub.secret,
        correlationId,
      };
      console.log("SENDING TO:", sub.url);
      return this.send(payload).then(() => {
        console.log("SEND COMPLETE TO:", sub.url);
      }).catch((e) => {
        console.error("SEND ERROR TO:", sub.url, e);
      });
    });

    await Promise.allSettled(deliveries);
  }

  /**
   * Sends a webhook payload with iterative bounded retry and DLQ fallback.
   *
   * Before each attempt the destination URL is re-validated with `isSafeUrl`
   * (SSRF guard) and a per-host sliding-window rate limit is applied.  Either
   * check failing causes an immediate DLQ enqueue without further retries.
   * Each outbound HTTP attempt also uses a validated per-request timeout so a
   * slow receiver cannot pin the delivery worker indefinitely.
   *
   * @remarks
   * Uses a bounded for-loop so no call stack growth occurs across retries.
   * Retry policy and DLQ behavior are identical to the previous recursive version.
   *
   * @param payload - Webhook payload including URL, data, and retry state
   */
  async send(payload: WebhookPayload): Promise<void> {
    // ── Schema-validate the send payload at the boundary ─────────────────
    try {
      webhookSendPayloadSchema.parse(payload);
    } catch (err) {
      if (err instanceof ZodError) {
        throw Object.assign(
          new Error(`Webhook send payload validation failed: ${err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`),
          { code: 'webhook_validation_error', issues: err.issues },
        );
      }
      throw err;
    }

    const maxAttempts = WEBHOOK_RETRY_POLICY.maxRetries + 1;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // ── SSRF re-check ────────────────────────────────────────────────────
      if (!isSafeUrl(payload.url)) {
        await this.persistToDLQ(payload, 'SSRF_BLOCKED: destination URL is private or invalid');
        return;
      }

      // ── Per-host rate limit ──────────────────────────────────────────────
      const hostname = new URL(payload.url).hostname;
      if (!this.checkHostRateLimit(hostname)) {
        await this.persistToDLQ(payload, `RATE_LIMITED: host ${hostname} exceeded delivery limit`);
        return;
      }

      try {
        const headers = buildWebhookHeaders(payload.correlationId);

        if (payload.webhookSecret) {
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
        return;
      } catch (error: unknown) {
        lastError = error as Error;
        payload.retryCount = attempt + 1;

        const isLastAttempt = attempt === maxAttempts - 1;
        if (!isLastAttempt) {
          // Under test we collapse the inter-attempt backoff so the bounded
          // retry loop resolves promptly instead of blocking on multi-second
          // real-timer sleeps. Production keeps the exponential-with-jitter delay.
          const delay = process.env.NODE_ENV === 'test' ? 0 : calculateWebhookRetryDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    await this.persistToDLQ(payload, lastError?.message ?? 'Unknown error');
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

    try {
      await this.send({
        id: entry.webhookId,
        url: entry.url,
        data: entry.body,
        retryCount: 0,
        webhookSecret: entry.webhookSecret,
      });
      this.dlqStorage.markReplayed(id);
      return { success: true, message: 'Replay successful' };
    } catch (err) {
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
