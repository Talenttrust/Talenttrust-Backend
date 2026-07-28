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
      if (SEVERITY_ORDER.includes(issue.severity)) {
        acc[issue.severity] += 1;
      }
      return acc;
    },
    { ...EMPTY_COUNTS },
  );
}

/**
 * @notice Evaluates vulnerabilities against repository policy and returns a merge-safe decision.
 * @param summary The dependency scan summary containing parsed vulnerabilities.
 * @param policy The dependency policy config, defining the threshold (failOn) and dev dependency inclusions.
 *               The failOn threshold blocks any vulnerability at or above that severity level.
 *               Severities ordered lowest to highest: info < low < moderate < high < critical.
 *               If any unrecognized severity is encountered in either the policy or issues, the gate fails closed.
 * @returns A PolicyEvaluation indicating if the scan passed, the counts, and the reason.
 */
export function evaluateDependencyPolicy(
  summary: DependencyScanSummary,
  policy: DependencyPolicy,
): PolicyEvaluation {
  const consideredIssues = policy.includeDevDependencies
    ? summary.issues
    : summary.issues.filter((issue) => !issue.isDevDependency);

  const consideredCounts = countBySeverity(consideredIssues);

  const hasInvalidPolicySeverity = !SEVERITY_ORDER.includes(policy.failOn as any);
  const hasInvalidIssueSeverity = consideredIssues.some(
    (issue) => !SEVERITY_ORDER.includes(issue.severity),
  );

  if (hasInvalidPolicySeverity || hasInvalidIssueSeverity) {
    return {
      passed: false,
      blockingCounts: consideredCounts,
      reason: 'Failed closed due to unrecognized severity label in policy or scan issues.',
    };
  }

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

