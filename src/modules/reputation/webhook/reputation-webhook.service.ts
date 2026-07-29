/**
 * @module reputation-webhook/service
 *
 * Reputation webhook notification service.
 *
 * Emits signed webhook callbacks to subscribers on notable reputation events
 * with retry/backoff and dead-letter queue handling.
 */

import { Registry, Counter } from 'prom-client';
import { v4 as uuidv4 } from 'uuid';
import {
  WebhookDeliveryService,
  type DeliveryPayload,
  type DLQEntry,
  createWebhookSignature,
} from '../../../webhookDelivery';
import { InMemoryDlqStore, type DlqStore } from '../../../dlqStore';
import {
  type ReputationWebhookEvent,
  type ReputationWebhookSubscription,
  type ReputationEventData,
  ReputationEventType,
  validatePayloadSize,
  createRatingCreatedEvent,
} from './reputation-webhook.types';

/**
 * Service configuration options.
 */
export interface ReputationWebhookServiceConfig {
  /** Custom DLQ store implementation (defaults to in-memory) */
  dlqStore?: DlqStore;
  /** Prometheus metrics registry */
  registry: Registry;
  /** Webhook circuit breaker configuration */
  circuitBreakerConfig?: {
    failureThreshold?: number;
    successThreshold?: number;
    timeoutMs?: number;
  };
  /** Webhook retry configuration */
  retryConfig?: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    multiplier?: number;
    jitterFactor?: number;
  };
}

/**
 * Delivery result with subscription context.
 */
export interface ReputationWebhookDeliveryResult {
  subscriptionId: string;
  success: boolean;
  statusCode?: number;
  durationSeconds: number;
  circuitOpen?: boolean;
  enqueueToDoLQ?: boolean;
  error?: string;
}

/**
 * Reputation webhook service.
 *
 * Manages webhook subscriptions and delivers reputation events to subscribers
 * with retry logic, circuit breaking, and DLQ handling.
 */
export class ReputationWebhookService {
  private readonly deliveryService: WebhookDeliveryService;
  private readonly dlqStore: DlqStore;
  private readonly subscriptions = new Map<string, ReputationWebhookSubscription>();
  private readonly metrics: {
    eventsEmittedTotal: Counter<string>;
    deliveriesTotal: Counter<string>;
    deliveriesSuccessTotal: Counter<string>;
    deliveriesFailureTotal: Counter<string>;
    dlqEnqueuedTotal: Counter<string>;
  };

  constructor(config: ReputationWebhookServiceConfig) {
    this.dlqStore = config.dlqStore ?? new InMemoryDlqStore();
    
    // Initialize webhook delivery service with DLQ callback
    this.deliveryService = new WebhookDeliveryService(
      config.registry,
      config.circuitBreakerConfig,
      config.retryConfig,
      this.handleDlqEntry.bind(this),
    );

    // Initialize metrics
    const eventsEmittedTotal = new Counter({
      name: 'reputation_webhook_events_emitted_total',
      help: 'Total number of reputation webhook events emitted',
      labelNames: ['event_type'] as const,
      registers: [config.registry],
    });

    const deliveriesTotal = new Counter({
      name: 'reputation_webhook_deliveries_total',
      help: 'Total number of reputation webhook delivery attempts',
      labelNames: ['subscription_id', 'event_type'] as const,
      registers: [config.registry],
    });

    const deliveriesSuccessTotal = new Counter({
      name: 'reputation_webhook_deliveries_success_total',
      help: 'Total number of successful reputation webhook deliveries',
      labelNames: ['subscription_id', 'event_type'] as const,
      registers: [config.registry],
    });

    const deliveriesFailureTotal = new Counter({
      name: 'reputation_webhook_deliveries_failure_total',
      help: 'Total number of failed reputation webhook deliveries',
      labelNames: ['subscription_id', 'event_type', 'reason'] as const,
      registers: [config.registry],
    });

    const dlqEnqueuedTotal = new Counter({
      name: 'reputation_webhook_dlq_enqueued_total',
      help: 'Total number of reputation webhook events enqueued to DLQ',
      labelNames: ['subscription_id', 'event_type'] as const,
      registers: [config.registry],
    });

    this.metrics = {
      eventsEmittedTotal,
      deliveriesTotal,
      deliveriesSuccessTotal,
      deliveriesFailureTotal,
      dlqEnqueuedTotal,
    };
  }

