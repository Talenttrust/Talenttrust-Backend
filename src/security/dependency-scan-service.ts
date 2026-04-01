import { spawn } from 'node:child_process';

import { buildRemediationPlan, DEFAULT_DEPENDENCY_POLICY, evaluateDependencyPolicy } from './dependency-policy';
import { parseNpmAuditReport } from './npm-audit-parser';
import { DependencyPolicy, DependencyScanError, DependencyScanResult, NpmAuditReport } from './dependency-types';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface DependencyScanProvider {
  getLatestScan(forceRefresh?: boolean): Promise<DependencyScanResult>;
}

export const defaultCommandRunner: CommandRunner = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      resolve({
        stdout,
        stderr: `${stderr}\n${error.message}`.trim(),
        exitCode: 1,
      });
    });

    child.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });
  });

/**
 * @notice Executes dependency scanning with cache and policy evaluation support.
 */
export class DependencyScanService implements DependencyScanProvider {
  private latestResult?: DependencyScanResult;

  private latestResultExpiresAt = 0;

  public constructor(
    private readonly runner: CommandRunner = defaultCommandRunner,
    private readonly policy: DependencyPolicy = DEFAULT_DEPENDENCY_POLICY,
    private readonly ttlMs = 5 * 60 * 1000,
    private readonly now = () => Date.now(),
  ) {}

  public async getLatestScan(forceRefresh = false): Promise<DependencyScanResult> {
    if (!forceRefresh && this.latestResult && this.now() < this.latestResultExpiresAt) {
      return this.latestResult;
    }

    const result = await this.performScan();
    this.latestResult = result;
    this.latestResultExpiresAt = this.now() + this.ttlMs;

    return result;
  }

  private async performScan(): Promise<DependencyScanResult> {
    const scannedAt = new Date(this.now()).toISOString();
    const args = ['audit', '--json'];

    if (!this.policy.includeDevDependencies) {
      args.push('--omit=dev');
    }

    const auditResult = await this.runner('npm', args);

    if (!auditResult.stdout.trim()) {
      return this.createError(scannedAt, `npm audit returned no parsable output. ${auditResult.stderr}`.trim());
    }

    let parsed: NpmAuditReport;
    try {
      parsed = JSON.parse(auditResult.stdout) as NpmAuditReport;
    } catch (error) {
      return this.createError(scannedAt, `Invalid npm audit JSON output: ${(error as Error).message}`);
    }

    const summary = parseNpmAuditReport(parsed);
    const evaluation = evaluateDependencyPolicy(summary, this.policy);

    return {
      status: 'ok',
      scannedAt,
      policy: this.policy,
      summary,
      evaluation,
      remediation: buildRemediationPlan(summary),
    };
  }

  private createError(scannedAt: string, message: string): DependencyScanError {
    return {
      status: 'error',
      scannedAt,
      policy: this.policy,
      message,
    };
  }
}
