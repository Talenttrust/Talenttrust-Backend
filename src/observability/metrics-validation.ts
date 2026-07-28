/**
 * @module observability/metrics-validation
 * @description Zod schemas and runtime validators for all metrics write inputs.
 *
 * Every field that flows into a prom-client metric (counter label, gauge value,
 * histogram observation) is validated here before it reaches the store. This
 * prevents:
 *  - High-cardinality label explosions from user-controlled strings.
 *  - Non-finite numeric values (NaN, +-Infinity) poisoning gauge/counter state.
 *  - Unknown fields carried over from attacker-crafted request bodies.
 *
 * @security
 *  - All string label values are validated against a finite enum allowlist.
 *  - All numeric values are checked for finiteness and bounded to safe ranges.
 *  - Unknown fields are stripped / rejected — no passthrough.
 *
 * Machine-readable error code returned on failure: `validation_error`
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Webhook metrics schemas
// ---------------------------------------------------------------------------

export const WEBHOOK_OUTCOMES = ['success', 'failure', 'dlq'] as const;
export type WebhookOutcome = (typeof WEBHOOK_OUTCOMES)[number];

export const WebhookOutcomeSchema = z.enum(WEBHOOK_OUTCOMES, {
  errorMap: () => ({
    message: `outcome must be one of: ${WEBHOOK_OUTCOMES.join(', ')}`,
  }),
});

export const DLQ_OPERATIONS = ['enqueue', 'drop_overflow', 'drop_poison'] as const;
export type DlqOperation = (typeof DLQ_OPERATIONS)[number];

export const DlqOperationSchema = z.enum(DLQ_OPERATIONS, {
  errorMap: () => ({
    message: `operation must be one of: ${DLQ_OPERATIONS.join(', ')}`,
  }),
});

export const DLQ_REPLAY_OUTCOMES = ['success', 'failed', 'idempotent_noop', 'error'] as const;
export type DlqReplayOutcome = (typeof DLQ_REPLAY_OUTCOMES)[number];

export const DlqReplayOutcomeSchema = z.enum(DLQ_REPLAY_OUTCOMES, {
  errorMap: () => ({
    message: `outcome must be one of: ${DLQ_REPLAY_OUTCOMES.join(', ')}`,
  }),
});

// ---------------------------------------------------------------------------
// Service health schemas
// ---------------------------------------------------------------------------

export const SERVICE_STATUSES = ['up', 'degraded', 'down'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const ServiceStatusSchema = z.enum(SERVICE_STATUSES, {
  errorMap: () => ({
    message: `status must be one of: ${SERVICE_STATUSES.join(', ')}`,
  }),
});

// ---------------------------------------------------------------------------
// DLQ depth bounds
// ---------------------------------------------------------------------------

/**
 * Maximum sensible DLQ depth. At 10 million entries the DLQ itself would
 * be a symptom of a severe outage; any higher value is almost certainly a
 * bug or an injection attempt.
 */
export const MAX_DLQ_DEPTH = 10_000_000;

export const DlqDepthSchema = z
  .number()
  .int('DLQ depth must be an integer')
  .finite('DLQ depth must be a finite number')
  .nonnegative('DLQ depth must be >= 0')
  .max(MAX_DLQ_DEPTH, `DLQ depth must be <= ${MAX_DLQ_DEPTH}`);

// ---------------------------------------------------------------------------
// HTTP write-endpoint request body schemas (POST /api/v1/metrics/*)
// ---------------------------------------------------------------------------

/**
 * Body schema for POST /api/v1/metrics/webhook/delivery
 */
export const WebhookDeliveryInputSchema = z
  .object({
    outcome: WebhookOutcomeSchema,
  })
  .strict();

export type WebhookDeliveryInput = z.infer<typeof WebhookDeliveryInputSchema>;

/**
 * Body schema for POST /api/v1/metrics/webhook/dlq-depth
 */
export const WebhookDlqDepthInputSchema = z
  .object({
    depth: DlqDepthSchema,
  })
  .strict();

export type WebhookDlqDepthInput = z.infer<typeof WebhookDlqDepthInputSchema>;

/**
 * Body schema for POST /api/v1/metrics/health-status
 */
export const HealthStatusInputSchema = z
  .object({
    status: ServiceStatusSchema,
  })
  .strict();

