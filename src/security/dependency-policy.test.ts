import { buildRemediationPlan, evaluateDependencyPolicy } from './dependency-policy';
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