  /**
   * Register a webhook subscription.
   *
   * @param subscription - Subscription configuration
   * @returns Subscription ID
   */
  public addSubscription(subscription: ReputationWebhookSubscription): string {
    const subscriptionId = subscription.subscriberId || uuidv4();
    this.subscriptions.set(subscriptionId, subscription);
    return subscriptionId;
  }

  /**
   * Remove a webhook subscription.
   *
   * @param subscriptionId - Subscription ID to remove
   * @returns true if subscription was removed
   */
  public removeSubscription(subscriptionId: string): boolean {
    return this.subscriptions.delete(subscriptionId);
  }

  /**
   * Get all subscriptions.
   *
   * @returns Array of subscriptions with their IDs
   */
  public getSubscriptions(): Array<{ id: string; subscription: ReputationWebhookSubscription }> {
    return Array.from(this.subscriptions.entries()).map(([id, sub]) => ({ id, subscription: sub }));
  }

  /**
   * Emit a reputation webhook event to matching subscribers.
   *
   * @param event - Reputation event to emit
   * @returns Array of delivery results per subscription
   */
  public async emitEvent(event: ReputationWebhookEvent): Promise<ReputationWebhookDeliveryResult[]> {
    // Validate payload size before delivery
    if (!validatePayloadSize(event)) {
      throw new Error(`Webhook payload exceeds maximum size of 100 KB`);
    }

    // Emit event metric
    this.metrics.eventsEmittedTotal.inc({ event_type: event.eventType });

    // Find matching subscriptions
    const matchingSubscriptions = this.findMatchingSubscriptions(event);

    if (matchingSubscriptions.length === 0) {
      return [];
    }

    // Deliver to all matching subscriptions in parallel
    const deliveryPromises = matchingSubscriptions.map(([id, subscription]) =>
      this.deliverToSubscription(id, subscription, event),
    );

    return Promise.all(deliveryPromises);
  }

  /**
   * Emit a rating created event.
   *
   * Convenience method for the most common reputation event.
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
   * @returns Array of delivery results
   */
  public async emitRatingCreated(
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
  ): Promise<ReputationWebhookDeliveryResult[]> {
    const event = createRatingCreatedEvent(
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
    );
    return this.emitEvent(event);
  }

  /**
   * Find subscriptions that match an event.
   *
   * @param event - Event to match
   * @returns Matching subscription entries
   */
  private findMatchingSubscriptions(
    event: ReputationWebhookEvent,
  ): Array<[string, ReputationWebhookSubscription]> {
    const matches: Array<[string, ReputationWebhookSubscription]> = [];

    for (const [id, subscription] of this.subscriptions.entries()) {
      // Check event type filter
      if (subscription.eventTypes.length > 0 && !subscription.eventTypes.includes(event.eventType)) {
        continue;
      }

      // Check target filter
      if (subscription.targetFilter && event.data.targetId !== subscription.targetFilter) {
        continue;
      }

      matches.push([id, subscription]);
    }

    return matches;
  }

