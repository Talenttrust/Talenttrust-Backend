/**
 * @module reputation-webhook/types
 *
 * Event schema and types for reputation webhook notifications.
 *
 * ## Event Types
 * - `reputation.rating.created`: Emitted when a new reputation rating is created
 *
 * ## Payload Size
 * Webhook payloads are bounded to 100 KB to ensure reliable delivery and
 * prevent abuse. Payloads exceeding this limit are rejected before delivery.
 */

/**
 * Reputation webhook event types.
 */
export type ReputationEventType = 'reputation.rating.created';

/**
 * Base reputation webhook event structure.
 */
export interface ReputationWebhookEvent {
  /** Event type identifier */
  eventType: ReputationEventType;
  /** Unique event ID (UUID v4) */
  eventId: string;
  /** Event timestamp (ISO 8601) */
  timestamp: string;
  /** Event data payload */
  data: ReputationEventData;
}

/**
 * Reputation event data for rating creation.
 */
export interface ReputationRatingCreatedData {
  /** ID of the user being rated */
  targetId: string;
  /** ID of the user who submitted the rating */
  reviewerId: string;
  /** Rating value (1-5) */
  rating: number;
  /** Contract/context reference */
  contextId: string;
  /** Optional review comment (redacted if present) */
  comment?: string;
  /** ID of the reputation entry */
  entryId: string;
  /** Aggregated score after this rating */
  newScore: number;
  /** Total number of ratings after this rating */
  totalRatings: number;
  /** Weighted score after this rating */
  weightedScore: number;
  /** Score algorithm version */
  scoreAlgorithm: string;
}

/**
 * Union type for all reputation event data payloads.
 */
export type ReputationEventData = ReputationRatingCreatedData;

/**
 * Webhook subscription configuration.
 */
export interface ReputationWebhookSubscription {
  /** Subscriber identifier */
  subscriberId: string;
  /** Webhook endpoint URL */
  webhookUrl: string;
  /** HMAC signing secret */
  secret: string;
  /** Event types to subscribe to (empty = all) */
  eventTypes: ReputationEventType[];
  /** Optional filter by targetId */
  targetFilter?: string;
}

/**
 * Maximum webhook payload size in bytes (100 KB).
 */
export const MAX_WEBHOOK_PAYLOAD_SIZE = 100 * 1024;

/**
 * Validates that a webhook payload does not exceed the size limit.
 *
 * @param payload - The payload to validate
 * @returns true if the payload is within size limits
 */
export function validatePayloadSize(payload: unknown): boolean {
  try {
    const serialized = JSON.stringify(payload);
    return Buffer.byteLength(serialized, 'utf8') <= MAX_WEBHOOK_PAYLOAD_SIZE;
  } catch {
    return false;
  }
}

/**
 * Creates a reputation webhook event for rating creation.
 *
 * @param targetId - User being rated
 * @param reviewerId - User submitting the rating
 * @param rating - Rating value
 * @param contextId - Contract reference
 * @param entryId - Reputation entry ID
 * @param newScore - Aggregated score after rating
 * @param totalRatings - Total ratings after rating
 * @param weightedScore - Weighted score after rating
 * @param scoreAlgorithm - Score algorithm version
 * @param comment - Optional comment
 * @returns Reputation webhook event
 */
export function createRatingCreatedEvent(
  targetId: string,
  reviewerId: string,
  rating: number,
  contextId: string,
  entryId: string,
  newScore: number,
  totalRatings: number,
  weightedScore: number,
  scoreAlgorithm: string,
  comment?: string,
): ReputationWebhookEvent {
  return {
    eventType: 'reputation.rating.created',
    eventId: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    data: {
      targetId,
      reviewerId,
      rating,
      contextId,
      entryId,
      newScore,
      totalRatings,
      weightedScore,
      scoreAlgorithm,
      comment,
    },
  };
}
