import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Base schema for webhook object bodies.
 * Must be a plain object (not a primitive, array, class instance, or null).
 */
export const webhookObjectBodySchema = z
  .record(z.unknown())
  .refine(
    (val) => Object.prototype.toString.call(val) === '[object Object]',
    { message: 'Webhook data must be a plain object' },
  );

// ---------------------------------------------------------------------------
// Webhook trigger payload — the data passed to WebhookService.trigger()
// ---------------------------------------------------------------------------

/**
 * Schema for the event data sent as a webhook body.
 *
 * The data must be a plain object (not a primitive, array, or null).
 */
export const webhookTriggerDataSchema = webhookObjectBodySchema;

/**
 * Schema for the event type string used to route webhook deliveries.
 * Must be a non-empty string at most 200 characters.
 */
export const webhookEventTypeSchema = z
  .string()
  .min(1, 'Event type must not be empty')
  .max(200, 'Event type must not exceed 200 characters');

// ---------------------------------------------------------------------------
// Outbound webhook send payload — the full payload passed to send()
// ---------------------------------------------------------------------------

/**
 * Schema for the correlation ID optionally attached to webhook deliveries.
 * Must be alphanumeric with dots, dashes, and underscores only, max 256 chars.
 */
export const webhookCorrelationIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/, 'Correlation ID must only contain alphanumeric characters, dots, dashes, and underscores')
  .max(256, 'Correlation ID must not exceed 256 characters')
  .optional();

/**
 * Schema for the full send payload consumed by WebhookService.send().
 */
export const webhookSendPayloadSchema = z.object({
  id: z
    .string()
    .min(1, 'Webhook payload id must not be empty'),
  url: z
    .string()
    .url('Webhook URL must be a valid URL'),
  data: z.record(z.unknown()),
  retryCount: z
    .number()
    .int()
    .min(0, 'Retry count must be non-negative'),
  webhookSecret: z
    .string()
    .min(1, 'Webhook secret must not be empty if provided')
    .max(256, 'Webhook secret must not exceed 256 characters')
    .optional(),
  correlationId: webhookCorrelationIdSchema,
});

// ---------------------------------------------------------------------------
// Webhook delivery payload — the payload passed to WebhookDeliveryService.deliver()
// ---------------------------------------------------------------------------

/**
 * Schema for the provider identifier used in webhook delivery metrics.
 * Must be a non-empty string.
 */
export const webhookDeliveryProviderSchema = z
  .string()
  .min(1, 'Provider must not be empty');

/**
 * Schema for the body of a delivery payload.
 * Must be a plain object.
 */
export const webhookDeliveryBodySchema = webhookObjectBodySchema;

/**
 * Schema for the full delivery payload consumed by WebhookDeliveryService.deliver().
 */
export const webhookDeliveryPayloadSchema = z.object({
  provider: webhookDeliveryProviderSchema,
  url: z
    .string()
    .url('Delivery URL must be a valid URL'),
  body: webhookDeliveryBodySchema,
});

// ---------------------------------------------------------------------------
// Webhook delivery result — the response from a delivery attempt
// ---------------------------------------------------------------------------

/**
 * Schema for the result returned by WebhookDeliveryService.deliver().
 * Validates the shape of the delivery outcome.
 */
export const webhookDeliveryResultSchema = z.object({
  success: z.boolean(),
  statusCode: z.number().int().min(100).max(599).optional(),
  durationSeconds: z.number().min(0),
  circuitOpen: z.boolean().optional(),
  enqueueToDoLQ: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Webhook DLQ entry — dead-letter queue entries
// ---------------------------------------------------------------------------

/**
 * Schema for the DLQ entry structure.
 */
export const webhookDLQEntrySchema = z.object({
  provider: z.string().min(1),
  url: z.string().url(),
  body: z.record(z.unknown()),
  failureReason: z.string().min(1),
  finalAttemptNumber: z.number().int().min(1),
  attemptedAt: z.number().int().min(0),
});

// ---------------------------------------------------------------------------
// Type inference
// ---------------------------------------------------------------------------

/** Inferred type for the validated webhook trigger data. */
export type ValidatedWebhookTriggerData = z.infer<typeof webhookTriggerDataSchema>;

/** Inferred type for the validated webhook send payload. */
export type ValidatedWebhookSendPayload = z.infer<typeof webhookSendPayloadSchema>;

/** Inferred type for the validated webhook delivery payload. */
export type ValidatedWebhookDeliveryPayload = z.infer<typeof webhookDeliveryPayloadSchema>;

/** Inferred type for the validated webhook delivery result. */
export type ValidatedWebhookDeliveryResult = z.infer<typeof webhookDeliveryResultSchema>;

/** Inferred type for the validated DLQ entry. */
export type ValidatedWebhookDLQEntry = z.infer<typeof webhookDLQEntrySchema>;
