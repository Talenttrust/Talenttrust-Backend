import { createChainReader, ChainStatusClient } from '../src/stellar/chain-status';

const ADMIN = 'GA7TXEBMEPQCLHIYCWDN7RKAO5IMRD2UV7O7TZXMEW6VZUMEXNR4XBB5';

function makeClient(overrides: Partial<ChainStatusClient> = {}): { client: ChainStatusClient } {
  const client: ChainStatusClient = {
    getLatestLedger: jest.fn(async () => 5293191),
    simulateRead: jest.fn(async (method: string) => {
      switch (method) {
        case 'version': return 1;
        case 'is_paused': return false;
        case 'contract_count': return 3n;
        case 'get_admin': return ADMIN;
        default: throw new Error(`unexpected method ${method}`);
      }
    }),
    ...overrides,
  };
  return { client };
}

describe('createChainReader', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('serves cached data within the TTL (client called once for N requests)', async () => {
    const { client } = makeClient();
    const reader = createChainReader(client, { ttlMs: 15000, refreshMinIntervalMs: 5000 });

    for (let i = 0; i < 10; i++) {
      const status = await reader.getStatus();
      expect(status.reachable).toBe(true);
      expect(status.version).toBe('1');
      expect(status.paused).toBe(false);
      expect(status.contractCount).toBe(3);
      expect(status.admin).toBe(ADMIN);
      expect(status.stale).toBe(false);
      jest.advanceTimersByTime(1000);
    }
    expect(client.getLatestLedger).toHaveBeenCalledTimes(1);
  });

  it('shares a single in-flight fetch across concurrent requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ledger = jest.fn(async () => {
      await gate;
      return 5293191;
    });
    const { client } = makeClient({ getLatestLedger: ledger });
    const reader = createChainReader(client, { ttlMs: 15000 });

    const pending = Promise.all(Array.from({ length: 10 }, () => reader.getStatus()));
    release();
    const statuses = await pending;

    expect(ledger).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(10);
    for (const status of statuses) {
      expect(status.reachable).toBe(true);
      expect(status.latestLedger).toBe(5293191);
    }
  });

  it('serves the last good snapshot with stale=true when the RPC fails', async () => {
    const { client } = makeClient();
    const reader = createChainReader(client, { ttlMs: 5000, refreshMinIntervalMs: 0 });

    await reader.getStatus();
    jest.advanceTimersByTime(6000);

    client.getLatestLedger = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED https://soroban-testnet.stellar.org');
    });
    client.simulateRead = jest.fn(async () => {
      throw new Error('connect ECONNREFUSED https://soroban-testnet.stellar.org');
    });

    const stale = await reader.getStatus();
    expect(stale.reachable).toBe(true);
    expect(stale.stale).toBe(true);
    expect(stale.version).toBe('1');
    expect(stale.contractCount).toBe(3);
    expect(stale.error).toContain('ECONNREFUSED');
    expect(stale.error).not.toContain('https://');
  });

  it('reports reachable=false with an error when there is no cached snapshot', async () => {
    const { client } = makeClient({
      getLatestLedger: jest.fn(async () => {
        throw new Error('fetch failed');
      }),
      simulateRead: jest.fn(async () => {
        throw new Error('fetch failed');
      }),
    });
    const reader = createChainReader(client, { ttlMs: 5000 });

    const status = await reader.getStatus();
    expect(status.reachable).toBe(false);
    expect(status.stale).toBe(false);
    expect(status.error).toBe('fetch failed');
    expect(status.latestLedger).toBeUndefined();
  });

  it('bypasses the cache on refresh=true but throttles refreshes to the interval', async () => {
    const { client } = makeClient();
    const reader = createChainReader(client, { ttlMs: 60000, refreshMinIntervalMs: 5000 });

    await reader.getStatus();
    expect(client.getLatestLedger).toHaveBeenCalledTimes(1);

    // Within TTL a plain request is cached.
    await reader.getStatus();
    expect(client.getLatestLedger).toHaveBeenCalledTimes(1);

    // refresh=true bypasses the (still fresh) cache.
    jest.advanceTimersByTime(1000);
    await reader.getStatus({ refresh: true });
    expect(client.getLatestLedger).toHaveBeenCalledTimes(2);

    // A second refresh inside the 5s window is throttled to the cache.
    jest.advanceTimersByTime(1000);
    const throttled = await reader.getStatus({ refresh: true });
    expect(client.getLatestLedger).toHaveBeenCalledTimes(2);
    expect(throttled.reachable).toBe(true);

    // After the window another refresh is allowed.
    jest.advanceTimersByTime(4001);
    await reader.getStatus({ refresh: true });
    expect(client.getLatestLedger).toHaveBeenCalledTimes(3);
  });

  it('yields reachable=false within the timeout when a client call never resolves', async () => {
    jest.useRealTimers();
    const { client } = makeClient({
      getLatestLedger: () => new Promise(() => {}),
    });
    const reader = createChainReader(client, { ttlMs: 60000, timeoutMs: 50 });

    const started = Date.now();
    const status = await reader.getStatus();
    const elapsed = Date.now() - started;

    expect(status.reachable).toBe(false);
    expect(status.error).toContain('timed out');
    expect(elapsed).toBeLessThan(500);
  });

  it('does not mark a stale snapshot as refreshed after a failed fetch', async () => {
    const { client } = makeClient();
    const reader = createChainReader(client, { ttlMs: 1000, refreshMinIntervalMs: 0 });

    const first = await reader.getStatus();
    const fetchedAt = first.fetchedAt;
    jest.advanceTimersByTime(2000);
    client.getLatestLedger = jest.fn(async () => {
      throw new Error('boom');
    });
    client.simulateRead = jest.fn(async () => {
      throw new Error('boom');
    });

    const stale = await reader.getStatus();
    expect(stale.stale).toBe(true);
    expect(stale.fetchedAt).toBe(fetchedAt);
    expect(stale.error).toBe('boom');
  });
});
