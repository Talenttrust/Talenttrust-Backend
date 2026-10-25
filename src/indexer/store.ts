/**
 * In-memory event store with bounded size and deduplication.
 */

import { EventStore, IndexedEvent } from './types';

const MAX_EVENTS = 10_000;

export class InMemoryEventStore implements EventStore {
  private cursor: string | null = null;
  private events: IndexedEvent[] = [];
  private eventIds = new Set<string>();

  getCursor(): string | null {
    return this.cursor;
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
  }

  append(events: IndexedEvent[]): void {
    for (const event of events) {
      if (this.eventIds.has(event.id)) {
        continue;
      }
      this.eventIds.add(event.id);
      this.events.push(event);
    }

    while (this.events.length > MAX_EVENTS) {
      const removed = this.events.shift();
      if (removed) {
        this.eventIds.delete(removed.id);
      }
    }
  }

  query(filter: {
    escrowId?: string;
    type?: string;
    limit?: number;
    cursor?: string;
  }): { data: IndexedEvent[]; nextCursor?: string } {
    let filtered = [...this.events];

    if (filter.escrowId) {
      filtered = filtered.filter((e) => {
        if (e.event.type === 'Unknown') return false;
        return (e.event.data as any).escrowId === filter.escrowId;
      });
    }

    if (filter.type) {
      filtered = filtered.filter((e) => e.event.type === filter.type);
    }

    filtered.sort((a, b) => b.ledger - a.ledger);

    if (filter.cursor) {
      const cursorIndex = filtered.findIndex((e) => e.id === filter.cursor);
      if (cursorIndex !== -1) {
        filtered = filtered.slice(cursorIndex + 1);
      }
    }

    const limit = filter.limit ?? 50;
    const paginated = filtered.slice(0, limit);

    return {
      data: paginated,
      nextCursor: paginated.length > 0 ? paginated[paginated.length - 1].id : undefined,
    };
  }

  getEventsStored(): number {
    return this.events.length;
  }
}
