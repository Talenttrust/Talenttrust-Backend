/**
 * @module events/ordering
 * @description Per-contract ordering gate for contract event ingestion.
 *
 * Events from the same contract carry a per-contract `sequence` (ledger
 * order). When RPC pages are fetched in parallel or queue workers complete
 * out of order, the ingestion funnel can observe an event before its
 * predecessors. Applying out of order corrupts projections that assume a
 * strict event history (e.g. milestone releases must follow funding).
 *
 * This gate partitions processing by contract:
 *  - events that arrive in order are applied immediately;
 *  - events that arrive ahead of a gap are **held** in a bounded buffer
 *    until the missing predecessor arrives (or a bounded timeout expires);
 *  - events behind the applied high-water mark are duplicates;
 *  - impossible jumps (a gap larger than the bounded buffer could ever
 *    fill) and buffer overflow are rejected with a structured code instead
 *    of being silently buffered or dropped.
 *
 * Boundedness:
 *  - `maxPendingPerContract` caps how far ahead of the high-water mark one
 *    contract may run (a larger gap is rejected as impossible).
 *  - `maxTotalPending` caps the aggregate buffer across all contracts so a
 *    pathological backlog of many gapped streams cannot exhaust memory.
 *  - `holdTimeoutMs` bounds how long a held event waits for its
 *    predecessor; expired events are surfaced via {@link expireHeld} so the
 *    caller can record/quarantine them (they are never silently dropped).
 *
 * The gate is intentionally in-memory and single-process: it orders work
 * *within* one ingestion instance. Cross-instance ordering is the queue's
 * job (each instance applies the same per-contract rules). `getSnapshot()`
 * exposes the high-water marks, pending counts, and recent rejections for
 * observability.
 */

import { ContractEvent } from './types';

export interface Clock {
  now(): number;
}

export const SystemClock: Clock = {
  now: () => Date.now(),
};

export interface EventOrderingConfig {
  /** How long (ms) a held event waits for its predecessor before expiring. */
  holdTimeoutMs: number;
  /** Max events a single contract may hold ahead of its high-water mark. */
  maxPendingPerContract: number;
  /** Max held events across all contracts combined. */
  maxTotalPending: number;
  /** Injectable clock for deterministic tests. */
  clock?: Clock;
}

export const DEFAULT_ORDERING_CONFIG: Omit<EventOrderingConfig, 'clock'> = {
  holdTimeoutMs: 30_000,
  maxPendingPerContract: 100,
  maxTotalPending: 1_000,
};

export type OrderingDecision =
  | { status: 'apply' }
  | { status: 'held' }
  | { status: 'duplicate' }
  | { status: 'rejected'; code: string; reason: string; statusCode: number };

/** A held event awaiting its predecessor. */
export interface HeldEvent {
  event: ContractEvent;
  heldAt: number;
}

/** An event that expired while held (its predecessor never arrived). */
export interface ExpiredEvent {
  contractId: string;
  eventId: string;
  sequence: number;
  heldAt: number;
  expiredAt: number;
}

/** A rejection recorded when an event cannot be held. */
export interface OrderingRejection {
  contractId: string;
  eventId: string;
  sequence: number;
  code: string;
  reason: string;
  rejectedAt: number;
}

export interface OrderingSnapshot {
  /** High-water mark per contract (last applied sequence; -1 when unanchored). */
  highWater: Record<string, number>;
  /** Pending (held) count per contract. */
  pending: Record<string, number>;
  totalPending: number;
  maxTotalPending: number;
  maxPendingPerContract: number;
  /** Most recent rejections (newest first, bounded to 100). */
  rejections: OrderingRejection[];
}

/** Sentinel used before a contract's stream is anchored. */
const UNANCHORED = -1;

/**
 * Per-contract ordering gate. See module docs for semantics.
 *
 * Thread-safety: all state transitions are synchronous, so concurrent
 * callers in the same process observe consistent decisions as long as each
 * event is submitted, applied, and advanced on the same gate instance.
 */
