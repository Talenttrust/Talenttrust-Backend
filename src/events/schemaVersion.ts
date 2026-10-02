/**
 * @module events/schemaVersion
 * @description Contract schema-version classification at the ingestion
 * boundary.
 *
 * A contract's event payload shape can change when a newer contract version
 * is deployed on-chain. Events carrying a schema version this backend does
 * not yet understand must not be fed into projections that assume the older
 * payload shape — they are retained (quarantined) instead of being applied
 * or silently dropped, so operators can reprocess them once support ships.
 *
 * Semantics:
 *  - `absent` — legacy events predating versioning; treated as version 1.
 *  - `known` — version this backend understands; process normally.
 *  - `unknown` — newer version; quarantine (redacted) and surface for
 *    authenticated reprocessing.
 *  - `malformed` — a present-but-invalid version value; rejected at the
 *    boundary (fail-closed: an ambiguous version is never guessed).
 */

/** Schema versions this backend understands. Append-only. */
export const KNOWN_SCHEMA_VERSIONS: readonly number[] = [1] as const;

export type SchemaVersionClass =
  | { status: 'known'; version: number }
  | { status: 'unknown'; version: number }
  | { status: 'malformed'; reason: string }
  | { status: 'absent' };

/**
 * Classify an event's `schemaVersion` field (already normalized by the
 * payload validator, which rejects non-positive-integer values).
 *
 * @param schemaVersion - The validated event `schemaVersion`, if present.
 * @param knownVersions - Overridable known set (tests simulate contract
 *                        upgrades by extending it).
 */
export function classifySchemaVersion(
  schemaVersion: number | undefined,
  knownVersions: readonly number[] = KNOWN_SCHEMA_VERSIONS,
): SchemaVersionClass {
  if (schemaVersion === undefined) {
    return { status: 'absent' };
  }

  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return { status: 'malformed', reason: 'schemaVersion must be a positive integer' };
  }

  if (knownVersions.includes(schemaVersion)) {
    return { status: 'known', version: schemaVersion };
  }

  return { status: 'unknown', version: schemaVersion };
}

/** Effective version applied to a legacy event with no version field. */
export const LEGACY_SCHEMA_VERSION = 1;
