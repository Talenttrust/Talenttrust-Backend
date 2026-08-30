/**
 * @module events/rawEventRetention
 * @description Retention boundaries for raw blockchain event payloads
 *              (issue #1232).
 *
 * Raw event payloads (`smart_contract_events.payload`) are the unbounded
 * part of the event pipeline: the normalized projections (audit records,
 * contract/milestone state) are derived and small, but the raw JSON is kept
 * verbatim. Without a boundary the table grows forever — storage cost, backup
 * cost, and a growing attack surface of retained sensitive data.
 *
 * This module defines the boundary explicitly:
 *
 *  - **Retention classes** — a per-network period (`soroban` / `stellar` /
 *    `offchain`), each with a sensitivity classification. The retention
 *    boundary for an event is `ingestedAt + class.periodDays`.
 *  - **Legal holds** — scoped holds (`contract` / `network` / `all`) with an
 *    optional expiry that *freeze* matching payloads; held events are never
 *    archived or purged.
 *  - **Projection verification** — an event may only be archived/purged once
 *    its normalized projection is verified (fail-closed: unverifiable events
 *    are deferred, never destroyed).
 *  - **Archive then purge** — archival (compliance copy) and purge happen
 *    atomically per event; a run only *records* counts and failures, and
 *    never retains raw payload content in logs or audit entries.
 *  - **Bounded** — one run processes at most `maxPerRun` events (default 500,
 *    cap 1000), paginating through candidates in ingestion order.
 *
 * Out of scope (per the issue): purging canonical projections — this module
 * only ever touches the *raw* event table and its own archive/holds tables.
 *
 * ## Security notes
 * - Raw payloads are treated as sensitive: they are written only to the
 *   archive table; logs, audit entries and summaries carry ids, counts,
 *   network/class and hashes — never payload contents.
 * - Verification is fail-closed: any error or missing projection defers the
 *   event. Data is destroyed only after a successful archive in the same
 *   transaction.
 */

import { z } from 'zod';
import { createLogger } from '../logger';
import { DataClassification } from '../retention/types';
import { auditService } from '../audit/service';
import {
  DEFAULT_RAW_EVENT_NETWORK,
  hashPayload,
  type ArchiveOutcome,
  type RawEventHold,
  type RawEventRecord,
  type RawEventRetentionRepository,
} from './rawEventRetention.repository';

/** Networks with a retention class. */
export type RawEventNetwork = 'soroban' | 'stellar' | 'offchain';

export const RAW_EVENT_NETWORKS: readonly RawEventNetwork[] = [
  'soroban',
  'stellar',
  'offchain',
];

/** Retention class for one network. */
export interface RawEventRetentionClass {
  network: RawEventNetwork;
  /** Days the raw payload is retained before it becomes a candidate. */
  periodDays: number;
  classification: DataClassification;
}

/** Environment-derived configuration (validated via zod). */
export interface RawEventRetentionConfig {
  enabled: boolean;
  classes: Record<RawEventNetwork, RawEventRetentionClass>;
  /** Candidate page size while walking the table. */
  batchSize: number;
  /** Hard cap on events processed per run. */
  maxPerRun: number;
  /**
   * Days a raw row is kept after archival before it is purged. `0` purges
   * immediately after a successful archive (default).
   */
  postArchiveDays: number;
}

export interface ProjectionVerification {
  verified: boolean;
  /** Machine-readable reason when not verified. */
  reason?: string;
}

/** Verifies that an event's normalized projection exists and is settled. */
export interface RawEventProjectionVerifier {
  verify(event: RawEventRecord): Promise<ProjectionVerification>;
}

/** Minimal audit sink — defaults to the shared audit service. */
export interface RawEventRetentionAuditEntry {
  action: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  resource: string;
  resourceId: string;
  metadata: Record<string, unknown>;
  correlationId?: string;
}

export type RawEventRetentionAuditSink = (
  entry: RawEventRetentionAuditEntry,
) => void;

/** Input for a single retention run. */
export interface RunRawEventRetentionInput {
  now?: Date;
  /** Bounded override for this run (still capped by config). */
  maxEvents?: number;
  /** Scope the run to one network (used by the mixed-networks boundary). */
  network?: RawEventNetwork;
  /** When true, count candidates without archiving/purging anything. */
  dryRun?: boolean;
  correlationId?: string;
  requestId?: string;
}

