/**
 * @file ordering.test.ts
 * @description Unit tests for the per-contract ordering gate
 * (`src/events/ordering.ts`). Covers the edge cases from issue #1205:
 * in-order events, out-of-order events, missing sequence (hold timeout),
 * duplicate sequence, and two contracts processed concurrently.
 */

import {
  PerContractEventOrdering,
  EventOrderingConfig,
  SystemClock,
} from './ordering';
import { ContractEvent } from './types';

function makeEvent(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    contractId: 'contract-1',
    eventId: 'event-1',
    sequence: 1,
    timestamp: new Date().toISOString(),
    type: 'MILESTONE_RELEASED',
    payload: { milestoneId: 'm-1', amount: 100 },
    network: 'soroban',
    ledger: 100,
    ...overrides,
  };
}

/** Mutable fake clock for deterministic timeout tests. */
function makeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
    },
  };
}

function createGate(overrides: Partial<EventOrderingConfig> = {}) {
  return new PerContractEventOrdering(overrides);
}

describe('PerContractEventOrdering', () => {
  it('applies in-order events immediately (in-order events)', () => {
    const gate = createGate();
    expect(gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-1', 1);
    expect(gate.submit(makeEvent({ sequence: 2, eventId: 'e2' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-1', 2);
    expect(gate.lastApplied('contract-1')).toBe(2);
  });

  it('holds an out-of-order event until its predecessor arrives (out-of-order event)', () => {
    const gate = createGate();
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);

    // Sequence 3 arrives before sequence 2 — held.
    expect(gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }))).toEqual({ status: 'held' });
    expect(gate.getSnapshot().totalPending).toBe(1);

    // Sequence 2 arrives — applied, and 3 drains right behind it.
    expect(gate.submit(makeEvent({ sequence: 2, eventId: 'e2' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-1', 2);

    const drained = gate.drain('contract-1');
    expect(drained.map((h) => h.event.eventId)).toEqual(['e3']);
    expect(gate.lastApplied('contract-1')).toBe(3);
    expect(gate.getSnapshot().totalPending).toBe(0);
  });

  it('expires a held event whose predecessor never arrives (missing sequence)', () => {
    const clock = makeClock();
    const gate = createGate({ holdTimeoutMs: 5_000, clock });
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);

    gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }));
    expect(gate.getSnapshot().totalPending).toBe(1);

    clock.advance(4_999);
    expect(gate.expireHeld()).toHaveLength(0);

    clock.advance(2); // past 5s hold
    const expired = gate.expireHeld();
    expect(expired).toHaveLength(1);
    expect(expired[0]!.eventId).toBe('e3');
    expect(gate.getSnapshot().totalPending).toBe(0);

    const rejection = gate.getSnapshot().rejections[0]!;
    expect(rejection.code).toBe('ordering_gap_timeout');
  });

  it('treats a sequence behind the high-water mark as duplicate (duplicate sequence)', () => {
    const gate = createGate();
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);
    gate.submit(makeEvent({ sequence: 2, eventId: 'e2' }));
    gate.advanceTo('contract-1', 2);

    expect(gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }))).toEqual({ status: 'duplicate' });
    expect(gate.submit(makeEvent({ sequence: 2, eventId: 'e2' }))).toEqual({ status: 'duplicate' });
  });

  it('treats a re-submitted held event as duplicate while it is still buffered', () => {
    const gate = createGate();
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);

    expect(gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }))).toEqual({ status: 'held' });
    expect(gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }))).toEqual({ status: 'duplicate' });
  });

  it('keeps two contracts fully isolated (two contracts process concurrently)', () => {
    const gate = createGate();
    const a = makeEvent({ contractId: 'contract-a', sequence: 1, eventId: 'a1' });
    const b = makeEvent({ contractId: 'contract-b', sequence: 1, eventId: 'b1' });

    expect(gate.submit(a)).toEqual({ status: 'apply' });
    expect(gate.submit(b)).toEqual({ status: 'apply' });
    gate.advanceTo('contract-a', 1);
    gate.advanceTo('contract-b', 1);

    // B is ahead on contract-b (held) while contract-a stays in order.
    expect(gate.submit(makeEvent({ contractId: 'contract-b', sequence: 3, eventId: 'b3' }))).toEqual({ status: 'held' });
    expect(gate.submit(makeEvent({ contractId: 'contract-a', sequence: 2, eventId: 'a2' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-a', 2);

    expect(gate.lastApplied('contract-a')).toBe(2);
    expect(gate.lastApplied('contract-b')).toBe(1);
    expect(gate.getSnapshot().pending['contract-b']).toBe(1);

    // Filling contract-b's gap drains only contract-b.
    expect(gate.submit(makeEvent({ contractId: 'contract-b', sequence: 2, eventId: 'b2' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-b', 2);
    const drainedB = gate.drain('contract-b');
    expect(drainedB.map((h) => h.event.eventId)).toEqual(['b3']);
    expect(gate.getSnapshot().pending['contract-b']).toBeUndefined();
  });

  it('rejects an impossible sequence jump beyond the per-contract bound (gap too large)', () => {
    const gate = createGate({ maxPendingPerContract: 3 });
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);

    // expected next is 2; 2 + 3 = 5 is the last holdable sequence; 6 is impossible.
    const decision = gate.submit(makeEvent({ sequence: 6, eventId: 'e6' }));
    expect(decision).toMatchObject({ status: 'rejected', code: 'ordering_gap_too_large' });
    expect(gate.getSnapshot().rejections[0]!.code).toBe('ordering_gap_too_large');
    expect(gate.getSnapshot().totalPending).toBe(0);
  });

  it('rejects when the aggregate held buffer is full (buffer full)', () => {
    const gate = createGate({ maxTotalPending: 2, maxPendingPerContract: 10 });
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);

    expect(gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }))).toEqual({ status: 'held' });
    expect(gate.submit(makeEvent({ sequence: 4, eventId: 'e4' }))).toEqual({ status: 'held' });

    const decision = gate.submit(makeEvent({ sequence: 5, eventId: 'e5' }));
    expect(decision).toMatchObject({ status: 'rejected', code: 'ordering_buffer_full' });
  });

  it('anchors on the first event of an unanchored stream', () => {
    const gate = createGate();
    // First event is sequence 41 (e.g. an RPC page that starts mid-stream).
    expect(gate.submit(makeEvent({ sequence: 41, eventId: 'e41' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-1', 41);
    expect(gate.expectedNext('contract-1')).toBe(42);
    // Events behind the anchor are treated as duplicates (cannot be applied
    // after later events without corrupting the projection).
    expect(gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }))).toEqual({ status: 'duplicate' });
  });

  it('supports explicit anchoring via setExpectedNext (restart seeding)', () => {
    const gate = createGate();
    gate.setExpectedNext('contract-1', 10);
    expect(gate.submit(makeEvent({ sequence: 10, eventId: 'e10' }))).toEqual({ status: 'apply' });
    gate.advanceTo('contract-1', 10);
    expect(gate.lastApplied('contract-1')).toBe(10);
  });

  it('peek/pop/drain respect the contiguous run', () => {
    const gate = createGate();
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);
    gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }));
    gate.submit(makeEvent({ sequence: 4, eventId: 'e4' }));

    // Sequence 2 never arrived: nothing drains yet.
    expect(gate.drain('contract-1')).toHaveLength(0);

    gate.submit(makeEvent({ sequence: 2, eventId: 'e2' }));
    gate.advanceTo('contract-1', 2);

    const drained = gate.drain('contract-1');
    expect(drained.map((h) => h.event.eventId)).toEqual(['e3', 'e4']);
    expect(gate.lastApplied('contract-1')).toBe(4);
  });

  it('clear() resets all state', () => {
    const gate = createGate();
    gate.submit(makeEvent({ sequence: 1, eventId: 'e1' }));
    gate.advanceTo('contract-1', 1);
    gate.submit(makeEvent({ sequence: 3, eventId: 'e3' }));
    gate.clear();
    const snapshot = gate.getSnapshot();
    expect(snapshot.totalPending).toBe(0);
    expect(snapshot.highWater).toEqual({});
    expect(snapshot.rejections).toEqual([]);
  });

  it('defaults to SystemClock when no clock is provided', () => {
    const gate = createGate();
    expect(gate['clock']).toBe(SystemClock);
  });
});