export type HealthStatusInput = z.infer<typeof HealthStatusInputSchema>;

/**
 * Body schema for POST /api/v1/metrics/dlq/operation
 */
export const DlqOperationInputSchema = z
  .object({
    operation: DlqOperationSchema,
  })
  .strict();

export type DlqOperationInput = z.infer<typeof DlqOperationInputSchema>;

/**
 * Body schema for POST /api/v1/metrics/dlq/replay
 */
export const DlqReplayInputSchema = z
  .object({
    outcome: DlqReplayOutcomeSchema,
  })
  .strict();

export type DlqReplayInput = z.infer<typeof DlqReplayInputSchema>;

// ---------------------------------------------------------------------------
// Validation result helpers
// ---------------------------------------------------------------------------

export interface MetricsValidationSuccess<T> {
  ok: true;
  data: T;
}

export interface MetricsValidationFailure {
  ok: false;
  code: 'validation_error';
  issues: Array<{ field: string; message: string }>;
}

export type MetricsValidationResult<T> =
  | MetricsValidationSuccess<T>
  | MetricsValidationFailure;

/**
 * Validate an unknown input against a Zod schema.
 * Returns a discriminated-union result, never throws.
 */
export function validateMetricsInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
): MetricsValidationResult<T> {
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data };
  }

  const issues = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(root)',
    message: issue.message,
  }));

  return { ok: false, code: 'validation_error', issues };
}

/**
 * Validate a webhook delivery outcome at runtime.
 * Throws a TypeError when the value is not a recognised outcome.
 * This is the guard used by MetricsService.recordWebhookDelivery().
 */
export function assertWebhookOutcome(value: unknown): WebhookOutcome {
  const result = WebhookOutcomeSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(
      `Invalid webhook outcome: ${JSON.stringify(value)}. ` +
        `Must be one of: ${WEBHOOK_OUTCOMES.join(', ')}`,
    );
  }
  return result.data;
}

/**
 * Validate a DLQ depth value at runtime.
 * Throws a RangeError when the value is out of range.
 */
export function assertDlqDepth(value: unknown): number {
  const result = DlqDepthSchema.safeParse(value);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join('; ');
    throw new RangeError(`Invalid DLQ depth: ${msg}`);
  }
  return result.data;
}

/**
 * Validate a service health status at runtime.
 * Throws a TypeError for unknown values.
 */
export function assertServiceStatus(value: unknown): ServiceStatus {
  const result = ServiceStatusSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(
      `Invalid service status: ${JSON.stringify(value)}. ` +
        `Must be one of: ${SERVICE_STATUSES.join(', ')}`,
    );
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Disputes request metrics
// ---------------------------------------------------------------------------

/**
 * Finite set of error-cause labels for disputes request metrics.
 * Mapped from HTTP status codes — never from raw error messages.
 */
export const DISPUTES_ERROR_CAUSES = [
  'success',
  '4xx_client_error',
  '5xx_server_error',
  'unknown',
] as const;
export type DisputesErrorCause = (typeof DISPUTES_ERROR_CAUSES)[number];

export const DisputesErrorCauseSchema = z.enum(DISPUTES_ERROR_CAUSES, {
  errorMap: () => ({
    message: `error_cause must be one of: ${DISPUTES_ERROR_CAUSES.join(', ')}`,
  }),
});

/**
 * Map an HTTP status code to a cardinality-safe disputes error-cause label.
 */
export function mapDisputesErrorCause(statusCode: number): DisputesErrorCause {
  if (statusCode >= 200 && statusCode < 300) {
    return 'success';
  }
  if (statusCode >= 400 && statusCode < 500) {
    return '4xx_client_error';
  }
  if (statusCode >= 500 && statusCode < 600) {
    return '5xx_server_error';
  }
  return 'unknown';
}

/**
 * Validate a disputes error-cause label at runtime.
 * Throws a TypeError for unknown values.
 */
export function assertDisputesErrorCause(value: unknown): DisputesErrorCause {
  const result = DisputesErrorCauseSchema.safeParse(value);
  if (!result.success) {
    throw new TypeError(
      `Invalid disputes error_cause: ${JSON.stringify(value)}. ` +
        `Must be one of: ${DISPUTES_ERROR_CAUSES.join(', ')}`,
    );
  }
  return result.data;
}