  /**
   * Deliver an event to a single subscription.
   *
   * @param subscriptionId - Subscription ID
   * @param subscription - Subscription configuration
   * @param event - Event to deliver
   * @returns Delivery result
   */
  private async deliverToSubscription(
    subscriptionId: string,
    subscription: ReputationWebhookSubscription,
    event: ReputationWebhookEvent,
  ): Promise<ReputationWebhookDeliveryResult> {
    // Increment delivery attempt metric
    this.metrics.deliveriesTotal.inc({
      subscription_id: subscriptionId,
      event_type: event.eventType,
    });

    // Create webhook signature
    const signature = createWebhookSignature(event, subscription.secret);

    // Prepare delivery payload
    const payload: DeliveryPayload = {
      provider: 'reputation-webhook',
      url: subscription.webhookUrl,
      body: {
        ...event,
        signature: signature.signature,
        timestamp: signature.timestamp,
      },
    };

    // HTTP client for delivery
    const httpClient = async (url: string, body: Record<string, unknown>) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': `sha256=${signature.signature}`,
          'X-Timestamp': signature.timestamp.toString(),
          'X-Event-Type': event.eventType,
          'X-Event-ID': event.eventId,
        },
        body: JSON.stringify(body),
      });

      return { statusCode: response.status };
    };

    try {
      const result = await this.deliveryService.deliver(payload, httpClient);

      if (result.success) {
        this.metrics.deliveriesSuccessTotal.inc({
          subscription_id: subscriptionId,
          event_type: event.eventType,
        });
      } else {
        this.metrics.deliveriesFailureTotal.inc({
          subscription_id: subscriptionId,
          event_type: event.eventType,
          reason: result.circuitOpen ? 'circuit_open' : 'delivery_failed',
        });
      }

      return {
        subscriptionId,
        success: result.success,
        statusCode: result.statusCode,
        durationSeconds: result.durationSeconds,
        circuitOpen: result.circuitOpen,
        enqueueToDoLQ: result.enqueueToDoLQ,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.metrics.deliveriesFailureTotal.inc({
        subscription_id: subscriptionId,
        event_type: event.eventType,
        reason: 'exception',
      });

      return {
        subscriptionId,
        success: false,
        durationSeconds: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Handle DLQ entry from failed delivery.
   *
   * @param entry - DLQ entry from webhook delivery service
   */
  private async handleDlqEntry(entry: DLQEntry): Promise<void> {
    // Convert webhook delivery DLQ entry to reputation DLQ entry
    const dlqEntry = {
      providerId: 'reputation-webhook',
      deliveryId: uuidv4(),
      targetUrl: entry.url,
      payload: entry.body,
      timestamp: entry.attemptedAt,
      attemptCount: entry.finalAttemptNumber,
    };

    this.dlqStore.push(dlqEntry);

    // Emit DLQ metric
    const eventType = (entry.body as { eventType?: string })?.eventType || 'unknown';
    const subscriptionId = (entry.body as { subscriptionId?: string })?.subscriptionId || 'unknown';
    this.metrics.dlqEnqueuedTotal.inc({
      subscription_id: subscriptionId,
      event_type: eventType,
    });
  }

  /**
   * Get DLQ depth by provider.
   *
   * @returns Map of provider ID to entry count
   */
  public getDlqDepth(): Map<string, number> {
    return this.dlqStore.getDepthByProvider();
  }

  /**
   * Get DLQ oldest entry age by provider.
   *
   * @returns Map of provider ID to age in seconds
   */
  public getDlqOldestAge(): Map<string, number> {
    return this.dlqStore.getOldestAgeByProvider();
  }

  /**
   * Drain DLQ entries for a provider.
   *
   * @param providerId - Provider to drain
   * @param count - Maximum entries to drain
   * @returns Drained entries
   */
  public drainDlq(providerId: string, count: number): ReturnType<DlqStore['drain']> {
    return this.dlqStore.drain(providerId, count);
  }

  /**
   * Clear all DLQ entries (for testing).
   */
  public clearDlq(): void {
    this.dlqStore.clear();
  }

  /**
   * Clear all subscriptions (for testing).
   */
  public clearSubscriptions(): void {
    this.subscriptions.clear();
  }
}

// Singleton instance for application-wide use
let globalInstance: ReputationWebhookService | null = null;

/**
 * Initialize the global reputation webhook service.
 *
 * @param config - Service configuration
 * @returns The initialized service
 */
export function initializeReputationWebhookService(
  config: ReputationWebhookServiceConfig,
): ReputationWebhookService {
  if (globalInstance) {
    throw new Error('ReputationWebhookService already initialized');
  }
  globalInstance = new ReputationWebhookService(config);
  return globalInstance;
}

/**
 * Get the global reputation webhook service instance.
 *
 * @returns The service instance
 * @throws Error if service not initialized
 */
export function getReputationWebhookService(): ReputationWebhookService {
  if (!globalInstance) {
    throw new Error('ReputationWebhookService not initialized. Call initializeReputationWebhookService first.');
  }
  return globalInstance;
}

/**
 * Reset the global reputation webhook service instance (for testing).
 */
export function resetGlobalInstance(): void {
  globalInstance = null;
}