/** Per-network counters in the run summary. */
export interface RawEventNetworkCounters {
  scanned: number;
  archived: number;
  purged: number;
  held: number;
  deferred: number;
  alreadyArchived: number;
  failed: number;
}

/** Structured result of one retention run. */
export interface RawEventRetentionSummary {
  enabled: boolean;
  dryRun: boolean;
  scanned: number;
  archived: number;
  purged: number;
  held: number;
  deferred: number;
  alreadyArchived: number;
  failed: number;
  byNetwork: Partial<Record<RawEventNetwork, RawEventNetworkCounters>>;
}

/** Defaults + env parsing (mirrors queue/config.ts conventions). */
export const DEFAULT_RAW_EVENT_RETENTION_CONFIG: RawEventRetentionConfig = {
  enabled: false,
  classes: {
    soroban: { network: 'soroban', periodDays: 30, classification: DataClassification.CONFIDENTIAL },
    stellar: { network: 'stellar', periodDays: 90, classification: DataClassification.CONFIDENTIAL },
    offchain: { network: 'offchain', periodDays: 180, classification: DataClassification.INTERNAL },
  },
  batchSize: 100,
  maxPerRun: 500,
  postArchiveDays: 0,
};

export const RAW_EVENT_RETENTION_ENV = {
  ENABLED: 'RAW_EVENT_RETENTION_ENABLED',
  SOROBAN_DAYS: 'RAW_EVENT_RETENTION_SOROBAN_DAYS',
  STELLAR_DAYS: 'RAW_EVENT_RETENTION_STELLAR_DAYS',
  OFFCHAIN_DAYS: 'RAW_EVENT_RETENTION_OFFCHAIN_DAYS',
  BATCH_SIZE: 'RAW_EVENT_RETENTION_BATCH_SIZE',
  MAX_PER_RUN: 'RAW_EVENT_RETENTION_MAX_PER_RUN',
  POST_ARCHIVE_DAYS: 'RAW_EVENT_RETENTION_POST_ARCHIVE_DAYS',
} as const;

export const RAW_EVENT_RETENTION_MAX_PER_RUN = 1000;

/**
 * Per-field lenient schema: a malformed value for one variable falls back to
 * its default (via `.catch`) instead of failing the entire configuration, so
 * a typo in one env var can never silently disable the other bounds.
 */
const rawEventRetentionEnvSchema = z.object({
  RAW_EVENT_RETENTION_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === 'true')
    .catch(false),
  RAW_EVENT_RETENTION_SOROBAN_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .catch(undefined),
  RAW_EVENT_RETENTION_STELLAR_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .catch(undefined),
  RAW_EVENT_RETENTION_OFFCHAIN_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3650)
    .optional()
    .catch(undefined),
  RAW_EVENT_RETENTION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .catch(undefined),
  RAW_EVENT_RETENTION_MAX_PER_RUN: z.coerce
    .number()
    .int()
    .min(1)
    .max(RAW_EVENT_RETENTION_MAX_PER_RUN)
    .optional()
    .catch(undefined),
  RAW_EVENT_RETENTION_POST_ARCHIVE_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .max(3650)
    .optional()
    .catch(undefined),
});

/**
 * Loads the retention configuration from the environment.
 * Unknown/malformed values fall back to safe defaults rather than throwing,
 * so a typo in one env var can never disable the bounds silently.
 */
export function loadRawEventRetentionConfig(
  env: NodeJS.ProcessEnv = process.env,
): RawEventRetentionConfig {
  const parsed = rawEventRetentionEnvSchema.safeParse(env);
  const data = parsed.success ? parsed.data : {};
  const base = DEFAULT_RAW_EVENT_RETENTION_CONFIG;
  return {
    enabled: data.RAW_EVENT_RETENTION_ENABLED ?? base.enabled,
    classes: {
      soroban: {
        ...base.classes.soroban,
        periodDays:
          data.RAW_EVENT_RETENTION_SOROBAN_DAYS ?? base.classes.soroban.periodDays,
      },
      stellar: {
        ...base.classes.stellar,
        periodDays:
          data.RAW_EVENT_RETENTION_STELLAR_DAYS ?? base.classes.stellar.periodDays,
      },
      offchain: {
        ...base.classes.offchain,
        periodDays:
          data.RAW_EVENT_RETENTION_OFFCHAIN_DAYS ?? base.classes.offchain.periodDays,
      },
    },
    batchSize: data.RAW_EVENT_RETENTION_BATCH_SIZE ?? base.batchSize,
    maxPerRun: data.RAW_EVENT_RETENTION_MAX_PER_RUN ?? base.maxPerRun,
    postArchiveDays:
      data.RAW_EVENT_RETENTION_POST_ARCHIVE_DAYS ?? base.postArchiveDays,
  };
}

