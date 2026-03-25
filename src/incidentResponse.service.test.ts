import {
  getIncidentRunbookById,
  isValidRunbookId,
  listIncidentRunbooks,
} from './incidentResponse.service';

describe('incidentResponse.service', () => {
  it('lists the supported runbook summaries', () => {
    const runbooks = listIncidentRunbooks();

    expect(runbooks).toHaveLength(3);
    expect(runbooks[0]).toEqual({
      id: 'api-outage',
      title: 'API Outage Triage and Recovery',
      severity: 'critical',
      outageSignals: expect.arrayContaining(['Elevated 5xx rates across public APIs']),
      lastReviewed: '2026-03-25',
    });
  });

  it('returns a defensive copy for summaries', () => {
    const [first] = listIncidentRunbooks();
    first.outageSignals.push('tampered');

    const [freshCopy] = listIncidentRunbooks();
    expect(freshCopy.outageSignals).not.toContain('tampered');
  });

  it('finds a runbook by id using normalized input', () => {
    const runbook = getIncidentRunbookById('  SECURITY-BREACH ');

    expect(runbook).toMatchObject({
      id: 'security-breach',
      title: 'Security Breach Containment and Recovery',
    });
    expect(runbook?.triage.length).toBeGreaterThan(0);
    expect(runbook?.recovery.length).toBeGreaterThan(0);
    expect(runbook?.postmortem.length).toBeGreaterThan(0);
  });

  it('returns a defensive copy for full runbooks', () => {
    const runbook = getIncidentRunbookById('api-outage');
    runbook?.triage.push('tampered');

    const freshCopy = getIncidentRunbookById('api-outage');
    expect(freshCopy?.triage).not.toContain('tampered');
  });

  it('rejects invalid runbook ids', () => {
    expect(isValidRunbookId('api-outage')).toBe(true);
    expect(isValidRunbookId('../etc/passwd')).toBe(false);
    expect(isValidRunbookId('UPPERCASE')).toBe(false);
    expect(getIncidentRunbookById('../etc/passwd')).toBeNull();
  });

  it('returns null for a valid but unknown runbook id', () => {
    expect(getIncidentRunbookById('missing-runbook')).toBeNull();
  });
});