export class PerContractEventOrdering {
  private readonly config: Required<EventOrderingConfig>;
  private readonly clock: Clock;
  /** Last applied sequence per contract; UNANCHORED until the first event. */
  private readonly highWater = new Map<string, number>();
  /** Held events per contract, keyed by sequence. */
  private readonly pending = new Map<string, Map<number, HeldEvent>>();
  private totalPending = 0;
  private readonly rejections: OrderingRejection[] = [];
  private static readonly MAX_REJECTIONS = 100;

  constructor(config: Partial<EventOrderingConfig> = {}) {
    this.config = { ...DEFAULT_ORDERING_CONFIG, ...config };
    this.clock = this.config.clock ?? SystemClock;
  }

  /** Expected next sequence for a contract, or `null` when unanchored. */
  public expectedNext(contractId: string): number | null {
    const mark = this.highWater.get(contractId);
    return mark === undefined || mark === UNANCHORED ? null : mark + 1;
  }

  /** Last applied sequence for a contract, or `null` when unanchored. */
  public lastApplied(contractId: string): number | null {
    const mark = this.highWater.get(contractId);
    return mark === undefined || mark === UNANCHORED ? null : mark;
  }

  /**
   * Explicitly anchor a contract's stream. Useful for tests and for
   * seeding the high-water mark from persisted state after a restart.
   */
  public setExpectedNext(contractId: string, sequence: number): void {
    this.highWater.set(contractId, sequence - 1);
  }

  /**
   * Decide what to do with an incoming event and, when the decision is
   * `held`, place it in the bounded buffer. This is the only entry point
   * that mutates gate state other than {@link advanceTo}/{@link expireHeld}.
   */
  public submit(event: ContractEvent): OrderingDecision {
    const contractId = event.contractId;
    const expected = this.expectedNext(contractId);

    if (expected === null) {
      // Unanchored stream: the first event anchors the sequence. A contract
      // that legitimately starts mid-stream (e.g. an RPC page that begins at
      // sequence 41) is applied immediately; ordering applies from here on.
      return { status: 'apply' };
    }

    if (event.sequence < expected) {
      return { status: 'duplicate' };
    }

    if (event.sequence === expected) {
      return { status: 'apply' };
    }

    // event.sequence > expected — a gap. Check bounds before holding.
    const gap = event.sequence - expected;
    if (gap > this.config.maxPendingPerContract) {
      this.recordRejection(contractId, event, 'ordering_gap_too_large',
        `Sequence ${event.sequence} is ${gap} ahead of expected ${expected}; ` +
        `gap exceeds the per-contract hold bound of ${this.config.maxPendingPerContract}`);
      return {
        status: 'rejected',
        code: 'ordering_gap_too_large',
        reason: `Sequence gap of ${gap} exceeds the per-contract hold bound`,
        statusCode: 400,
      };
    }

    const contractPending = this.pending.get(contractId);
    if (contractPending?.has(event.sequence)) {
      return { status: 'duplicate' };
    }

    if (this.totalPending >= this.config.maxTotalPending) {
      this.recordRejection(contractId, event, 'ordering_buffer_full',
        'Aggregate held-event buffer is at capacity');
      return {
        status: 'rejected',
        code: 'ordering_buffer_full',
        reason: 'Held-event buffer is full; retry after the gap resolves',
        statusCode: 503,
      };
    }

    // Hold the event until its predecessor arrives.
    if (!contractPending) {
      this.pending.set(contractId, new Map());
    }
    this.pending.get(contractId)!.set(event.sequence, { event, heldAt: this.clock.now() });
    this.totalPending += 1;
    return { status: 'held' };
  }

  /** The next held event for a contract, or `null`. */
  public peekNext(contractId: string): HeldEvent | null {
    const expected = this.expectedNext(contractId);
    if (expected === null) return null;
    return this.pending.get(contractId)?.get(expected) ?? null;
  }

