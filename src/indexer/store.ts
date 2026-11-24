/**
 * In-memory event store with bounded size, deduplication, and indexed queries.
 */

import { EventStore, IndexedEvent, escrowIdOf, EVENT_TYPES } from './types';
import { HttpError } from '../amount-error';

const MAX_EVENTS = 10_000;

function compareEvents(a: IndexedEvent, b: IndexedEvent): number {
  if (a.ledger !== b.ledger) {
    return a.ledger - b.ledger;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function insertSorted(arr: IndexedEvent[], event: IndexedEvent): number {
  if (arr.length === 0 || compareEvents(arr[arr.length - 1], event) <= 0) {
    arr.push(event);
    return arr.length - 1;
  }

  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (compareEvents(arr[mid], event) <= 0) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  arr.splice(lo, 0, event);
  return lo;
}

function binarySearch(arr: IndexedEvent[], target: IndexedEvent): number {
  let lo = 0;
  let hi = arr.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const cmp = compareEvents(arr[mid], target);
    if (cmp === 0) {
      return mid;
    }
    if (cmp < 0) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return -1;
}

export class InMemoryEventStore implements EventStore {
  private cursor: string | null = null;
  private events: IndexedEvent[] = [];
  private idToIndex = new Map<string, number>();
  private byEscrowId = new Map<string, IndexedEvent[]>();
  private byType = new Map<string, IndexedEvent[]>();

  getCursor(): string | null {
    return this.cursor;
  }

  setCursor(cursor: string): void {
    this.cursor = cursor;
  }

  append(events: IndexedEvent[]): IndexedEvent[] {
    let reindexFrom = this.events.length;
    const newlyAdded: IndexedEvent[] = [];

    for (const event of events) {
      if (this.idToIndex.has(event.id)) {
        continue;
      }
      newlyAdded.push(event);

      const idx = insertSorted(this.events, event);
      if (idx < this.events.length - 1) {
        if (idx < reindexFrom) {
          reindexFrom = idx;
        }
      } else {
        this.idToIndex.set(event.id, idx);
      }

      const escrowId = escrowIdOf(event.event);
      if (escrowId !== undefined) {
        let bucket = this.byEscrowId.get(escrowId);
        if (!bucket) {
          bucket = [];
          this.byEscrowId.set(escrowId, bucket);
        }
        insertSorted(bucket, event);
      }

      let typeBucket = this.byType.get(event.event.type);
      if (!typeBucket) {
        typeBucket = [];
        this.byType.set(event.event.type, typeBucket);
      }
      insertSorted(typeBucket, event);
    }

    if (this.events.length > MAX_EVENTS) {
      const excess = this.events.length - MAX_EVENTS;
      const evicted = this.events.splice(0, excess);
      const evictedIds = new Set<string>();
      const affectedEscrowIds = new Set<string>();
      const affectedTypes = new Set<string>();

      for (const removed of evicted) {
        evictedIds.add(removed.id);
        this.idToIndex.delete(removed.id);
        const escrowId = escrowIdOf(removed.event);
        if (escrowId !== undefined) {
          affectedEscrowIds.add(escrowId);
        }
        affectedTypes.add(removed.event.type);
      }

      for (const escrowId of affectedEscrowIds) {
        const bucket = this.byEscrowId.get(escrowId);
        if (bucket) {
          const remaining = bucket.filter((e) => !evictedIds.has(e.id));
          if (remaining.length === 0) {
            this.byEscrowId.delete(escrowId);
          } else {
            this.byEscrowId.set(escrowId, remaining);
          }
        }
      }

      for (const type of affectedTypes) {
        const bucket = this.byType.get(type);
        if (bucket) {
          const remaining = bucket.filter((e) => !evictedIds.has(e.id));
          if (remaining.length === 0) {
            this.byType.delete(type);
          } else {
            this.byType.set(type, remaining);
          }
        }
      }

      for (let i = 0; i < this.events.length; i++) {
        this.idToIndex.set(this.events[i].id, i);
      }
    } else if (reindexFrom < this.events.length) {
      for (let i = reindexFrom; i < this.events.length; i++) {
        this.idToIndex.set(this.events[i].id, i);
      }
    }

    return newlyAdded;
  }

  query(filter: {
    escrowId?: string;
    type?: string;
    limit?: number;
    cursor?: string;
  }): { data: IndexedEvent[]; nextCursor?: string } {
    if (filter.type !== undefined && !EVENT_TYPES.includes(filter.type as any)) {
      throw new HttpError(400, 'invalid_type', `type must be one of: ${EVENT_TYPES.join(', ')}`);
    }

    const limit = filter.limit ?? 50;
    if (limit <= 0) {
      return { data: [], nextCursor: undefined };
    }

    let source: IndexedEvent[];
    let checkEscrowId = false;
    let checkType = false;

    if (filter.escrowId && filter.type) {
      const escrowBucket = this.byEscrowId.get(filter.escrowId) ?? [];
      const typeBucket = this.byType.get(filter.type) ?? [];
      if (escrowBucket.length <= typeBucket.length) {
        source = escrowBucket;
        checkType = true;
      } else {
        source = typeBucket;
        checkEscrowId = true;
      }
    } else if (filter.escrowId) {
      source = this.byEscrowId.get(filter.escrowId) ?? [];
    } else if (filter.type) {
      source = this.byType.get(filter.type) ?? [];
    } else {
      source = this.events;
    }

    let startIdx = source.length - 1;

    if (filter.cursor !== undefined) {
      const globalPos = this.idToIndex.get(filter.cursor);
      if (globalPos === undefined) {
        throw new HttpError(400, 'invalid_cursor', 'cursor not found in filtered set');
      }

      if (source === this.events) {
        startIdx = globalPos - 1;
      } else {
        const cursorEvent = this.events[globalPos];
        const matchesFilter =
          (!filter.escrowId || escrowIdOf(cursorEvent.event) === filter.escrowId) &&
          (!filter.type || cursorEvent.event.type === filter.type);
        if (!matchesFilter) {
          throw new HttpError(400, 'invalid_cursor', 'cursor not found in filtered set');
        }
        const pos = binarySearch(source, cursorEvent);
        if (pos === -1) {
          throw new HttpError(400, 'invalid_cursor', 'cursor not found in filtered set');
        }
        startIdx = pos - 1;
      }
    }

    const data: IndexedEvent[] = [];
    for (let i = startIdx; i >= 0 && data.length < limit; i--) {
      const item = source[i];
      if (checkEscrowId && escrowIdOf(item.event) !== filter.escrowId) {
        continue;
      }
      if (checkType && item.event.type !== filter.type) {
        continue;
      }
      data.push(item);
    }

    return {
      data,
      nextCursor: data.length > 0 ? data[data.length - 1].id : undefined,
    };
  }

  getEventsStored(): number {
    return this.events.length;
  }
}
