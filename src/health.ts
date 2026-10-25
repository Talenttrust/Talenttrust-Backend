/**
 * Liveness and readiness probes.
 *
 * `/health/live` answers "is the process up" and never touches a dependency.
 * `/health/ready` answers "can this instance actually serve traffic" by
 * checking the Soroban RPC, the configured network passphrase, the escrow
 * contract's ledger entry and the in-memory store. Checks run in parallel with
 * a per-check timeout, and results are cached (single-flight) so probes cannot
 * storm the RPC.
 *
 * Failure details are fixed strings: they never embed the RPC URL or anything
 * derived from it, so a broken config cannot leak through a health endpoint.
 */

import { config } from './config';
import type { EscrowStore } from './store';

export type CheckStatus = 'pass' | 'fail' | 'warn';

export interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  detail?: string;
}

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'unready';
  checks: Record<string, CheckResult>;
  checkedAt: string;
}

/** The dependency surface readiness needs; tests inject a fake. */
export interface HealthRpcClient {
  /** Soroban RPC `getHealth` result status, e.g. `healthy`. */
  getHealth(): Promise<string>;
  /** Passphrase of the network the RPC is serving, e.g. `Test SDF Network ; September 2015`. */
  getNetworkPassphrase(): Promise<string>;
  /** Whether the contract instance ledger entry exists for `contractId`. */
  hasContractInstance(contractId: string): Promise<boolean>;
}

export const NETWORK_PASSPHRASES: Record<string, string> = {
  public: 'Public Global Stellar Network ; September 2015',
  testnet: 'Test SDF Network ; September 2015',
  futurenet: 'Test SDF Future Network ; October 2022',
  local: 'Local Stellar Network ; September 2015',
};

const CRITICAL_CHECKS = ['rpc', 'network', 'contract', 'storage'] as const;
type CriticalCheck = (typeof CRITICAL_CHECKS)[number];

class TimeoutError extends Error {
  constructor() {
    super('timeout');
  }
}

export interface HealthServiceOptions {
  store: Pick<EscrowStore, 'list'>;
  rpc: HealthRpcClient;
  /** Configured Stellar network name, used to pick the expected passphrase. */
  network?: string;
  /** Explicit passphrase override (STELLAR_NETWORK_PASSPHRASE). */
  networkPassphrase?: string;
  contractId?: string;
  /** Per-check timeout in ms (HEALTH_CHECK_TIMEOUT_MS, default 2000). */
  timeoutMs?: number;
  /** Result cache lifetime in ms (HEALTH_CACHE_MS, default 10000). */
  cacheMs?: number;
  now?: () => number;
}

export class HealthService {
  private readonly store: Pick<EscrowStore, 'list'>;
  private readonly rpc: HealthRpcClient;
  private readonly network: string;
  private readonly expectedPassphrase: string | undefined;
  private readonly contractId: string;
  private readonly timeoutMs: number;
  private readonly cacheMs: number;
  private readonly now: () => number;

  private cached: { report: ReadinessReport; expiresAt: number } | undefined;
  private inflight: Promise<ReadinessReport> | undefined;
  private last: ReadinessReport | undefined;

  constructor(opts: HealthServiceOptions) {
    this.store = opts.store;
    this.rpc = opts.rpc;
    this.network = opts.network ?? config.network;
    this.expectedPassphrase =
      opts.networkPassphrase ?? NETWORK_PASSPHRASES[this.network];
    this.contractId = opts.contractId ?? config.contractId;
    this.timeoutMs = opts.timeoutMs ?? config.healthCheckTimeoutMs;
    this.cacheMs = opts.cacheMs ?? config.healthCacheMs;
    this.now = opts.now ?? Date.now;
  }

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Report of the last readiness run, if any — surfaced by `GET /health`. */
  lastReport(): ReadinessReport | undefined {
    return this.last;
  }

  /** Runs readiness (cached, single-flight) and maps it to an HTTP status. */
  async ready(): Promise<{ httpStatus: 200 | 503; report: ReadinessReport }> {
    const report = await this.report();
    return { httpStatus: report.status === 'unready' ? 503 : 200, report };
  }

  private async report(): Promise<ReadinessReport> {
    if (this.cached && this.now() < this.cached.expiresAt) return this.cached.report;
    if (!this.inflight) {
      this.inflight = this.runChecks().then((report) => {
        this.cached = { report, expiresAt: this.now() + this.cacheMs };
        this.last = report;
        this.inflight = undefined;
        return report;
      });
    }
    return this.inflight;
  }

