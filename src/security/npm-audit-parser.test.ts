import { parseNpmAuditReport } from './npm-audit-parser';

describe('parseNpmAuditReport', () => {
  it('normalizes vulnerability metadata and issues', () => {
    const summary = parseNpmAuditReport({
      vulnerabilities: {
        express: {
          severity: 'high',
          isDirect: true,
          dev: false,
          fixAvailable: true,
          range: '<4.21.0',
          via: ['some advisory'],
        },
        jest: {
          severity: 'moderate',
          isDirect: true,
          dev: true,
          fixAvailable: false,
          range: '<29.7.0',
          via: [{ title: 'prototype pollution' }],
        },
      },
      metadata: {
        vulnerabilities: {
          info: 0,
          low: 0,
          moderate: 1,
          high: 1,
          critical: 0,
        },
      },
    });

    expect(summary.total).toBe(2);
    expect(summary.counts.high).toBe(1);
    expect(summary.counts.moderate).toBe(1);
    expect(summary.issues).toHaveLength(2);
    expect(summary.issues[0]).toMatchObject({
      dependency: 'express',
      severity: 'high',
      fixAvailable: true,
    });
  });

  it('falls back to issue-derived counts when metadata is missing', () => {
    const summary = parseNpmAuditReport({
      vulnerabilities: {
        pkgA: {
          severity: 'critical',
          via: [{ name: 'pkgA', source: 1001 }],
        },
      },
    });

    expect(summary.total).toBe(1);
    expect(summary.counts.critical).toBe(1);
    expect(summary.issues[0].via[0]).toBe('pkgA');
  });

  it('defaults unknown severities to low', () => {
    const summary = parseNpmAuditReport({
      vulnerabilities: {
        pkgB: {
          severity: 'unknown-level',
        },
      },
    });

    expect(summary.counts.low).toBe(1);
  });
});

