import {
  DependencyIssue,
  DependencyScanSummary,
  NpmAuditReport,
  NpmAuditVulnerability,
  SEVERITY_ORDER,
  Severity,
  VulnerabilityCounts,
} from './dependency-types';

const EMPTY_COUNTS: VulnerabilityCounts = {
  info: 0,
  low: 0,
  moderate: 0,
  high: 0,
  critical: 0,
};

function isSeverity(value: string): value is Severity {
  return (SEVERITY_ORDER as readonly string[]).includes(value);
}

function normalizeSeverity(value: unknown): Severity {
  if (typeof value === 'string' && isSeverity(value)) {
    return value;
  }

  return 'low';
}

function normalizeCounts(raw: NpmAuditReport['metadata']): VulnerabilityCounts {
  const vulnerabilities = raw?.vulnerabilities;

  return {
    info: vulnerabilities?.info ?? 0,
    low: vulnerabilities?.low ?? 0,
    moderate: vulnerabilities?.moderate ?? 0,
    high: vulnerabilities?.high ?? 0,
    critical: vulnerabilities?.critical ?? 0,
  };
}

function extractVia(via: NpmAuditVulnerability['via'] = []): string[] {
  return via.map((entry) => {
    if (typeof entry === 'string') {
      return entry;
    }

    return entry.title ?? entry.name ?? String(entry.source ?? 'unknown');
  });
}

function toDependencyIssue(dependency: string, vulnerability: NpmAuditVulnerability): DependencyIssue {
  return {
    dependency,
    severity: normalizeSeverity(vulnerability.severity),
    isDirect: Boolean(vulnerability.isDirect),
    isDevDependency: Boolean(vulnerability.dev),
    fixAvailable: Boolean(vulnerability.fixAvailable),
    affectedRange: vulnerability.range ?? '*',
    via: extractVia(vulnerability.via),
  };
}

function computeTotal(counts: VulnerabilityCounts): number {
  return Object.values(counts).reduce((acc, count) => acc + count, 0);
}

/**
 * @notice Converts `npm audit --json` output into a normalized in-app summary.
 * @dev Unknown fields are ignored so parser remains forward-compatible with npm changes.
 */
export function parseNpmAuditReport(report: NpmAuditReport): DependencyScanSummary {
  const entries = Object.entries(report.vulnerabilities ?? {});
  const issues = entries.map(([dependency, vulnerability]) => toDependencyIssue(dependency, vulnerability));

  const countsFromMetadata = normalizeCounts(report.metadata);
  const hasMetadata = computeTotal(countsFromMetadata) > 0;
  const counts = hasMetadata
    ? countsFromMetadata
    : issues.reduce((acc, issue) => {
        acc[issue.severity] += 1;
        return acc;
      }, { ...EMPTY_COUNTS });

  return {
    source: 'npm-audit',
    total: computeTotal(counts),
    counts,
    issues,
  };
}