  /** Remove and return the next held event for a contract, or `null`. */
  public popNext(contractId: string): HeldEvent | null {
    const expected = this.expectedNext(contractId);
    if (expected === null) return null;
    const contractPending = this.pending.get(contractId);
    const held = contractPending?.get(expected);
    if (!held) return null;
    contractPending!.delete(expected);
    if (contractPending!.size === 0) {
      this.pending.delete(contractId);
    }
    this.totalPending = Math.max(0, this.totalPending - 1);
    return held;
  }

  /**
   * Record that an event with the given sequence was applied, advancing the
   * contract's high-water mark. Call AFTER persisting the event so a crash
   * between apply and advance only re-applies a duplicate (safe).
   */
  public advanceTo(contractId: string, sequence: number): void {
    const current = this.highWater.get(contractId) ?? UNANCHORED;
    if (sequence > current) {
      this.highWater.set(contractId, sequence);
    }
  }

  /**
   * Drain the contiguous run of held events whose predecessors have now
   * been applied. Returns them in ledger order; the caller applies each and
   * calls {@link advanceTo} afterwards (or calls drain again, which resumes
   * from the new high-water mark).
   */
  public drain(contractId: string): HeldEvent[] {
    const drained: HeldEvent[] = [];
    let next = this.peekNext(contractId);
    while (next) {
      drained.push(this.popNext(contractId)!);
      this.advanceTo(contractId, next.event.sequence);
      next = this.peekNext(contractId);
    }
    return drained;
  }

  /**
   * Expire held events whose wait exceeds `holdTimeoutMs`. Returns the
   * expired events and records a rejection for each so the outcome is
   * observable (never silently dropped).
   */
  public expireHeld(now: number = this.clock.now()): ExpiredEvent[] {
    const expired: ExpiredEvent[] = [];
    for (const [contractId, contractPending] of Array.from(this.pending.entries())) {
      for (const [sequence, held] of Array.from(contractPending.entries())) {
        if (now - held.heldAt >= this.config.holdTimeoutMs) {
          contractPending.delete(sequence);
          this.totalPending = Math.max(0, this.totalPending - 1);
          expired.push({
            contractId,
            eventId: held.event.eventId,
            sequence,
            heldAt: held.heldAt,
            expiredAt: now,
          });
          this.recordRejection(contractId, held.event, 'ordering_gap_timeout',
            `Held for ${this.config.holdTimeoutMs}ms waiting for sequence ${sequence - 1}; predecessor never arrived`);
        }
      }
      if (contractPending.size === 0) {
        this.pending.delete(contractId);
      }
    }
    return expired;
  }

  /** Snapshot for observability (health endpoints, tests). */
  public getSnapshot(): OrderingSnapshot {
    const highWater: Record<string, number> = {};
    for (const [contractId, mark] of this.highWater.entries()) {
      highWater[contractId] = mark;
    }
    const pending: Record<string, number> = {};
    for (const [contractId, contractPending] of this.pending.entries()) {
      pending[contractId] = contractPending.size;
    }
    return {
      highWater,
      pending,
      totalPending: this.totalPending,
      maxTotalPending: this.config.maxTotalPending,
      maxPendingPerContract: this.config.maxPendingPerContract,
      rejections: [...this.rejections],
    };
  }

  /** Test/management helper: reset all gate state. */
  public clear(): void {
    this.highWater.clear();
    this.pending.clear();
    this.totalPending = 0;
    this.rejections.length = 0;
  }

  private recordRejection(
    contractId: string,
    event: ContractEvent,
    code: string,
    reason: string,
  ): void {
    this.rejections.unshift({
      contractId,
      eventId: event.eventId,
      sequence: event.sequence,
      code,
      reason,
      rejectedAt: this.clock.now(),
    });
    if (this.rejections.length > PerContractEventOrdering.MAX_REJECTIONS) {
      this.rejections.length = PerContractEventOrdering.MAX_REJECTIONS;
    }
  }
}
