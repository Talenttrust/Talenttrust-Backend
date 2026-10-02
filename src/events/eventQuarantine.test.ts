/**
 * @file eventQuarantine.test.ts
 * @description Unit tests for the event quarantine store
 * (`src/events/eventQuarantine.ts`): redacted persistence, bounded replay
 * attempts, capacity eviction, and stats.
 */

import { EventQuarantineStorage } from './eventQuarantine';

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'MILESTONE_RELEASED',
    payload: { milestoneId: 'm-1', amount: 100 },
    schemaVersion: 2,
    network: 'soroban',
    ledger: 120,
    ...overrides,
  };
}

describe('EventQuarantineStorage', () => {
  let store: EventQuarantineStorage;

  beforeEach(() => {
    store = new EventQuarantineStorage(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('stores an entry with identity fields and stats', () => {
    const id = store.addEntry({
      contractId: 'contract-1',
      eventId: 'event-1',
      sequence: 1,
      schemaVersion: 2,
      eventType: 'MILESTONE_RELEASED',
      payload: makeEvent(),
      reason: 'Unknown contract schema version 2',
    });

    const entry = store.getEntry(id)!;
    expect(entry.contractId).toBe('contract-1');
    expect(entry.eventId).toBe('event-1');
    expect(entry.sequence).toBe(1);
    expect(entry.schemaVersion).toBe(2);
    expect(entry.eventType).toBe('MILESTONE_RELEASED');
    expect(entry.replayAttempts).toBe(0);

    expect(store.getStats()).toEqual({ total: 1, pending: 1, replayed: 0 });
  });

  it('redacts sensitive payload fields before persistence', () => {
    const id = store.addEntry({
      contractId: 'contract-1',
      eventId: 'event-1',
      sequence: 1,
      schemaVersion: 2,
      eventType: 'MILESTONE_RELEASED',
      payload: makeEvent({ payload: { secret: 's3cr3t', amount: 100 } }),
      reason: 'Unknown version',
    });

    const entry = store.getEntry(id)!;
    expect(entry.payload.payload.secret).not.toBe('s3cr3t');
    expect(entry.reason).not.toContain('stack');
  });

  it('lists entries newest-first with filters and pagination', () => {
    store.addEntry({ contractId: 'c-a', eventId: 'e1', sequence: 1, schemaVersion: 2, eventType: 'CONTRACT_CREATED', payload: makeEvent({ contractId: 'c-a', eventId: 'e1', type: 'CONTRACT_CREATED' }), reason: 'r1' });
    store.addEntry({ contractId: 'c-b', eventId: 'e2', sequence: 1, schemaVersion: 2, eventType: 'MILESTONE_RELEASED', payload: makeEvent({ contractId: 'c-b', eventId: 'e2' }), reason: 'r2' });

    const all = store.listEntries();
    expect(all).toHaveLength(2);
    expect(store.listEntries({ contractId: 'c-a' })).toHaveLength(1);
    expect(store.listEntries({ eventType: 'MILESTONE_RELEASED' })).toHaveLength(1);
    expect(store.listEntries({ limit: 1 })).toHaveLength(1);
  });

  it('tracks replay attempts and flags max-exceeded', () => {
    const id = store.addEntry({
      contractId: 'c-1', eventId: 'e1', sequence: 1, schemaVersion: 2,
      eventType: 'MILESTONE_RELEASED', payload: makeEvent(), reason: 'r',
    });

    expect(store.incrementReplayAttempts(id)).toMatchObject({ success: true, attempts: 1, maxExceeded: false });
    expect(store.incrementReplayAttempts(id)).toMatchObject({ attempts: 2, maxExceeded: false });
    expect(store.incrementReplayAttempts(id)).toMatchObject({ attempts: 3, maxExceeded: false });
    expect(store.incrementReplayAttempts(id)).toMatchObject({ attempts: 4, maxExceeded: false });
    expect(store.incrementReplayAttempts(id)).toMatchObject({ attempts: 5, maxExceeded: true });

    expect(store.incrementReplayAttempts('missing')).toEqual({ success: false, attempts: 0, maxExceeded: false });
  });

  it('marks an entry replayed and moves it out of pending', () => {
    const id = store.addEntry({
      contractId: 'c-1', eventId: 'e1', sequence: 1, schemaVersion: 2,
      eventType: 'MILESTONE_RELEASED', payload: makeEvent(), reason: 'r',
    });

    expect(store.markReplayed(id)).toBe(true);
    // Marking again keeps the entry replayed (never flips it back to pending).
    store.markReplayed(id);
    expect(store.getStats()).toEqual({ total: 1, pending: 0, replayed: 1 });
  });

  it('evicts the oldest pending entry when at capacity', () => {
    const capped = new EventQuarantineStorage(':memory:', { maxCapacity: 2 });
    try {
      const first = capped.addEntry({ contractId: 'c-1', eventId: 'e1', sequence: 1, schemaVersion: 2, eventType: 'MILESTONE_RELEASED', payload: makeEvent(), reason: 'r' });
      capped.addEntry({ contractId: 'c-2', eventId: 'e2', sequence: 1, schemaVersion: 2, eventType: 'MILESTONE_RELEASED', payload: makeEvent({ contractId: 'c-2', eventId: 'e2' }), reason: 'r' });
      capped.addEntry({ contractId: 'c-3', eventId: 'e3', sequence: 1, schemaVersion: 2, eventType: 'MILESTONE_RELEASED', payload: makeEvent({ contractId: 'c-3', eventId: 'e3' }), reason: 'r' });

      expect(capped.getEntry(first)).toBeNull(); // oldest evicted
      expect(capped.getStats()).toEqual({ total: 2, pending: 2, replayed: 0 });
    } finally {
      capped.close();
    }
  });

  it('getPayload returns null for a missing id', () => {
    expect(store.getPayload('missing')).toBeNull();
  });
});
