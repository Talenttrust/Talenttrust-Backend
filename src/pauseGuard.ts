import http from 'http';
import https from 'https';
import { URL } from 'url';
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
 * Default RPC reader that queries Soroban RPC via JSON-RPC `simulateTransaction`
 * or returns false if cannot parse or contract not deployed.
 */
export async function defaultRpcReader(): Promise<boolean> {
  const rpcUrl = config.rpcUrl;
  const parsedUrl = new URL(rpcUrl);
  const client = parsedUrl.protocol === 'https:' ? https : http;

  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'simulateTransaction',
    params: {
      // Contract call simulation payload or getContractData if supported
      // For general Soroban JSON-RPC simulateTransaction or getHealth
      contractId: config.contractId,
    },
  });

  return new Promise((resolve, reject) => {
    const req = client.request(
      parsedUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              const json = JSON.parse(data);
              if (json.error) {
                // If RPC returns an error
                reject(new Error(json.error.message || 'RPC error'));
                return;
              }
              // Parse boolean result from simulation if present
              // By default if simulateTransaction returns false / unpaused
              resolve(Boolean(json.result?.paused ?? false));
            } else {
              reject(new Error(`RPC responded with status ${res.statusCode}`));
            }
          } catch (e) {
            reject(e);
          }
        });
      },
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('RPC request timed out'));
    });

    req.write(payload);
    req.end();
  });
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

  constructor(options: PauseGuardOptions = {}) {
    this.rpcReader = options.rpcReader ?? defaultRpcReader;
    this.ttlMs = options.ttlMs ?? config.pauseCheckTtlMs;
    this.failMode = options.failMode ?? config.pauseFailMode;
  }

  async isPaused(): Promise<PauseStatus> {
    const now = Date.now();
    const checkedAt = new Date(now).toISOString();

    // 1. Check operator override (env)
    const isEnvPaused = process.env.API_PAUSED === 'true' || config.apiPaused;
    if (isEnvPaused) {
      return {
        paused: true,
        source: 'env',
        checkedAt,
      };
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

  clearCache(): void {
    this.cachedChainPaused = null;
    this.lastCheckedAt = 0;
    this.inFlightPromise = null;
  }
}
