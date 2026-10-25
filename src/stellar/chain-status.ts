import { config } from '../config';
import { ContractReader, RpcError, sanitizeRpcError, withTimeout } from './rpc';

export interface OnChainStatus {
  reachable: boolean;
  latestLedger?: number;
  version?: string;
  paused?: boolean;
  contractCount?: number;
  admin?: string;
  fetchedAt: string;
  stale: boolean;
  error?: string;
}

export interface ChainReader {
  getStatus(options?: { refresh?: boolean }): Promise<OnChainStatus>;
}

/** The four contract reads backing `OnChainStatus`. */
export interface ChainStatusClient {
  getLatestLedger(): Promise<number>;
  simulateRead(method: string): Promise<unknown>;
}

export interface ChainReaderOptions {
  ttlMs?: number;
  refreshMinIntervalMs?: number;
  timeoutMs?: number;
}

const toNumber = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new RpcError(`expected a numeric contract value, got ${typeof value}`);
  return n;
};

async function fetchChainStatus(client: ChainStatusClient, timeoutMs: number): Promise<OnChainStatus> {
  const [latestLedger, version, paused, contractCount, admin] = await withTimeout(
    Promise.all([
      client.getLatestLedger(),
      client.simulateRead('version'),
      client.simulateRead('is_paused'),
      client.simulateRead('contract_count'),
      client.simulateRead('get_admin'),
    ]),
    timeoutMs,
    'chain status fetch',
  );
  return {
    reachable: true,
    latestLedger: toNumber(latestLedger),
    version: String(version),
    paused: Boolean(paused),
    contractCount: toNumber(contractCount),
    admin: String(admin),
    fetchedAt: new Date().toISOString(),
    stale: false,
  };
}

/**
 * Cached, single-flight chain reader.
 *
 * - Fresh results are served from an in-memory cache for `ttlMs`.
 * - Concurrent callers share one in-flight RPC fetch.
 * - When the RPC fails, the last good snapshot is served with `stale: true`;
 *   with no snapshot at all the reader reports `reachable: false` (it never
 *   rejects, so the endpoint can always answer 200).
 * - `refresh: true` bypasses the cache, but at most once per
 *   `refreshMinIntervalMs` so clients cannot force unbounded RPC traffic.
 */
export function createChainReader(client: ChainStatusClient, options: ChainReaderOptions = {}): ChainReader {
  const ttlMs = options.ttlMs ?? config.chainStatusTtlMs;
  const refreshMinIntervalMs = options.refreshMinIntervalMs ?? config.chainRefreshMinIntervalMs;
  const timeoutMs = options.timeoutMs ?? config.rpcTimeoutMs;

  let cache: OnChainStatus | null = null;
  let cachedAt = 0;
  let inFlight: Promise<OnChainStatus> | null = null;
  let lastForcedAt: number | null = null;

  const fetchOnce = (): Promise<OnChainStatus> => {
    if (!inFlight) {
      inFlight = fetchChainStatus(client, timeoutMs).then(
        (status) => {
          cache = status;
          cachedAt = Date.now();
          return status;
        },
        (err: unknown) => {
          const error = sanitizeRpcError(err);
          if (cache) return { ...cache, stale: true, error };
          return { reachable: false, stale: false, error, fetchedAt: new Date().toISOString() };
        },
      ).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };

  return {
    getStatus({ refresh = false } = {}): Promise<OnChainStatus> {
      const now = Date.now();
      const forced = refresh && (lastForcedAt === null || now - lastForcedAt >= refreshMinIntervalMs);
      if (forced) {
        lastForcedAt = now;
        return fetchOnce();
      }
      if (cache && now - cachedAt < ttlMs) return Promise.resolve(cache);
      return fetchOnce();
    },
  };
}

/** Production reader wired from config. */
export function createStellarChainReader(): ChainReader {
  return createChainReader(
    new ContractReader({
      rpcUrl: config.rpcUrl,
      contractId: config.contractId,
      network: config.network,
      timeoutMs: config.rpcTimeoutMs,
    }),
    {
      ttlMs: config.chainStatusTtlMs,
      refreshMinIntervalMs: config.chainRefreshMinIntervalMs,
      timeoutMs: config.rpcTimeoutMs,
    },
  );
}
