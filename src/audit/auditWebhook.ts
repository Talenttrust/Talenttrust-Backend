/**
 * @module audit/auditWebhook
 * @description Transforms audit log entries into outbound webhook payloads and
 * delivers them through the existing WebhookService (retry/backoff/DLQ included).
 *
 * ## Payload bounding
 *
 * The webhook data payload (audit entry metadata) is bounded so a single
 * over-sized metadata object cannot starve other deliveries or crash the
 * outbound HTTP client. The default cap mirrors the system-wide
 * `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES` env var; callers may override it at
 * construction time for testing.
 *
 * ## Notable events
 *
 * All audit events are forwarded — filtering by severity/action is left to
 * subscribers via the `eventType` field.  This keeps the producer side simple
 * and avoids drift between the filter logic here and the subscriber config.
 */

import type { AuditEntry } from './types';
import type { WebhookService } from '../services/webhook.service';
import { redactObject } from '../utils/redact';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Shape of the `data` field inside the webhook envelope for audit events.
 *
 * Mirrors the fields of {@link AuditEntry} that are safe for external
 * consumers — `hash` and `previousHash` are **not** included because they
 * are internal chain-integrity values, not business data.
 */
export interface AuditWebhookData {
  /** Unique identifier for this audit log entry (UUID v4). */
  id: string;
  /** ISO-8601 UTC timestamp of when the event occurred. */
  timestamp: string;
  /** The type of sensitive action that was performed. */
  action: string;
  /** Severity classification of the event. */
  severity: string;
  /** Actor who performed the action. */
  actor: string;
  /** Resource type affected. */
  resource: string;
  /** Identifier of the specific resource instance affected. */
  resourceId: string;
  /**
   * Structured metadata about the change.
   * Sensitive fields are redacted before emission.
   */
  metadata: Record<string, unknown>;
  /** IP address of the request origin, if available. */
  ipAddress?: string;
  /** Correlation ID for tracing across services. */
  correlationId?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Event type subscribers use to receive all audit webhook events. */
export const AUDIT_WEBHOOK_EVENT_TYPE = 'audit.event';

/**
 * Maximum serialised payload size in bytes (default: 1 MB, matching the
 * system-wide `WEBHOOK_MAX_PAYLOAD_SIZE_BYTES` default).
 */
export const DEFAULT_AUDIT_WEBHOOK_MAX_PAYLOAD_BYTES = 1_048_576;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Partially masks email addresses found in string values.
 * E.g. `alice@example.com` → `ali***@example.com`.
 */
function maskEmails(obj: Record<string, unknown>): Record<string, unknown> {
  const EMAIL_PATTERN = /^([^@]{1,3})[^@]*(@[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,})$/;

  function walk(value: unknown): unknown {
    if (typeof value === 'string') {
      const emailMatch = value.match(EMAIL_PATTERN);
      if (emailMatch) {
        return `${emailMatch[1]}***${emailMatch[2]}`;
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  }

  return walk(obj) as Record<string, unknown>;
}

/**
 * Pattern for keys whose **name contains** a sensitive substring.
 * This is intentionally broader than {@link redactObject}'s exact
 * normalized-key matching — compound keys like `userSecret` or `apiToken`
 * should be redacted even though they are not in the exact-match set.
 */
const SENSITIVE_KEY_SUBSTRING = /secret|token|password|credential|apikey|api_key|private/i;

/**
 * Recursively redacts values whose key contains a sensitive substring.
 * Operates on top of {@link redactObject} (which handles exact matches
 * like `secret`, `token`, `password`) so both layers are applied.
 */
function redactBySubstring(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SENSITIVE_KEY_SUBSTRING.test(k)) {
      out[k] = '[REDACTED]';
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? redactBySubstring(item as Record<string, unknown>)
          : item,
      );
    } else if (v !== null && typeof v === 'object') {
      out[k] = redactBySubstring(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Redacts sensitive metadata fields and masks email addresses before the
 * audit entry is included in an outbound webhook payload.
 *
 * Uses two layers of redaction:
 * 1. {@link redactObject} for exact normalized-key matches (e.g. `secret`,
 *    `token`, `password`, `privateKey`).
 * 2. {@link redactBySubstring} for compound keys containing sensitive
 *    substrings (e.g. `userSecret`, `apiToken`).
 * 3. Email address masking in string values.
 */
function redactAuditMetadata(metadata: Readonly<Record<string, unknown>>): Record<string, unknown> {
  // Layer 1: exact key matches via the shared redact utility
  const exact = redactObject(metadata as Record<string, unknown>);
  // Layer 2: substring matches for compound keys
  const substring = redactBySubstring(exact);
  // Layer 3: email masking
  return maskEmails(substring);
}

/**
 * Creates a bounds-safe webhook data payload from an audit entry.
 *
 * @param entry - The persisted audit entry.
 * @param maxPayloadBytes - Maximum allowed serialised payload size.
 * @returns The webhook data object, or `undefined` if the serialised
 *   payload exceeds `maxPayloadBytes` even after truncation.
 */
export function createAuditWebhookData(
  entry: AuditEntry,
  maxPayloadBytes: number = DEFAULT_AUDIT_WEBHOOK_MAX_PAYLOAD_BYTES,
): AuditWebhookData | undefined {
  const metadata = redactAuditMetadata(entry.metadata);

  const data: AuditWebhookData = {
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.action,
    severity: entry.severity,
    actor: entry.actor,
    resource: entry.resource,
    resourceId: entry.resourceId,
    metadata,
    ...(entry.ipAddress !== undefined && { ipAddress: entry.ipAddress }),
    ...(entry.correlationId !== undefined && { correlationId: entry.correlationId }),
  };

  // Check serialised size
  const serialised = JSON.stringify(data);
  if (Buffer.byteLength(serialised, 'utf-8') <= maxPayloadBytes) {
    return data;
  }

  // Try with truncated metadata (drop metadata if too large)
  const withoutMetadata: AuditWebhookData = {
    ...data,
    metadata: { _truncated: true, _originalKeys: Object.keys(metadata).slice(0, 20) },
  };
  const truncated = JSON.stringify(withoutMetadata);
  if (Buffer.byteLength(truncated, 'utf-8') <= maxPayloadBytes) {
    return withoutMetadata;
  }

  // Payload too large even without metadata — skip this event
  return undefined;
}

// ─── Service ──────────────────────────────────────────────────────────────────

export interface AuditWebhookOptions {
  /** Maximum serialised webhook payload size in bytes. */
  maxPayloadBytes?: number;
}

/**
 * Lightweight service that bridges the audit log and the webhook subsystem.
 *
 * ## Usage
 *
 * ```ts
 * import { auditService } from './audit/service';
 * import { AuditWebhookService } from './audit/auditWebhook';
 * import { WebhookService } from '../services/webhook.service';
 *
 * const webhookService = new WebhookService();
 * const auditWebhook = new AuditWebhookService(webhookService);
 *
 * auditService.onAfterLog = (entry) => {
 *   auditWebhook.notify(entry).catch(() => {});
 * };
 * ```
 */
export class AuditWebhookService {
  private readonly maxPayloadBytes: number;

  constructor(
    private readonly webhookService: WebhookService,
    options: AuditWebhookOptions = {},
  ) {
    this.maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_AUDIT_WEBHOOK_MAX_PAYLOAD_BYTES;
  }

  /**
   * Transforms an audit entry into a webhook payload and triggers delivery
   * to all subscribers of {@link AUDIT_WEBHOOK_EVENT_TYPE}.
   *
   * When the audit payload cannot be serialised within the configured size
   * bound, the event is silently skipped (no DLQ entry is created, no error
   * is thrown — the audit entry itself is already persisted).
   *
   * @param entry - The persisted audit entry to forward.
   * @returns A promise that resolves when all delivery attempts have been
   *   initiated (retries/DLQ are handled asynchronously by the webhook
   *   subsystem).
   */
  async notify(entry: AuditEntry): Promise<void> {
    const data = createAuditWebhookData(entry, this.maxPayloadBytes);
    if (!data) {
      // Payload too large — skip this event.  The audit entry is already
      // safely persisted; we just cannot forward it as a webhook.
      return;
    }

    await this.webhookService.trigger(
      AUDIT_WEBHOOK_EVENT_TYPE,
      data,
      entry.correlationId,
    );
  }
}
