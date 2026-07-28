import { buildRemediationPlan, evaluateDependencyPolicy } from './dependency-policy';
import { parseNpmAuditReport } from './npm-audit-parser';
import { DependencyScanSummary } from './dependency-types';

const baseSummary: DependencyScanSummary = {
  source: 'npm-audit',
  total: 3,
  counts: {
    info: 0,
    low: 0,
    moderate: 1,
    high: 1,
    critical: 1,
  },
  issues: [
    {
      dependency: 'pkg-high',
      severity: 'high',
      isDirect: true,
      isDevDependency: false,
      fixAvailable: true,
      affectedRange: '*',
      via: ['advisory'],
    },
    {
      dependency: 'pkg-critical-dev',
      severity: 'critical',
      isDirect: true,
      isDevDependency: true,
      fixAvailable: true,
      affectedRange: '*',
      via: ['advisory'],
    },
    {
      dependency: 'pkg-moderate',
      severity: 'moderate',
      isDirect: false,
      isDevDependency: false,
      fixAvailable: false,
      affectedRange: '*',
      via: ['advisory'],
    },
  ],
};

describe('evaluateDependencyPolicy', () => {
  it('fails when non-dev vulnerabilities exceed threshold', () => {
    const evaluation = evaluateDependencyPolicy(baseSummary, {
      failOn: 'high',
      includeDevDependencies: false,
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.reason).toContain('high+');
  });

  it('passes when only dev vulnerabilities are blocking and dev is excluded', () => {
    const summary: DependencyScanSummary = {
      ...baseSummary,
      issues: [baseSummary.issues[1]],
    };

    const evaluation = evaluateDependencyPolicy(summary, {
      failOn: 'high',
      includeDevDependencies: false,
    });

    expect(evaluation.passed).toBe(true);
  });

  it('fails when dev vulnerabilities are included', () => {
    const summary: DependencyScanSummary = {
      ...baseSummary,
      issues: [baseSummary.issues[1]],
    };

    const evaluation = evaluateDependencyPolicy(summary, {
      failOn: 'high',
      includeDevDependencies: true,
    });

    expect(evaluation.passed).toBe(false);
    expect(evaluation.blockingCounts.critical).toBe(1);
  });

  describe('Severity Threshold Boundary Logic & Mixed-Severity Cases', () => {
    // We will drive policy evaluation with synthetic audit findings resembling real npm-audit JSON shapes.

    it('passes for a clean scan (empty findings)', () => {
      const rawReport = {
        vulnerabilities: {},
        metadata: {
          vulnerabilities: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
          },
        },
      };
      const summary = parseNpmAuditReport(rawReport);
      const evaluation = evaluateDependencyPolicy(summary, {
        failOn: 'low',
        includeDevDependencies: false,
      });

      expect(evaluation.passed).toBe(true);
      expect(evaluation.reason).toBe('No policy-blocking vulnerabilities found.');
    });

    const severities = ['info', 'low', 'moderate', 'high', 'critical'] as const;

    // Test that findings below the configured threshold pass and at/above fail.
    // Driving policy across every severity level.
    for (const threshold of ['low', 'moderate', 'high', 'critical'] as const) {
      describe(`Threshold failOn: ${threshold}`, () => {
        it('passes when findings are below the threshold', () => {
          // Find all severities strictly below the threshold
          const belowSeverities = severities.slice(0, severities.indexOf(threshold));
          
          if (belowSeverities.length > 0) {
            // Build issues below threshold
            const vulnerabilities: Record<string, any> = {};
            const counts: Record<string, number> = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
            
            belowSeverities.forEach((sev, idx) => {
              vulnerabilities[`pkg-${sev}-${idx}`] = {
                severity: sev,
                isDirect: true,
                dev: false,
                fixAvailable: false,
              };
              counts[sev] += 1;
            });

            const summary = parseNpmAuditReport({
              vulnerabilities,
              metadata: { vulnerabilities: counts },
            });

            const evaluation = evaluateDependencyPolicy(summary, {
              failOn: threshold,
              includeDevDependencies: false,
            });

            expect(evaluation.passed).toBe(true);
          }
        });

        it('fails when findings are exactly at the threshold', () => {
          const vulnerabilities = {
            [`pkg-${threshold}`]: {
              severity: threshold,
              isDirect: true,
              dev: false,
              fixAvailable: false,
            },
          };
          const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, [threshold]: 1 };

          const summary = parseNpmAuditReport({
            vulnerabilities,
            metadata: { vulnerabilities: counts },
          });

          const evaluation = evaluateDependencyPolicy(summary, {
            failOn: threshold,
            includeDevDependencies: false,
          });

          expect(evaluation.passed).toBe(false);
          expect(evaluation.reason).toContain(`${threshold}+`);
        });

        it('fails when findings are above the threshold', () => {
          const index = severities.indexOf(threshold);
          if (index < severities.length - 1) {
            const higherSeverity = severities[index + 1];
            const vulnerabilities = {
              [`pkg-${higherSeverity}`]: {
                severity: higherSeverity,
                isDirect: true,
                dev: false,
                fixAvailable: false,
              },
            };
            const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, [higherSeverity]: 1 };

            const summary = parseNpmAuditReport({
              vulnerabilities,
              metadata: { vulnerabilities: counts },
            });

            const evaluation = evaluateDependencyPolicy(summary, {
              failOn: threshold,
              includeDevDependencies: false,
            });

            expect(evaluation.passed).toBe(false);
            expect(evaluation.reason).toContain(`${threshold}+`);
          }
        });
      });
    }

    it('resolves mixed-severity inputs to the highest-severity decision (fails if any is at/above threshold)', () => {
      // Configured threshold is moderate. Findings have info, low, moderate, and critical.
      // Since moderate and critical are at or above threshold, the overall decision must fail.
      const rawReport = {
        vulnerabilities: {
          'pkg-info': { severity: 'info', dev: false },
          'pkg-low': { severity: 'low', dev: false },
          'pkg-mod': { severity: 'moderate', dev: false },
          'pkg-crit': { severity: 'critical', dev: false },
        },
      };

      const summary = parseNpmAuditReport(rawReport);
      const evaluation = evaluateDependencyPolicy(summary, {
        failOn: 'moderate',
        includeDevDependencies: false,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.reason).toContain('moderate+');
      // Verify all counts are correctly collected in the evaluation result
      expect(evaluation.blockingCounts.info).toBe(1);
      expect(evaluation.blockingCounts.low).toBe(1);
      expect(evaluation.blockingCounts.moderate).toBe(1);
      expect(evaluation.blockingCounts.critical).toBe(1);
    });

    it('fails closed on unrecognized severity labels in the policy', () => {
      const summary = parseNpmAuditReport({ vulnerabilities: {} });
      const evaluation = evaluateDependencyPolicy(summary, {
        failOn: 'unknown-severity' as any,
        includeDevDependencies: false,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.reason).toContain('unrecognized severity label');
    });

    it('fails closed on unrecognized severity labels in the issues', () => {
      const summary: DependencyScanSummary = {
        source: 'npm-audit',
        total: 1,
        counts: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
        issues: [
          {
            dependency: 'pkg-broken',
            severity: 'invalid-severity-label' as any,
            isDirect: true,
            isDevDependency: false,
            fixAvailable: false,
            affectedRange: '*',
            via: [],
          },
        ],
      };

      const evaluation = evaluateDependencyPolicy(summary, {
        failOn: 'high',
        includeDevDependencies: false,
      });

      expect(evaluation.passed).toBe(false);
      expect(evaluation.reason).toContain('unrecognized severity label');
    });
  });
});

describe('buildRemediationPlan', () => {
  it('recommends fix flow when fixable issues exist', () => {
    const plan = buildRemediationPlan(baseSummary);

    expect(plan[0]).toContain('npm audit fix');
    expect(plan[3]).toContain('fixable vulnerability issue');
  });

  it('recommends manual flow when no fixes exist', () => {
    const summary: DependencyScanSummary = {
      ...baseSummary,
      issues: baseSummary.issues.map((issue) => ({ ...issue, fixAvailable: false })),
    };

    const plan = buildRemediationPlan(summary);

    expect(plan[0]).toBe('npm audit --omit=dev');
    expect(plan[2]).toContain('Manually evaluate');
  });
});
