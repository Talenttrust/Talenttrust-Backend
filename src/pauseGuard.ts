import { config } from './config';

export type PauseSource = 'chain' | 'env' | 'none';

export interface PauseStatus {
  paused: boolean;
  source: PauseSource;
  checkedAt: string;
}

export type RpcReader = () => Promise<boolean>;

/**
 * Routes corresponding to the Soroban contract functions that call `require_not_paused`:
 * - create_contract (https://github.com/Talenttrust/Talenttrust-Contracts/blob/402c6b2ed37db4ba4c7991dc68717a60404d867d/contracts/escrow/src/lib.rs#L197)
 * - deposit_funds (https://github.com/Talenttrust/Talenttrust-Contracts/blob/402c6b2ed37db4ba4c7991dc68717a60404d867d/contracts/escrow/src/lib.rs#L241)
 * - release_milestone (https://github.com/Talenttrust/Talenttrust-Contracts/blob/402c6b2ed37db4ba4c7991dc68717a60404d867d/contracts/escrow/src/lib.rs#L275)
 * - open_dispute (https://github.com/Talenttrust/Talenttrust-Contracts/blob/402c6b2ed37db4ba4c7991dc68717a60404d867d/contracts/escrow/src/lib.rs#L312)
 * - cancel_contract (https://github.com/Talenttrust/Talenttrust-Contracts/blob/402c6b2ed37db4ba4c7991dc68717a60404d867d/contracts/escrow/src/lib.rs#L355)
 *
 * Notice `resolve` and `reputation` do NOT call `require_not_paused` on-chain and are not guarded.
 */
export const CONTRACT_GUARDED_FUNCTIONS = [
  'create_contract',
  'deposit_funds',
  'release_milestone',
  'open_dispute',
  'cancel_contract',
] as const;

export const GUARDED_ROUTES = [
  'POST /api/v1/contracts',
  'POST /api/v1/contracts/:id/deposit',
  'POST /api/v1/contracts/:id/milestones/:index/release',
  'POST /api/v1/contracts/:id/dispute',
  'POST /api/v1/contracts/:id/cancel',
] as const;

/**
 * Default RPC reader: simulates the escrow contract's read-only `is_paused()`
 * via Soroban RPC (no signature or fee needed) and returns its boolean result.
 * Rejects on RPC/simulation errors so the guard can apply PAUSE_FAIL_MODE.
 */
export async function defaultRpcReader(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const StellarSdk = require('@stellar/stellar-sdk');
  const networkPassphrase = config.network === 'mainnet' ? StellarSdk.Networks.PUBLIC : StellarSdk.Networks.TESTNET;
  const server = new StellarSdk.rpc.Server(config.rpcUrl, { timeout: 5000 });
  // Simulation only needs a syntactically valid source account; it is never signed or submitted.
  const source = new StellarSdk.Account('GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7', '0');
  const tx = new StellarSdk.TransactionBuilder(source, { fee: '100', networkPassphrase })
    .addOperation(new StellarSdk.Contract(config.contractId).call('is_paused'))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (StellarSdk.rpc.Api.isSimulationError(sim)) throw new Error(String(sim.error));
  const retval = sim.result?.retval;
  return retval ? Boolean(StellarSdk.scValToNative(retval)) : false;
}

export interface PauseGuardOptions {
  rpcReader?: RpcReader;
  ttlMs?: number;
  failMode?: 'open' | 'closed';
  apiPaused?: boolean;
}

export class PauseGuard {
  private rpcReader: RpcReader;
  private ttlMs: number;
  private failMode: 'open' | 'closed';
  private cachedChainPaused: boolean | null = null;
  private lastCheckedAt: number = 0;
  private inFlightPromise: Promise<boolean> | null = null;

  private injectedReader: boolean;
  private forcePaused: boolean;

  constructor(options: PauseGuardOptions = {}) {
    this.forcePaused = options.apiPaused === true;
    this.injectedReader = options.rpcReader !== undefined;
    this.rpcReader = options.rpcReader ?? defaultRpcReader;
    this.ttlMs = options.ttlMs ?? config.pauseCheckTtlMs;
    this.failMode = options.failMode ?? config.pauseFailMode;
  }

  async isPaused(): Promise<PauseStatus> {
    const now = Date.now();
    const checkedAt = new Date(now).toISOString();

    // 1. Check operator override (env)
    const isEnvPaused = this.forcePaused || process.env.API_PAUSED === 'true' || config.apiPaused;
    if (isEnvPaused) {
      return {
        paused: true,
        source: 'env',
        checkedAt,
      };
    }

    // Chain probe disabled (PAUSE_CHECK_CHAIN=false): only the operator override applies.
    if (!this.checkChain()) {
      return { paused: false, source: 'none', checkedAt };
    }

    // 2. Check cached chain pause status
    const isCacheValid = this.cachedChainPaused !== null && now - this.lastCheckedAt < this.ttlMs;

    if (isCacheValid) {
      return {
        paused: this.cachedChainPaused!,
        source: this.cachedChainPaused ? 'chain' : 'none',
        checkedAt: new Date(this.lastCheckedAt).toISOString(),
      };
    }

    // 3. Fetch from RPC with caching & single-flight coalescing
    try {
      if (!this.inFlightPromise) {
        this.inFlightPromise = this.rpcReader().finally(() => {
          this.inFlightPromise = null;
        });
      }
      const chainPaused = await this.inFlightPromise;
      this.cachedChainPaused = chainPaused;
      this.lastCheckedAt = Date.now();

      return {
        paused: chainPaused,
        source: chainPaused ? 'chain' : 'none',
        checkedAt: new Date(this.lastCheckedAt).toISOString(),
      };
    } catch (err) {
      // Handle RPC failure according to failMode
      const failClosed = (process.env.PAUSE_FAIL_MODE ?? this.failMode) === 'closed';
      if (failClosed) {
        return {
          paused: true,
          source: 'chain',
          checkedAt,
        };
      } else {
        // fail-open
        return {
          paused: false,
          source: 'none',
          checkedAt,
        };
      }
    }
  }

  /** Last known status without waiting on RPC (for /health); refreshes in the background when stale. */
  peek(): PauseStatus {
    const now = Date.now();
    if (this.forcePaused || process.env.API_PAUSED === 'true' || config.apiPaused) {
      return { paused: true, source: 'env', checkedAt: new Date(now).toISOString() };
    }
    if (this.checkChain() && (this.cachedChainPaused === null || now - this.lastCheckedAt >= this.ttlMs)) {
      void this.isPaused().catch(() => undefined);
    }
    const paused = this.cachedChainPaused === true;
    return {
      paused,
      source: paused ? 'chain' : 'none',
      checkedAt: new Date(this.lastCheckedAt || now).toISOString(),
    };
  }

  private checkChain(): boolean {
    return this.injectedReader || process.env.PAUSE_CHECK_CHAIN !== 'false';
  }

  clearCache(): void {
    this.cachedChainPaused = null;
    this.lastCheckedAt = 0;
    this.inFlightPromise = null;
  }
}
