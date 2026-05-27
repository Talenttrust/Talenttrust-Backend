import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface VulnerabilityCounts {
  info: number;
  low: number;
  moderate: number;
  high: number;
  critical: number;
  total: number;
}

export interface VulnerabilityEntry {
  name: string;
  severity: string;
  fixAvailable: boolean | string;
  range: string;
}

export interface DependencyScanReport {
  status: 'clean' | 'vulnerable';
  scannedAt: string;
  summary: VulnerabilityCounts;
  vulnerabilities: VulnerabilityEntry[];
  recommendation: string;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/* istanbul ignore next */
async function defaultNpmAuditRunner(): Promise<string> {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    const result = await execFileAsync(npmCmd, ['audit', '--json', '--omit=dev'], {
      cwd: process.cwd(),
    });
    return result.stdout;
  } catch (err: unknown) {
    // npm audit exits non-zero when vulnerabilities exist; stdout is still valid JSON
    if (
      err &&
      typeof err === 'object' &&
      'stdout' in err &&
      typeof (err as { stdout: unknown }).stdout === 'string'
    ) {
      return (err as { stdout: string }).stdout;
    }
    throw new Error('Failed to run npm audit');
  }
}

export class DependencyScanService {
  private cachedReport: DependencyScanReport | null = null;
  private cacheTimestamp = 0;

  constructor(private readonly auditRunner: () => Promise<string> = defaultNpmAuditRunner) {}

  async getReport(forceRefresh = false): Promise<DependencyScanReport> {
    const now = Date.now();
    if (!forceRefresh && this.cachedReport && now - this.cacheTimestamp < CACHE_TTL_MS) {
      return this.cachedReport;
    }

    const stdout = await this.auditRunner();
    const report = this.parseAuditOutput(stdout);
    this.cachedReport = report;
    this.cacheTimestamp = now;
    return report;
  }

  parseAuditOutput(stdout: string): DependencyScanReport {
    let auditData: Record<string, unknown>;
    try {
      auditData = JSON.parse(stdout) as Record<string, unknown>;
    } catch {
      throw new Error('Failed to parse npm audit output');
    }

    const meta = auditData.metadata as
      | { vulnerabilities: VulnerabilityCounts }
      | undefined;

    const counts: VulnerabilityCounts = {
      info: meta?.vulnerabilities?.info ?? 0,
      low: meta?.vulnerabilities?.low ?? 0,
      moderate: meta?.vulnerabilities?.moderate ?? 0,
      high: meta?.vulnerabilities?.high ?? 0,
      critical: meta?.vulnerabilities?.critical ?? 0,
      total: meta?.vulnerabilities?.total ?? 0,
    };

    type RawVuln = {
      name: string;
      severity: string;
      fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
      range: string;
    };
    const rawVulns = (auditData.vulnerabilities ?? {}) as Record<string, RawVuln>;

    const vulnerabilities: VulnerabilityEntry[] = Object.values(rawVulns).map((v) => ({
      name: v.name,
      severity: v.severity,
      fixAvailable: typeof v.fixAvailable === 'object' ? v.fixAvailable.name : v.fixAvailable,
      range: v.range ?? '',
    }));

    const isClean = counts.total === 0;
    const hasHighOrCritical = counts.high > 0 || counts.critical > 0;

    let recommendation: string;
    if (isClean) {
      recommendation =
        'No production dependency vulnerabilities detected. Run npm audit periodically.';
    } else if (hasHighOrCritical) {
      recommendation =
        'High or critical vulnerabilities found. Run `npm audit fix --omit=dev` immediately and review breaking changes.';
    } else {
      recommendation =
        'Low or moderate vulnerabilities found. Run `npm audit fix --omit=dev` at next maintenance window.';
    }

    return {
      status: isClean ? 'clean' : 'vulnerable',
      scannedAt: new Date().toISOString(),
      summary: counts,
      vulnerabilities,
      recommendation,
    };
  }
}
