/**
 * @notice Outcome returned when reserving a webhook event id for processing.
 */
export type DeliveryReservationResult = 'accepted' | 'duplicate';

/**
 * @notice Minimal replay-protection storage contract.
 */
export interface WebhookDeliveryStore {
  /**
   * @param eventId Provider delivery identifier.
   * @returns Whether the caller may process the event.
   */
  reserve(eventId: string): DeliveryReservationResult;

  /**
   * @param eventId Delivery identifier that completed successfully.
   */
  markProcessed(eventId: string): void;

  /**
   * @param eventId Delivery identifier that failed and should be retried later.
   */
  release(eventId: string): void;
}

interface DeliveryEntry {
  status: 'processing' | 'processed';
  expiresAt: number;
}

/**
 * @notice In-memory replay-protection store for webhook deliveries.
 * @dev This keeps idempotency deterministic in tests and single-process usage.
 */
export class InMemoryWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly entries = new Map<string, DeliveryEntry>();

  /**
   * @param retentionSeconds Retention window for processed event ids.
   * @param now Clock injection for deterministic expiry tests.
   */
  constructor(
    private readonly retentionSeconds: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * @inheritdoc
   */
  reserve(eventId: string): DeliveryReservationResult {
    this.evictExpiredEntries();

    if (this.entries.has(eventId)) {
      return 'duplicate';
    }

    this.entries.set(eventId, {
      status: 'processing',
      expiresAt: this.expiresAt(),
    });

    return 'accepted';
  }

  /**
   * @inheritdoc
   */
  markProcessed(eventId: string): void {
    if (!this.entries.has(eventId)) {
      return;
    }

    this.entries.set(eventId, {
      status: 'processed',
      expiresAt: this.expiresAt(),
    });
  }

  /**
   * @inheritdoc
   */
  release(eventId: string): void {
    this.entries.delete(eventId);
  }

  /**
   * @notice Return the number of active replay-protection entries for tests.
   */
  size(): number {
    this.evictExpiredEntries();
    return this.entries.size;
  }

  /**
   * @notice Compute the retention deadline for a delivery id.
   */
  private expiresAt(): number {
    return this.now() + this.retentionSeconds * 1000;
  }

  /**
   * @notice Opportunistically clear expired entries.
   */
  private evictExpiredEntries(): void {
    for (const [eventId, entry] of this.entries.entries()) {
      if (entry.expiresAt <= this.now()) {
        this.entries.delete(eventId);
      }
    }
  }
}
