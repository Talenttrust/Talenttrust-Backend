import type { EscrowContract, Milestone } from '../store';
import { HttpError } from '../store';

/**
 * Whitelisted top-level keys of {@link EscrowContract} that clients may
 * request via the `?fields=` query parameter.  `id` is always returned and
 * therefore intentionally omitted from this list (requesting it is allowed
 * but has no effect).
 */
export const ALLOWED_FIELDS: readonly string[] = [
  'title',
  'client',
  'freelancer',
  'token',
  'tokenSymbol',
  'milestones',
  'totalAmount',
  'totalAmountUnits',
  'fundedAmount',
  'fundedAmountUnits',
  'releasedAmount',
  'releasedAmountUnits',
  'status',
  'reputationIssued',
  'dispute',
  'chain',
  'revision',
  'version',
  'templateId',
  'templateVersion',
  'createdAt',
  'updatedAt',
  'fundingDeadline',
  'expiredAt',
  'refundableAmount',
  'refundableAmountUnits',
] as const;

/** Keys permitted inside a `milestones.<sub>` selector. */
const ALLOWED_MILESTONE_FIELDS: readonly string[] = [
  'index',
  'title',
  'amount',
  'amountUnits',
  'released',
] as const;

/**
 * Parsed representation of a `?fields=` value.
 * `top` is the set of top-level keys to keep; `nested` maps a top-level key
 * (currently only `milestones`) to the set of sub-keys to keep.  An entry in
 * `nested` with an empty set means "keep all sub-keys".
 */
export interface FieldSpec {
  top: Set<string>;
  nested: Map<string, Set<string>>;
}

/**
 * Parse a comma-separated `?fields=` value into a {@link FieldSpec}.
 *
 * Syntax (repeated for each comma-separated token):
 *   field            — top-level key
 *   milestones.sub   — nested sub-key selection
 *
 * `id` is always included in the output regardless of whether it appears in
 * the spec, so requesting `id` is allowed but redundant.
 *
 * @throws {HttpError} 400 `invalid_fields` when any requested field is not
 *   in the whitelist.  The error message lists every valid top-level name.
 */
export function parseFieldSpec(raw: string): FieldSpec {
  const tokens = raw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const top = new Set<string>();
  const nested = new Map<string, Set<string>>();

  for (const token of tokens) {
    if (token === 'id') continue; // always included
    const dot = token.indexOf('.');
    if (dot === -1) {
      // Top-level field
      if (!ALLOWED_FIELDS.includes(token)) {
        throw new HttpError(400, 'invalid_fields', `Unknown field "${token}". Valid fields: ${ALLOWED_FIELDS.join(', ')}`);
      }
      top.add(token);
    } else {
      // Nested selection, e.g. milestones.amount
      const parent = token.slice(0, dot);
      const child = token.slice(dot + 1);
      if (parent !== 'milestones') {
        throw new HttpError(
          400,
          'invalid_fields',
          `Unknown field "${parent}". Only "milestones" supports nested selection (e.g. milestones.amount). Valid fields: ${ALLOWED_FIELDS.join(', ')}`,
        );
      }
      if (child.length === 0) {
        throw new HttpError(400, 'invalid_fields', `Empty nested field after "${parent}."`);
      }
      if (!ALLOWED_MILESTONE_FIELDS.includes(child)) {
        throw new HttpError(
          400,
          'invalid_fields',
          `Unknown milestone field "${child}". Valid milestone fields: ${ALLOWED_MILESTONE_FIELDS.join(', ')}`,
        );
      }
      let subs = nested.get(parent);
      if (!subs) {
        subs = new Set<string>();
        nested.set(parent, subs);
      }
      subs.add(child);
      // Also ensure the parent key is requested at the top level.
      top.add(parent);
    }
  }

  return { top, nested };
}

function projectMilestone(m: Milestone, subs: Set<string>): Milestone {
  if (subs.size === 0) return { ...m };
  const out: Partial<Milestone> = {};
  for (const key of subs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (out as any)[key] = (m as any)[key];
  }
  return out as Milestone;
}

/**
 * Project a single contract, returning a **new** object that contains only
 * the requested fields.  The input object is never mutated.
 *
 * `id` is always present in the result.  When `spec.top` is empty every
 * top-level key is kept (the caller requested nested-only selection such as
 * `milestones.amount`, which implicitly selects the full milestones array
 * but with each milestone trimmed to the requested sub-keys).
 *
 * If `spec` is `null` the original object is returned as-is (no projection).
 *
 * @param obj  the source contract (will not be mutated)
 * @param spec parsed field spec, or `null` to skip projection
 */
export function project(obj: EscrowContract, spec: FieldSpec | null): EscrowContract {
  if (!spec) return obj;

  const out: Record<string, unknown> = { id: obj.id };

  const keysToKeep = spec.top.size === 0 ? (ALLOWED_FIELDS as readonly string[]) : [...spec.top];
  for (const key of keysToKeep) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (obj as any)[key];
    if (value === undefined) continue;
    if (key === 'milestones' && Array.isArray(value) && spec.nested.has('milestones')) {
      const subs = spec.nested.get('milestones')!;
      out.milestones = value.map((m: Milestone) => projectMilestone(m, subs));
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => (item && typeof item === 'object' ? { ...item } : item));
    } else if (value && typeof value === 'object') {
      out[key] = { ...value };
    } else {
      out[key] = value;
    }
  }

  return out as unknown as EscrowContract;
}
