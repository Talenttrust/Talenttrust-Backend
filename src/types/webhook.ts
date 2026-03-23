/**
 * @notice Header and payload fields accepted by the blockchain webhook endpoint.
 */
export interface BlockchainWebhookPayload {
  id?: string;
  type?: string;
  occurredAt?: string;
  network?: string;
  data?: {
    contractId?: string;
    transactionHash?: string;
    blockNumber?: number;
    metadataUri?: string;
    status?: string;
  };
}

/**
 * @notice Supported normalized event types processed by the backend.
 */
export type SupportedWebhookEventType =
  | 'contract.metadata.updated'
  | 'contract.payment.released';

/**
 * @notice Canonical event shape forwarded to internal processing.
 */
export interface NormalizedWebhookEvent {
  eventId: string;
  eventType: SupportedWebhookEventType;
  occurredAt: string;
  network: string;
  contractId: string;
  transactionHash?: string;
  blockNumber?: number;
  metadataUri?: string;
  status?: string;
}

/**
 * @notice Result returned after a verified webhook delivery is handled.
 */
export interface WebhookHandlingResult {
  duplicate: boolean;
  event: NormalizedWebhookEvent;
}

/**
 * @notice Internal processor interface that keeps business logic out of routes.
 */
export interface WebhookEventProcessor {
  /**
   * @param event Verified normalized event ready for application handling.
   */
  process(event: NormalizedWebhookEvent): void;
}
