/**
 * @module milestones/divergence/types
 * @description Shared types for milestone divergence detection.
 *
 * A "milestone projection" (the milestone records the backend has indexed from
 * contract events) can drift from the canonical on-chain milestone state when
 * events are missed, a reorg rewrites history, or a batch is only partially
 * processed. These types model the comparison between the two views and the
 * audit report that a bounded scan job persists.
 *
 * Security / correctness invariants relied on elsewhere in this module:
 *  - Comparison is **report-only**: nothing here can write canonical milestone
 *    state. The only persisted artifact is a {@link DivergenceReportRecord}.
 *  - Every comparison is stamped with the `blockHeight` (ledger sequence) it
 *    was observed at so operators can reason about reorg windows.
 *  - All reports carry a `tenantId`; repository queries always scope by it.
 */

/** Canonical, field-normalized view of a single milestone. */
export interface MilestoneState {
  /** Stable identifier shared by the indexed record and the on-chain value. */
  milestoneId: string;
  title: string;
  description: string;
  /** Milestone amount in stroops (integer). */
  amount: number;
  /** ISO-8601 deadline, or undefined when the milestone has none. */
  deadline?: string;
  completed: boolean;
}

/** A single field-level difference between indexed and on-chain state. */
export interface MilestoneFieldDifference {
  /** Dot-path of the field that differs (e.g. `milestones.m1.amount`). */
  field: string;
  /** Value as indexed by the backend (never exposed raw to clients). */
  indexed: unknown;
  /** Value as read from the chain at the comparison block height. */
  onChain: unknown;
}

/** Per-milestone comparison outcome. */
export type MilestoneComparisonStatus =
  | 'in_sync'
  | 'divergent'
  | 'missing_indexed'
  | 'missing_on_chain';

/** Result of comparing one milestone across the two views. */
export interface MilestoneComparison {
  milestoneId: string;
  status: MilestoneComparisonStatus;
  differences: MilestoneFieldDifference[];
}

/** Per-contract comparison outcome. */
export type ContractComparisonStatus = 'in_sync' | 'divergent' | 'unavailable';

/** Result of comparing every milestone of one contract. */
export interface ContractComparison {
  contractId: string;
  /** Tenant the scan ran for; reports are always scoped by it. */
  tenantId: string;
  status: ContractComparisonStatus;
  /** Ledger sequence the on-chain view was read at (undefined when RPC failed). */
  blockHeight?: number;
  /** ISO-8601 timestamp the comparison was produced at. */
  comparedAt: string;
  /** Per-milestone comparisons, sorted deterministically by milestoneId. */
  milestoneComparisons: MilestoneComparison[];
  /** Milestones present on-chain but absent from the indexed store. */
  missingIndexedMilestones: string[];
  /**
   * Flattened field-level differences (empty when `status` is not
   * `divergent`). Values are the redacted/sanitized payloads described in
   * {@link MilestoneFieldDifference}.
   */
  differences: MilestoneFieldDifference[];
  /**
   * Sanitized RPC failure context when `status` is `unavailable`. Only
   * contains a stable error code and a short message — never a stack trace
   * or provider secrets.
   */
  rpcError?: { code: string; message: string };
}

/** Persisted audit row for one contract comparison within a scan run. */
export interface DivergenceReportRecord {
  id: string;
  /** Groups all reports produced by a single scan run (retry-safe upsert key). */
  runId: string;
  tenantId: string;
  contractId: string;
  status: ContractComparisonStatus;
  blockHeight?: number;
  /** ISO-8601 timestamp the comparison was produced at. */
  comparedAt: string;
  /** MilestoneComparisons serialized for auditability. */
  milestoneComparisons: MilestoneComparison[];
  /** Flattened field-level differences (see {@link ContractComparison}). */
  differences: MilestoneFieldDifference[];
  /** Sanitized RPC failure context, when the comparison was `unavailable`. */
  rpcError?: { code: string; message: string };
  /** ISO-8601 timestamp the row was persisted at. */
  createdAt: string;
}

/** Filter shape accepted by the divergence report repository. */
export interface DivergenceReportQuery {
  runId?: string;
  tenantId?: string;
  status?: ContractComparisonStatus;
  limit?: number;
  offset?: number;
}

/** Queue payload for a milestone divergence scan job. */
export interface MilestoneDivergenceScanPayload {
  /**
   * Tenant to scope the scan to. `undefined` scans the default tenant.
   * Reader/provider implementations are responsible for honoring it.
   */
  tenantId?: string;
  /**
   * Upper bound on the number of contracts compared in this run. The scan
   * never exceeds this, no matter how many contracts exist.
   */
  maxContracts?: number;
  /**
   * Pagination cursor (contract id to start after). Lets a scheduled series
   * of runs walk a large contract set without loading it all at once.
   */
  cursor?: string;
  /**
   * Opaque run id; when supplied, reports upsert under it so a retried job
   * never duplicates report rows.
   */
  runId?: string;
  correlationId?: string;
  requestId?: string;
}

/** Structured summary returned by a scan run. */
export interface DivergenceScanSummary {
  runId: string;
  tenantId: string;
  blockHeight: number;
  contractsScanned: number;
  inSync: number;
  divergent: number;
  unavailable: number;
  /** Cursor for the next run; `undefined` when the set is exhausted. */
  nextCursor?: string;
}
