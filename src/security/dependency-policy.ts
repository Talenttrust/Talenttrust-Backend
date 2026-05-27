import {
  DependencyIssue,
  DependencyPolicy,
  DependencyScanSummary,
  PolicyEvaluation,
  SEVERITY_ORDER,
  Severity,
  VulnerabilityCounts,
} from './dependency-types';

export const DEFAULT_DEPENDENCY_POLICY: DependencyPolicy = {
  failOn: 'high',
  includeDevDependencies: false,
};

const EMPTY_COUNTS: VulnerabilityCounts = {
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
};

function toBlockedSeverities(minSeverity: DependencyPolicy['failOn']): Severity[] {
  const minIndex = SEVERITY_ORDER.indexOf(minSeverity);
  return [...SEVERITY_ORDER.slice(minIndex)];
}

function countBySeverity(issues: DependencyIssue[]): VulnerabilityCounts {
  return issues.reduce(
    (acc, issue) => {
      acc[issue.severity] += 1;
      return acc;
    },
    { ...EMPTY_COUNTS },
  );
}

/**
 * @notice Evaluates vulnerabilities against repository policy and returns a merge-safe decision.
 */
export function evaluateDependencyPolicy(
  summary: DependencyScanSummary,
  policy: DependencyPolicy,
): PolicyEvaluation {
  const consideredIssues = policy.includeDevDependencies
    ? summary.issues
    : summary.issues.filter((issue) => !issue.isDevDependency);

  const consideredCounts = countBySeverity(consideredIssues);
  const blockedSeverities = toBlockedSeverities(policy.failOn);
  const blockedCount = blockedSeverities.reduce((acc, severity) => acc + consideredCounts[severity], 0);

  return {
    passed: blockedCount === 0,
    blockingCounts: consideredCounts,
    reason:
      blockedCount === 0
        ? 'No policy-blocking vulnerabilities found.'
        : `Found ${blockedCount} vulnerability issue(s) at ${policy.failOn}+ severity.`,
  };
}

/**
 * @notice Produces reviewer-friendly remediation commands for actionable vulnerabilities.
 * @dev Commands are intentionally conservative and always start with non-forced remediation.
 */
export function buildRemediationPlan(summary: DependencyScanSummary): string[] {
  const updatable = summary.issues.filter((issue) => issue.fixAvailable);

  if (updatable.length === 0) {
    return [
      'npm audit --omit=dev',
      'npm outdated',
      'Manually evaluate transitive dependency updates and vendor advisories.',
    ];
  }

  return [
    'npm audit fix --omit=dev',
    'npm audit fix --omit=dev --dry-run',
    'npm outdated',
    `Review ${updatable.length} fixable vulnerability issue(s) before merge.`,
  ];
}

