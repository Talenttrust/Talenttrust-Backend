export const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'] as const;

export type Severity = (typeof SEVERITY_ORDER)[number];

export interface VulnerabilityCounts {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
}

export interface DependencyIssue {
  dependency: string;
  severity: Severity;
  isDirect: boolean;
  isDevDependency: boolean;
  fixAvailable: boolean;
  affectedRange: string;
  via: string[];
}

export interface DependencyScanSummary {
  source: 'npm-audit';
  total: number;
  counts: VulnerabilityCounts;
  issues: DependencyIssue[];
}

export interface DependencyPolicy {
  failOn: Extract<Severity, 'low' | 'moderate' | 'high' | 'critical'>;
  includeDevDependencies: boolean;
}

export interface PolicyEvaluation {
  passed: boolean;
  blockingCounts: VulnerabilityCounts;
  reason: string;
}

export interface DependencyScanSuccess {
  status: 'ok';
  scannedAt: string;
  summary: DependencyScanSummary;
  policy: DependencyPolicy;
  evaluation: PolicyEvaluation;
  remediation: string[];
}

export interface DependencyScanError {
  status: 'error';
  scannedAt: string;
  policy: DependencyPolicy;
  message: string;
}

export type DependencyScanResult = DependencyScanSuccess | DependencyScanError;

export interface NpmAuditVulnerability {
  name?: string;
  severity?: string;
  isDirect?: boolean;
  dev?: boolean;
  fixAvailable?: boolean | Record<string, unknown>;
  range?: string;
  via?: Array<string | { source?: number | string; name?: string; title?: string }>;
}

export interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: Partial<Record<Severity, number>>;
  };
}

