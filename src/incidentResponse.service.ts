import { getIncidentRunbookData } from './incidentResponse.data';
import { IncidentRunbook, IncidentRunbookSummary } from './incidentResponse.types';

const RUNBOOK_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

function cloneRunbook<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Validates runbook identifiers before they are used for lookup.
 */
export function isValidRunbookId(runbookId: string): boolean {
  return RUNBOOK_ID_PATTERN.test(runbookId);
}

/**
 * Returns catalog metadata for all incident runbooks.
 */
export function listIncidentRunbooks(): IncidentRunbookSummary[] {
  return getIncidentRunbookData().map(({ id, title, severity, outageSignals, lastReviewed }) =>
    cloneRunbook({
      id,
      title,
      severity,
      outageSignals,
      lastReviewed,
    }),
  );
}

/**
 * Looks up a runbook by identifier and returns a defensive copy.
 */
export function getIncidentRunbookById(runbookId: string): IncidentRunbook | null {
  const normalizedRunbookId = runbookId.trim().toLowerCase();

  if (!isValidRunbookId(normalizedRunbookId)) {
    return null;
  }

  const runbook = getIncidentRunbookData().find(({ id }) => id === normalizedRunbookId);
  return runbook ? cloneRunbook(runbook) : null;
}
