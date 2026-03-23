import { ApiError } from '../errors/ApiError';
import type { BlockchainWebhookPayload, NormalizedWebhookEvent, SupportedWebhookEventType, WebhookEventProcessor, WebhookHandlingResult } from '../types/webhook';
import type { WebhookDeliveryStore } from './webhook-delivery-store';

const SUPPORTED_EVENT_TYPES: SupportedWebhookEventType[] = [
  'contract.metadata.updated',
  'contract.payment.released',
];

/**
 * @notice Validate, normalize, and idempotently process verified webhook events.
 */
export class WebhookService {
  /**
   * @param deliveryStore Replay-protection storage for provider delivery ids.
   * @param eventProcessor Internal handler invoked only for verified new events.
   */
  constructor(
    private readonly deliveryStore: WebhookDeliveryStore,
    private readonly eventProcessor: WebhookEventProcessor,
  ) {}

  /**
   * @notice Normalize a verified payload and process it exactly once.
   * @param payload Parsed webhook payload.
   * @param headerEventId Event id supplied by the delivery headers.
   */
  handleVerifiedPayload(
    payload: BlockchainWebhookPayload,
    headerEventId?: string,
  ): WebhookHandlingResult {
    const normalized = normalizeWebhookPayload(payload, headerEventId);
    const reservation = this.deliveryStore.reserve(normalized.eventId);

    if (reservation === 'duplicate') {
      return { duplicate: true, event: normalized };
    }

    try {
      this.eventProcessor.process(normalized);
      this.deliveryStore.markProcessed(normalized.eventId);
      return { duplicate: false, event: normalized };
    } catch (error) {
      this.deliveryStore.release(normalized.eventId);
      throw error;
    }
  }
}

/**
 * @notice Default in-memory processor used until a persistent event pipeline exists.
 */
export class InMemoryWebhookEventProcessor implements WebhookEventProcessor {
  private readonly processedEvents: NormalizedWebhookEvent[] = [];

  /**
   * @inheritdoc
   */
  process(event: NormalizedWebhookEvent): void {
    this.processedEvents.push(event);
  }

  /**
   * @notice Return processed events for deterministic tests.
   */
  listProcessedEvents(): NormalizedWebhookEvent[] {
    return [...this.processedEvents];
  }
}

/**
 * @notice Validate and normalize the verified webhook payload.
 * @param payload Parsed JSON body.
 * @param headerEventId Delivery id from the signed request headers.
 */
export function normalizeWebhookPayload(
  payload: BlockchainWebhookPayload,
  headerEventId?: string,
): NormalizedWebhookEvent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ApiError(400, 'Webhook payload must be a JSON object.');
  }

  const eventId = sanitizeNonEmptyString(headerEventId ?? payload.id, 'Webhook event id is required.');
  const eventType = sanitizeSupportedEventType(payload.type);
  const occurredAt = sanitizeIsoDate(payload.occurredAt, 'Webhook occurredAt must be a valid ISO-8601 timestamp.');
  const network = sanitizeNonEmptyString(payload.network, 'Webhook network is required.');

  if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
    throw new ApiError(400, 'Webhook data must be a JSON object.');
  }

  const contractId = sanitizeIdentifier(payload.data.contractId, 'Webhook contractId is invalid.');
  const transactionHash = sanitizeOptionalHash(payload.data.transactionHash);
  const metadataUri = sanitizeOptionalString(payload.data.metadataUri);
  const status = sanitizeOptionalString(payload.data.status);
  const blockNumber = sanitizeOptionalBlockNumber(payload.data.blockNumber);

  return {
    eventId,
    eventType,
    occurredAt,
    network,
    contractId,
    transactionHash,
    metadataUri,
    status,
    blockNumber,
  };
}

/**
 * @notice Expose supported event types for tests and docs.
 */
export function listSupportedWebhookEventTypes(): SupportedWebhookEventType[] {
  return [...SUPPORTED_EVENT_TYPES];
}

function sanitizeSupportedEventType(value: string | undefined): SupportedWebhookEventType {
  const eventType = sanitizeNonEmptyString(value, 'Webhook event type is required.');

  if (!SUPPORTED_EVENT_TYPES.includes(eventType as SupportedWebhookEventType)) {
    throw new ApiError(400, 'Webhook event type is not supported.');
  }

  return eventType as SupportedWebhookEventType;
}

function sanitizeNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ApiError(400, message);
  }

  return value.trim();
}

function sanitizeIsoDate(value: unknown, message: string): string {
  const timestamp = sanitizeNonEmptyString(value, message);

  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ApiError(400, message);
  }

  return new Date(timestamp).toISOString();
}

function sanitizeIdentifier(value: unknown, message: string): string {
  const identifier = sanitizeNonEmptyString(value, message);

  if (!/^[A-Za-z0-9-]{3,128}$/.test(identifier)) {
    throw new ApiError(400, message);
  }

  return identifier;
}

function sanitizeOptionalHash(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const hash = sanitizeNonEmptyString(value, 'Webhook transactionHash is invalid.');

  if (!/^0x[a-fA-F0-9]{8,128}$/.test(hash)) {
    throw new ApiError(400, 'Webhook transactionHash is invalid.');
  }

  return hash.toLowerCase();
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return sanitizeNonEmptyString(value, 'Webhook string field is invalid.');
}

function sanitizeOptionalBlockNumber(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ApiError(400, 'Webhook blockNumber is invalid.');
  }

  return value as number;
}
