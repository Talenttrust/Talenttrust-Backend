/**
 * Summary view returned by the incident response catalog endpoint.
 */
export interface IncidentRunbookSummary {
  id: string;
  title: string;
  severity: 'high' | 'critical';
  outageSignals: string[];
  lastReviewed: string;
}

/**
 * Full runbook definition exposed to responders.
 */
export interface IncidentRunbook extends IncidentRunbookSummary {
  objective: string;
  triage: string[];
  recovery: string[];
  postmortem: string[];
  securityNotes: string[];
}
