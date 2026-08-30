/**
 * @module events/backpressure
 * @description Event-ingestion backpressure monitor.
 *
 * RPC or queue pressure can cause silent lag: events pile up, the oldest
 * unprocessed event ages, and operators discover data loss too late. This
 * module makes that pressure visible *before* the queue is lost by:
 *
 *  1. **Bounded admission control** — only `maxPendingEvents` events may be
 *     in flight at once. When the buffer is full, new events are rejected
 *     with an explicit `ingestion_backpressure` outcome (429 at the API)
 *     instead of being buffered without limit. Rejection is visible in
 *     metrics and logs — never silent.
 *  2. **Actionable health signals** — queue depth, oldest event age,
 *     rejected work, and processing latency are tracked and exposed via
 *     {@link EventIngestionBackpressure.getHealth} and Prometheus metrics.
 *
 * State is per-instance (in-memory): a worker restart starts clean rather
 * than inheriting phantom backpressure, and the health endpoint reflects
 * the current instance immediately.
 *
 * Metrics (registered via {@link initializeEventIngestionBackpressureMetrics};
 * recorders are no-ops until then, so the module works without a registry):
 *  - `event_ingestion_queue_depth` — gauge, current in-flight count.
 *  - `event_ingestion_oldest_event_age_ms` — gauge, age of oldest in-flight.
 *  - `event_ingestion_rejected_total` — counter, rejected admissions by reason.
 *  - `event_ingestion_processing_latency_ms` — histogram, apply latency.
 */

import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { ContractEvent } from './types';

export interface BackpressureConfig {
  /** Max events admitted and in flight at once. */
  maxPendingEvents: number;
  /** Injectable clock for deterministic tests. */
  clock?: Clock;
}

export interface Clock {
  now(): number;
}

export const SystemClock: Clock = {
  now: () => Date.now(),
};

export const DEFAULT_MAX_PENDING_EVENTS = 100;

export interface AdmitResult {
  admitted: boolean;
  reason?: 'ingestion_backpressure';
  queueDepth: number;
  maxPendingEvents: number;
}

export interface AdmissionToken {
  event: ContractEvent;
  admittedAt: number;
}

export interface BackpressureHealth {
  healthy: boolean;
  /** `open` = admitting; `closed` = rejecting new events (backpressure). */
  admission: 'open' | 'closed';
  queueDepth: number;
  maxPendingEvents: number;
  oldestEventAgeMs: number;
  rejectedTotal: number;
  /** Most recent rejections (newest first, bounded to 20). */
  recentRejections: Array<{ contractId: string; eventId: string; reason: string; rejectedAt: number }>;
  /** Aggregate processing latency histogram, if any samples exist. */
  latencyMs?: { count: number; sum: number; p95: number };
}

export const EVENT_INGESTION_BACKPRESSURE_METRIC_NAMES: readonly string[] = [
  'event_ingestion_queue_depth',
  'event_ingestion_oldest_event_age_ms',
  'event_ingestion_rejected_total',
  'event_ingestion_processing_latency_ms',
] as const;

let queueDepth: Gauge<string> | null = null;
let oldestEventAge: Gauge<string> | null = null;
let rejectedTotal: Counter<string> | null = null;
let processingLatency: Histogram<string> | null = null;

/**
 * Register the backpressure metrics on a registry. Idempotent; call
 * {@link resetEventIngestionBackpressureMetrics} between tests.
 */
export function initializeEventIngestionBackpressureMetrics(registry: Registry): void {
  if (queueDepth !== null) {
    return;
  }

  queueDepth = new Gauge({
    name: 'event_ingestion_queue_depth',
    help: 'Current number of events in flight in the ingestion admission buffer.',
    registers: [registry],
  });

  oldestEventAge = new Gauge({
    name: 'event_ingestion_oldest_event_age_ms',
    help: 'Age in ms of the oldest in-flight event in the ingestion admission buffer.',
    registers: [registry],
  });

  rejectedTotal = new Counter({
    name: 'event_ingestion_rejected_total',
    help: 'Total number of events rejected by ingestion admission control.',
    labelNames: ['reason'] as const,
    registers: [registry],
  });

  processingLatency = new Histogram({
    name: 'event_ingestion_processing_latency_ms',
    help: 'Latency in ms of admitted event processing.',
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [registry],
  });
}

/** Drop registered backpressure metrics (test isolation). */
export function resetEventIngestionBackpressureMetrics(): void {
  queueDepth = null;
  oldestEventAge = null;
  rejectedTotal = null;
  processingLatency = null;
}

/**
 * Bounded admission gate + health monitor for the event-ingestion pipeline.
 *
 * Usage:
 * ```
 * const admit = backpressure.tryAdmit(event);
 * if (!admit.admitted) { /* 429 *\/ }
 * try { ...process... } finally { backpressure.complete(admit.token, 'accepted'); }
 * ```
 */
