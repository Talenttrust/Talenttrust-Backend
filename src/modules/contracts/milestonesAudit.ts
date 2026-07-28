/**
 * @module modules/contracts/milestonesAudit
 * @description Helpers that turn milestone write payloads into bounded,
 * redacted before/after summaries suitable for the audit trail (see
 * `audit/service.ts` → `AuditService.logMilestonesEvent`).
 *
 * ## Why "before" comes from the audit log, not the database
 *
 * Milestones are currently validated on contract create/update but are not
 * persisted as their own column or table (`Contract` has no `milestones`
 * field — see `db/types.ts` / `repositories/contractRepository.ts`). That
 * pre-existing gap is out of scope for this change: fixing it would mean
 * altering the persistence model, not adding an audit trail to it.
 *
 * Instead, the audit log is treated as the authoritative history of
 * milestone state: each write's "after" snapshot becomes the next write's
 * "before" snapshot, reconstructed via `getLastMilestonesSnapshot`. This
 * keeps the audit trail internally consistent (every entry accurately
 * reflects what changed relative to the last recorded write) even though it
 * cannot be cross-checked against a persisted `milestones` column today.
 *
 * ## Bounding
 *
 * `summarizeMilestones` caps the number of individual milestone items kept
 * in a single audit entry at `MAX_SUMMARY_ITEMS`, and `getLastMilestonesSnapshot`
 * only ever reads the single most recent matching entry for a contract — so
 * neither the size of an individual entry nor the amount of history read back
 * on every write grows unbounded with the number of milestones or the number
 * of prior edits.
 */

import type { AuditAction } from '../../audit/types';
import type { AuditService } from '../../audit/service';
import { redactBody } from '../../audit/redact';
import type { ContractMilestoneDto } from './dto/contracts-boundary.dto';

/** Maximum number of individual milestone items retained in one audit summary. */
export const MAX_SUMMARY_ITEMS = 50;

/** A single milestone's structural facts, as retained in an audit summary. */
export interface MilestoneSummaryItem {
  title: string;
  amount: number;
  completed: boolean;
  deadline?: string;
}

/** Bounded, audit-friendly summary of a contract's milestone state. */
export interface MilestonesSnapshot {
  count: number;
  totalAmount: number;
  items: MilestoneSummaryItem[];
  /** True when `items` was truncated to `MAX_SUMMARY_ITEMS`. */
  truncated: boolean;
}

/**
 * Order-independent structural equality for two values that are either
 * primitives, plain objects, or arrays (the only shapes a MilestonesSnapshot
 * can contain). Deliberately not `JSON.stringify(a) === JSON.stringify(b)`:
 * stringify is sensitive to object key *insertion order*, so two
 * semantically-identical snapshots built via different code paths (e.g. one
 * read back from the audit store, one freshly summarised) could otherwise
 * compare unequal purely by coincidence of key order.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every((key) =>
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }

  return false;
}

function isMilestonesSnapshot(value: unknown): value is MilestonesSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as MilestonesSnapshot).count === 'number' &&
    typeof (value as MilestonesSnapshot).totalAmount === 'number' &&
    Array.isArray((value as MilestonesSnapshot).items)
  );
}

/**
 * Reduces a milestone array into a bounded, audit-friendly summary.
 *
 * Free-text `description` fields are intentionally left out of the
 * summary — only structural facts (title, amount, deadline, completed) are
 * recorded, since descriptions are unbounded free text with no audit value
 * on their own. Everything that *is* included is still passed through
 * `redactBody` so any accidentally-pasted secret-shaped values (API keys,
 * tokens, emails) are masked before they reach the log.
 *
 * @param milestones - The milestone array from a create/update payload.
 * @returns `null` when there are no milestones (nothing to summarise).
 */
export function summarizeMilestones(
  milestones: readonly ContractMilestoneDto[] | undefined,
): MilestonesSnapshot | null {
  if (!milestones || milestones.length === 0) {
    return null;
  }

  const truncated = milestones.length > MAX_SUMMARY_ITEMS;
  const items: MilestoneSummaryItem[] = milestones.slice(0, MAX_SUMMARY_ITEMS).map((m) => ({
    title: m.title,
    amount: m.amount,
    completed: m.completed,
    ...(m.deadline !== undefined && { deadline: m.deadline }),
  }));
  const totalAmount = milestones.reduce((sum, m) => sum + m.amount, 0);

  return redactBody({
    count: milestones.length,
    totalAmount,
    items,
    truncated,
  }) as MilestonesSnapshot;
}

/**
 * Determines which (if any) milestones audit action applies given the
 * previous and new snapshots.
 *
 * @returns `null` when there is nothing worth recording — either both sides
 * are empty, or an update resubmitted an identical milestone set.
 */
export function determineMilestonesAction(
  before: MilestonesSnapshot | null,
  after: MilestonesSnapshot | null,
): Extract<AuditAction, `MILESTONES_${string}`> | null {
  const hadBefore = before !== null && before.count > 0;
  const hasAfter = after !== null && after.count > 0;

  if (!hadBefore && !hasAfter) return null;
  if (!hadBefore && hasAfter) return 'MILESTONES_CREATED';
  if (hadBefore && !hasAfter) return 'MILESTONES_DELETED';

  // Both present: only log when the content actually changed, so replaying
  // an identical PATCH does not spam the log with no-op entries.
  if (deepEqual(before, after)) return null;
  return 'MILESTONES_UPDATED';
}

/** Builds the audit-entry metadata payload for a milestones write. */
export function buildMilestonesAuditMetadata(
  before: MilestonesSnapshot | null,
  after: MilestonesSnapshot | null,
): Record<string, unknown> {
  return { before, after };
}

/**
 * Reconstructs the last known milestones snapshot for a contract from the
 * audit log itself (see module docs for why). Returns `null` when no prior
 * milestones write has been recorded for this contract.
 */
export function getLastMilestonesSnapshot(
  auditService: Pick<AuditService, 'query'>,
  contractId: string,
): MilestonesSnapshot | null {
  const entries = auditService.query({ resource: 'milestones', resourceId: contractId });
  if (entries.length === 0) {
    return null;
  }
  const last = entries[entries.length - 1];
  const after = (last.metadata as { after?: unknown } | undefined)?.after;
  return isMilestonesSnapshot(after) ? after : null;
}
