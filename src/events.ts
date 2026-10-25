import { randomUUID } from 'crypto';

export const WEBHOOK_EVENT_TYPES = [
  'contract.created',
  'contract.updated',
  'contract.funded',
  'milestone.released',
  'dispute.raised',
  'dispute.resolved',
  'contract.cancelled',
  'reputation.issued',
  'reputation.updated',
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface EscrowEvent {
  id: string;
  eventId: string;
  eventType: WebhookEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

export type EventListener = (event: EscrowEvent) => void;

export class StoreEventEmitter {
  private readonly listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(eventType: WebhookEventType, data: Record<string, unknown>, now = new Date()): EscrowEvent {
    const event: EscrowEvent = {
      id: randomUUID(),
      eventId: randomUUID(),
      eventType,
      timestamp: now.toISOString(),
      data: structuredClone(data),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Notification failures must never roll back a successful store mutation.
      }
    }
    return event;
  }
}