export class EventIngestionBackpressure {
  private readonly config: Required<BackpressureConfig>;
  private readonly clock: Clock;
  /** FIFO of admitted-but-incomplete events. */
  private readonly inFlight: AdmissionToken[] = [];
  private rejectedCount = 0;
  private readonly recentRejections: BackpressureHealth['recentRejections'] = [];
  private static readonly MAX_RECENT_REJECTIONS = 20;
  private readonly latencySamples: number[] = [];
  private static readonly MAX_LATENCY_SAMPLES = 10_000;

  constructor(config: Partial<BackpressureConfig> = {}) {
    this.config = {
      maxPendingEvents: config.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS,
      clock: config.clock ?? SystemClock,
    };
    this.clock = this.config.clock;
    if (!Number.isFinite(this.config.maxPendingEvents) || this.config.maxPendingEvents < 1) {
      throw new Error('maxPendingEvents must be a positive integer');
    }
  }

  /**
   * Attempt to admit an event into the ingestion pipeline. When the buffer
   * is full the event is rejected — visibly (counter + recent-rejections +
   * structured reason), never silently dropped.
   */
  public tryAdmit(event: ContractEvent): AdmitResult & { token?: AdmissionToken } {
    if (this.inFlight.length >= this.config.maxPendingEvents) {
      this.recordRejection(event, 'ingestion_backpressure');
      return {
        admitted: false,
        reason: 'ingestion_backpressure',
        queueDepth: this.inFlight.length,
        maxPendingEvents: this.config.maxPendingEvents,
      };
    }

    const token: AdmissionToken = { event, admittedAt: this.clock.now() };
    this.inFlight.push(token);
    this.updateGauges();
    return {
      admitted: true,
      queueDepth: this.inFlight.length,
      maxPendingEvents: this.config.maxPendingEvents,
      token,
    };
  }

  /** Record an event that was rejected outside the admission gate (e.g. malformed). */
  public recordRejected(event: ContractEvent, reason: string): void {
    this.recordRejection(event, reason);
  }

  /**
   * Mark an admitted event as finished, freeing its slot and recording
   * processing latency. Safe to call with any outcome.
   */
  public complete(token: AdmissionToken, outcome: string): void {
    const index = this.inFlight.findIndex((t) => t === token);
    if (index === -1) {
      return; // already completed (e.g. double finalize) — idempotent
    }
    this.inFlight.splice(index, 1);

    const latency = this.clock.now() - token.admittedAt;
    this.latencySamples.push(latency);
    if (this.latencySamples.length > EventIngestionBackpressure.MAX_LATENCY_SAMPLES) {
      this.latencySamples.shift();
    }
    processingLatency?.observe(latency);
    this.updateGauges();
  }

  /** Current health snapshot for operators (health endpoint, alerts). */
  public getHealth(now: number = this.clock.now()): BackpressureHealth {
    const queueDepthCount = this.inFlight.length;
    const oldest = queueDepthCount > 0 ? this.inFlight[0]!.admittedAt : now;
    const latency = this.latencyStats();

    return {
      healthy: queueDepthCount < this.config.maxPendingEvents,
      admission: queueDepthCount < this.config.maxPendingEvents ? 'open' : 'closed',
      queueDepth: queueDepthCount,
      maxPendingEvents: this.config.maxPendingEvents,
      oldestEventAgeMs: queueDepthCount > 0 ? Math.max(0, now - oldest) : 0,
      rejectedTotal: this.rejectedCount,
      recentRejections: [...this.recentRejections],
      ...(latency && { latencyMs: latency }),
    };
  }

  /** Test helper: reset all state (fresh instance semantics). */
  public clear(): void {
    this.inFlight.length = 0;
    this.rejectedCount = 0;
    this.recentRejections.length = 0;
    this.latencySamples.length = 0;
    this.updateGauges();
  }

  private latencyStats(): { count: number; sum: number; p95: number } | undefined {
    if (this.latencySamples.length === 0) {
      return undefined;
    }
    const sorted = [...this.latencySamples].sort((a, b) => a - b);
    const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return {
      count: sorted.length,
      sum: sorted.reduce((acc, v) => acc + v, 0),
      p95: sorted[p95Index]!,
    };
  }

  private recordRejection(event: ContractEvent, reason: string): void {
    this.rejectedCount += 1;
    rejectedTotal?.inc({ reason });
    this.recentRejections.unshift({
      contractId: event.contractId,
      eventId: event.eventId,
      reason,
      rejectedAt: this.clock.now(),
    });
    if (this.recentRejections.length > EventIngestionBackpressure.MAX_RECENT_REJECTIONS) {
      this.recentRejections.length = EventIngestionBackpressure.MAX_RECENT_REJECTIONS;
    }
  }

  private updateGauges(): void {
    if (queueDepth === null || oldestEventAge === null) {
      return;
    }
    queueDepth.set(this.inFlight.length);
    oldestEventAge.set(
      this.inFlight.length > 0 ? this.clock.now() - this.inFlight[0]!.admittedAt : 0,
    );
  }
}