/**
 * Default verifier backed by the shared event audit service.
 *
 * An event is verified when its contract has at least one `accepted` audit
 * record and, for on-chain events, that the record is not provisional
 * (finality-settled). Fail-closed: any uncertainty returns `verified: false`
 * so the event is deferred, never destroyed.
 *
 * Note: the built-in audit repository is in-memory. Deployments with durable
 * audit storage should inject a verifier bound to it.
 */
export class AuditBackedProjectionVerifier implements RawEventProjectionVerifier {
  // Imported lazily to avoid constructing the registry's network-backed
  // evaluator at module load in tests that only need the verifier type.
  private readonly auditServiceInstance: {
    findByContractId(contractId: string, limit?: number): Promise<unknown[]>;
  };

  constructor(
    audit: { findByContractId(contractId: string, limit?: number): Promise<unknown[]> } = requireAuditService(),
  ) {
    this.auditServiceInstance = audit;
  }

  async verify(event: RawEventRecord): Promise<ProjectionVerification> {
    let audits: unknown[];
    try {
      audits = await this.auditServiceInstance.findByContractId(event.contractId, 200);
    } catch (error) {
      return {
        verified: false,
        reason: 'audit_unavailable',
      };
    }

    const accepted = (audits as Array<{ status?: string }>).filter(
      (a) => a.status === 'accepted',
    );
    if (accepted.length === 0) {
      return { verified: false, reason: 'no_accepted_projection' };
    }

    // On-chain events additionally require a settled (non-provisional) record.
    if (event.network !== 'offchain' || event.ledger !== undefined) {
      const settled = accepted.some(
        (a) => (a as { finalityStatus?: string }).finalityStatus !== 'provisional',
      );
      if (!settled) {
        return { verified: false, reason: 'projection_provisional' };
      }
    }

    return { verified: true };
  }
}