  private async runChecks(): Promise<ReadinessReport> {
    const results = await Promise.all(
      CRITICAL_CHECKS.map(async (name) => [name, await this.timed(name)] as const),
    );
    const checks = Object.fromEntries(results);
    const unready = CRITICAL_CHECKS.some((name) => checks[name]?.status === 'fail');
    const warned = Object.values(checks).some((result) => result.status === 'warn');
    return {
      status: unready ? 'unready' : warned ? 'degraded' : 'ready',
      checks,
      checkedAt: new Date(this.now()).toISOString(),
    };
  }

  private async timed(name: CriticalCheck): Promise<CheckResult> {
    const started = this.now();
    try {
      const outcome = await this.withTimeout(this.runCheck(name));
      return { ...outcome, latencyMs: this.since(started) };
    } catch (err) {
      return {
        status: 'fail',
        latencyMs: this.since(started),
        detail: err instanceof TimeoutError ? 'timeout' : 'check raised',
      };
    }
  }

  private withTimeout<T>(pending: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new TimeoutError()), this.timeoutMs);
      timer.unref?.();
      pending.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private since(started: number): number {
    return Math.max(0, this.now() - started);
  }

  private runCheck(name: CriticalCheck): Promise<{ status: CheckStatus; detail?: string }> {
    switch (name) {
      case 'rpc':
        return this.checkRpc();
      case 'network':
        return this.checkNetwork();
      case 'contract':
        return this.checkContract();
      case 'storage':
        return this.checkStorage();
    }
  }

  private async checkRpc(): Promise<{ status: CheckStatus; detail?: string }> {
    const status = await this.rpc.getHealth();
    if (status === 'healthy') return { status: 'pass' };
    return { status: 'fail', detail: `rpc reported '${status}'` };
  }

  private async checkNetwork(): Promise<{ status: CheckStatus; detail?: string }> {
    if (!this.expectedPassphrase) {
      return {
        status: 'fail',
        detail: `no passphrase known for network '${this.network}' (set STELLAR_NETWORK_PASSPHRASE)`,
      };
    }
    const actual = await this.rpc.getNetworkPassphrase();
    if (actual === this.expectedPassphrase) return { status: 'pass' };
    return {
      status: 'fail',
      detail: `passphrase mismatch: configured '${this.network}', rpc reported '${actual}'`,
    };
  }

  private async checkContract(): Promise<{ status: CheckStatus; detail?: string }> {
    const exists = await this.rpc.hasContractInstance(this.contractId);
    if (exists) return { status: 'pass' };
    return { status: 'fail', detail: 'contract instance ledger entry not found' };
  }

  private async checkStorage(): Promise<{ status: CheckStatus; detail?: string }> {
    try {
      this.store.list();
      return { status: 'pass' };
    } catch {
      return { status: 'fail', detail: 'store read failed' };
    }
  }
}

/**
 * Default RPC client backed by `@stellar/stellar-sdk`, loaded lazily so the
 * SDK is only pulled in when a readiness check actually runs.
 */
export function createSorobanRpcClient(rpcUrl: string): HealthRpcClient {
  type Server = {
    getHealth(): Promise<{ status: string }>;
    getNetwork(): Promise<{ passphrase: string }>;
    getLedgerEntries(...keys: unknown[]): Promise<{ entries?: unknown[] | null }>;
  };
  type Stellar = {
    rpc: { Server: new (url: string, opts?: { allowHttp?: boolean }) => Server };
    Address: new (id: string) => { toScAddress(): unknown };
    xdr: Record<string, any>;
  };

  let stellar: Stellar | undefined;
  let server: Server | undefined;

  const load = (): Stellar => {
    if (!stellar) stellar = require('@stellar/stellar-sdk') as Stellar;
    return stellar;
  };
  const getServer = (): Server => {
    if (!server) {
      server = new (load().rpc.Server)(rpcUrl, { allowHttp: !rpcUrl.startsWith('https://') });
    }
    return server;
  };

  return {
    getHealth: async () => (await getServer().getHealth()).status,
    getNetworkPassphrase: async () => (await getServer().getNetwork()).passphrase,
    hasContractInstance: async (contractId: string): Promise<boolean> => {
      const { Address, xdr } = load();
      const key = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: new Address(contractId).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
      const { entries } = await getServer().getLedgerEntries(key);
      return Array.isArray(entries) && entries.length > 0;
    },
  };
}
