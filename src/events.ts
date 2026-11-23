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
  'contract.drift_detected',
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
  private readonly history: EscrowEvent[] = [];
  private static readonly HISTORY_LIMIT = 500;

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Events after a known id, or the retained window when that id has expired. */
  replayAfter(eventId: string): EscrowEvent[] {
    const index = this.history.findIndex((event) => event.eventId === eventId);
    return this.history.slice(index >= 0 ? index + 1 : 0);
  }

  emit(eventType: WebhookEventType, data: Record<string, unknown>, now = new Date()): EscrowEvent {
    const event: EscrowEvent = {
      id: randomUUID(),
      eventId: randomUUID(),
      eventType,
      timestamp: now.toISOString(),
      data: structuredClone(data),
    };
    this.history.push(event);
    if (this.history.length > StoreEventEmitter.HISTORY_LIMIT) this.history.shift();
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