function requireAuditService(): {
  findByContractId(contractId: string, limit?: number): Promise<unknown[]>;
} {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventAuditService } = require('../repository/eventAuditRepository') as {
    EventAuditService: new (...args: unknown[]) => {
      findByContractId(contractId: string, limit?: number): Promise<unknown[]>;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { eventAuditService } = require('./registry') as {
    eventAuditService: InstanceType<typeof EventAuditService>;
  };
  return eventAuditService;
}

export interface RawEventRetentionServiceOptions {
  repository: RawEventRetentionRepository;
  verifier: RawEventProjectionVerifier;
  config?: RawEventRetentionConfig;
  /** Audit sink; defaults to the shared audit service. */
  auditSink?: RawEventRetentionAuditSink;
}

export class RawEventRetentionService {
  private readonly repository: RawEventRetentionRepository;
  private readonly verifier: RawEventProjectionVerifier;
  private readonly config: RawEventRetentionConfig;
  private readonly auditSink: RawEventRetentionAuditSink;

  constructor(options: RawEventRetentionServiceOptions) {
    this.repository = options.repository;
    this.verifier = options.verifier;
    this.config = options.config ?? DEFAULT_RAW_EVENT_RETENTION_CONFIG;
    this.auditSink = options.auditSink ?? defaultAuditSink;
  }

  /**
   * Runs one bounded retention pass.
   *
   * @returns A structured summary. When retention is disabled, the summary
   *          reports `enabled: false` and nothing is touched.
   */
  async run(input: RunRawEventRetentionInput = {}): Promise<RawEventRetentionSummary> {
    const log = createLogger({
      processor: 'raw-event-retention',
      ...(input.correlationId && { correlationId: input.correlationId }),
      ...(input.requestId && { requestId: input.requestId }),
    });

    const now = input.now ?? new Date();
    const nowIso = now.toISOString();
    const dryRun = input.dryRun ?? false;
    const maxPerRun = clampMaxPerRun(input.maxEvents ?? this.config.maxPerRun);

    const summary = emptySummary(this.config.enabled, dryRun);

    if (!this.config.enabled) {
      log.info('Raw event retention disabled; skipping run', { dryRun });
      return summary;
    }

    const activeHolds = this.repository.listActiveHolds(nowIso);
    const networkScope = input.network;

    log.info('Raw event retention run starting', {
      dryRun,
      maxPerRun,
      network: networkScope ?? 'all',
      activeHolds: activeHolds.length,
    });

    const cutoffByNetwork = computeCutoffs(this.config, nowIso, networkScope);
    let offset = 0;
    let processed = 0;

    while (processed < maxPerRun) {
      const pageSize = Math.min(
        this.config.batchSize,
        maxPerRun - processed,
      );
      const page = this.repository.listCandidates({
        cutoffByNetwork,
        limit: pageSize,
        offset,
      });
      if (page.length === 0) break;

      for (const event of page) {
        if (processed >= maxPerRun) break;
        processed += 1;
        await this.processEvent(event, nowIso, dryRun, activeHolds, summary, log);
      }

      // The next page continues from the last offset; when a page is short
      // the set is exhausted and the next loop iteration breaks above.
      offset += page.length;
      if (page.length < pageSize) break;
    }

    // Top-level totals are derived from the per-network counters so the
    // summary can never disagree with its own breakdown.
    finalizeSummary(summary);

    log.info('Raw event retention run completed', {
      dryRun,
      ...summarizeForLog(summary),
    });
    return summary;
  }

  private async processEvent(
    event: RawEventRecord,
    nowIso: string,
    dryRun: boolean,
    holds: RawEventHold[],
    summary: RawEventRetentionSummary,
    log: ReturnType<typeof createLogger>,
  ): Promise<void> {
    const counters = networkCounters(summary, event.network);
    counters.scanned += 1;

    try {
      if (matchesHold(event, holds)) {
        counters.held += 1;
        log.info('Raw event retained: active legal hold', {
          eventId: event.eventId,
          contractId: event.contractId,
          network: event.network,
        });
        return;
      }

      const verification = await this.verifier.verify(event);
      if (!verification.verified) {
        counters.deferred += 1;
        log.info('Raw event deferred: projection not verified', {
          eventId: event.eventId,
          contractId: event.contractId,
          network: event.network,
          reason: verification.reason ?? 'unverified',
        });
        return;
      }

      if (dryRun) {
        return;
      }

      const outcome = this.archiveEvent(event, nowIso, log);
      if (outcome.archived) {
        counters.archived += 1;
      } else {
        counters.alreadyArchived += 1;
      }
      if (outcome.purged) {
        counters.purged += 1;
      }
    } catch (error) {
      counters.failed += 1;
      // Structured, payload-free failure record.
      log.warn('Raw event retention failed for event', {
        eventId: event.eventId,
        contractId: event.contractId,
        network: event.network,
        error: sanitizeRetentionError(error),
      });
    }
  }

  private archiveEvent(
    event: RawEventRecord,
    nowIso: string,
    log: ReturnType<typeof createLogger>,
  ): ArchiveOutcome {
    const purge = this.config.postArchiveDays === 0;
    const outcome = this.repository.archiveAndPurge(event, nowIso, purge);

    this.auditSink({
      action: outcome.purged ? 'ARCHIVE_AND_PURGE' : 'ARCHIVE',
      severity: 'INFO',
      resource: 'raw-event',
      resourceId: event.eventId,
      metadata: {
        contractId: event.contractId,
        network: event.network,
        eventType: event.eventType,
        archivedAt: nowIso,
        purged: outcome.purged,
        // Hash only — never the raw payload content.
        payloadHash: hashPayload(event.payload),
      },
    });

    log.info('Raw event archived', {
      eventId: event.eventId,
      contractId: event.contractId,
      network: event.network,
      purged: outcome.purged,
      alreadyArchived: !outcome.archived,
    });
    return outcome;
  }
}

function emptySummary(enabled: boolean, dryRun: boolean): RawEventRetentionSummary {
  return {
    enabled,
    dryRun,
    scanned: 0,
    archived: 0,
    purged: 0,
    held: 0,
    deferred: 0,
    alreadyArchived: 0,
    failed: 0,
    byNetwork: {},
  };
}

/** Sums per-network counters into the summary's top-level fields. */
function finalizeSummary(summary: RawEventRetentionSummary): void {
  let scanned = 0;
  let archived = 0;
  let purged = 0;
  let held = 0;
  let deferred = 0;
  let alreadyArchived = 0;
  let failed = 0;
  for (const counters of Object.values(summary.byNetwork)) {
    scanned += counters.scanned;
    archived += counters.archived;
    purged += counters.purged;
    held += counters.held;
    deferred += counters.deferred;
    alreadyArchived += counters.alreadyArchived;
    failed += counters.failed;
  }
  summary.scanned = scanned;
  summary.archived = archived;
  summary.purged = purged;
  summary.held = held;
  summary.deferred = deferred;
  summary.alreadyArchived = alreadyArchived;
  summary.failed = failed;
}

function networkCounters(
  summary: RawEventRetentionSummary,
  network: RawEventNetwork,
): RawEventNetworkCounters {
  let counters = summary.byNetwork[network];
  if (!counters) {
    counters = {
      scanned: 0,
      archived: 0,
      purged: 0,
      held: 0,
      deferred: 0,
      alreadyArchived: 0,
      failed: 0,
    };
    summary.byNetwork[network] = counters;
  }
  return counters;
}

function matchesHold(event: RawEventRecord, holds: RawEventHold[]): boolean {
  return holds.some((hold) => {
    if (hold.scopeType === 'all') return true;
    if (hold.scopeType === 'network') return hold.scopeValue === event.network;
    if (hold.scopeType === 'contract') return hold.scopeValue === event.contractId;
    return false;
  });
}

function computeCutoffs(
  config: RawEventRetentionConfig,
  nowIso: string,
  networkScope?: RawEventNetwork,
): Record<RawEventNetwork, string> {
  const nowMs = Date.parse(nowIso);
  const cutoffs = {} as Record<RawEventNetwork, string>;
  for (const network of RAW_EVENT_NETWORKS) {
    if (networkScope !== undefined && network !== networkScope) {
      // Scoped runs must never treat other networks as candidates.
      cutoffs[network] = new Date(0).toISOString();
      continue;
    }
    const days = config.classes[network]?.periodDays ?? 0;
    cutoffs[network] = new Date(nowMs - days * 24 * 60 * 60 * 1000).toISOString();
  }
  return cutoffs;
}

function clampMaxPerRun(value: number): number {
  if (!Number.isFinite(value) || value < 1) return DEFAULT_RAW_EVENT_RETENTION_CONFIG.maxPerRun;
  return Math.min(Math.floor(value), RAW_EVENT_RETENTION_MAX_PER_RUN);
}

/** Reduces a thrown value to a safe, payload-free error record. */
function sanitizeRetentionError(error: unknown): { name: string; message: string } {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    name: err.name,
    message: err.message.replace(/[\r\n\t]+/g, ' ').slice(0, 200),
  };
}

/** Counts + ids only — never payload contents. */
function summarizeForLog(summary: RawEventRetentionSummary): Record<string, unknown> {
  return {
    scanned: summary.scanned,
    archived: summary.archived,
    purged: summary.purged,
    held: summary.held,
    deferred: summary.deferred,
    alreadyArchived: summary.alreadyArchived,
    failed: summary.failed,
    byNetwork: summary.byNetwork,
  };
}

function defaultAuditSink(entry: RawEventRetentionAuditEntry): void {
  auditService.log({
    action: 'ADMIN_ACTION',
    severity: entry.severity,
    actor: 'system',
    resource: entry.resource,
    resourceId: entry.resourceId,
    metadata: {
      retentionAction: entry.action,
      ...entry.metadata,
    },
    ipAddress: undefined,
    correlationId: entry.correlationId,
  } as never);
}

export { DEFAULT_RAW_EVENT_NETWORK };
