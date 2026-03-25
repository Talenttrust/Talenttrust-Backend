import { IncidentRunbook } from './incidentResponse.types';

const RUNBOOKS: IncidentRunbook[] = [
  {
    id: 'api-outage',
    title: 'API Outage Triage and Recovery',
    severity: 'critical',
    outageSignals: [
      'Elevated 5xx rates across public APIs',
      'Health check failures from multiple regions',
      'Sustained latency above service SLOs',
    ],
    lastReviewed: '2026-03-25',
    objective:
      'Restore API availability quickly while preserving evidence for root-cause analysis.',
    triage: [
      'Confirm blast radius using health checks, logs, and infrastructure telemetry.',
      'Identify whether the issue is isolated to a dependency, deployment, or data store.',
      'Assign an incident commander and freeze unrelated production changes.',
      'Capture timestamps, failing endpoints, and error samples for the incident timeline.',
    ],
    recovery: [
      'Rollback the most recent risky change if the incident correlates with a deployment.',
      'Fail over to known-good infrastructure or scale healthy replicas to stabilize traffic.',
      'Apply narrowly scoped mitigations first, then validate error and latency recovery.',
      'Announce recovery status only after service health remains stable for a full observation window.',
    ],
    postmortem: [
      'Document trigger, impact window, customer impact, and detection gaps.',
      'Record what changed during mitigation, including approvals and residual risk.',
      'Create remediation items with owners and deadlines for reliability improvements.',
    ],
    securityNotes: [
      'Do not disable authentication or rate limiting to restore traffic.',
      'Treat raw logs and incident artifacts as sensitive because they may contain customer metadata.',
    ],
  },
  {
    id: 'data-integrity',
    title: 'Data Integrity Incident Response',
    severity: 'critical',
    outageSignals: [
      'Unexpected contract state transitions',
      'Detected checksum or reconciliation mismatches',
      'User reports of missing or duplicated records',
    ],
    lastReviewed: '2026-03-25',
    objective:
      'Contain data corruption, prevent further writes, and restore trusted state with auditable recovery steps.',
    triage: [
      'Pause non-essential write paths that could spread corruption.',
      'Scope affected tenants, tables, and time ranges using audit trails and backups.',
      'Preserve forensic evidence before running corrective scripts or manual edits.',
      'Coordinate with application owners before replaying jobs or restoring data.',
    ],
    recovery: [
      'Recover from the latest verified backup or replay trusted events into a clean target.',
      'Validate restored records against reconciliation reports before reopening writes.',
      'Use least-privilege access for all recovery scripts and record every data-change command.',
      'Monitor for repeated corruption signals after service restoration.',
    ],
    postmortem: [
      'Explain how corrupted state entered the system and why controls did not stop it.',
      'List validation, backup, and rollback improvements needed to reduce recurrence.',
      'Attach evidence showing restored data matched a trusted source of truth.',
    ],
    securityNotes: [
      'Manual data repair requires dual review for production commands.',
      'Never restore from unverified backups or ad hoc exports with unclear provenance.',
    ],
  },
  {
    id: 'security-breach',
    title: 'Security Breach Containment and Recovery',
    severity: 'high',
    outageSignals: [
      'Suspicious authentication or privilege escalation activity',
      'Unexpected configuration changes in production',
      'Indicators of compromise from dependency or host monitoring',
    ],
    lastReviewed: '2026-03-25',
    objective:
      'Contain suspected compromise, preserve evidence, and restore trusted operations without expanding attacker access.',
    triage: [
      'Activate the security incident commander and restrict production access to responders.',
      'Isolate affected credentials, hosts, workloads, or tokens without destroying forensic evidence.',
      'Assess whether customer data, secrets, or signing keys may have been exposed.',
      'Escalate legal and stakeholder communications based on confirmed scope, not speculation.',
    ],
    recovery: [
      'Rotate compromised secrets, revoke sessions, and rebuild affected systems from trusted images.',
      'Patch exploited vulnerabilities and validate security controls before reconnecting isolated systems.',
      'Restore service access in phases while monitoring for re-entry or persistence.',
      'Retain immutable evidence copies for post-incident investigation and compliance follow-up.',
    ],
    postmortem: [
      'Document attack path, detection timeline, affected assets, and containment delays.',
      'Track follow-up work for hardening, monitoring, and credential management.',
      'Confirm customer notification and regulatory obligations were evaluated and completed.',
    ],
    securityNotes: [
      'Do not disclose unverified breach details in public channels.',
      'Recovered systems must come from a trusted rebuild path, not in-place cleanup alone.',
    ],
  },
];

export function getIncidentRunbookData(): readonly IncidentRunbook[] {
  return RUNBOOKS;
}
