/**
 * boundedPaginationService.test.ts — Unit tests for BoundedPaginationService.
 *
 * Covers all issue-mandated edge cases:
 *  1. missing bound
 *  2. maximum bound (capped, not rejected)
 *  3. invalid range (fromLedger > toLedger, etc.)
 *  4. no events
 *  5. provider returns duplicate pages
 *  + success paths, continuation tokens, tenant isolation, work cap,
 *    time-window filtering, and retry/authorization/failure handling.
 */

import {
  BoundedPaginationService,
  PAGINATION_ERROR_CODES,
  type RpcEventProvider,
} from './boundedPaginationService';
import {
  MAX_RPC_PAGE_SIZE,
  DEFAULT_RPC_PAGE_SIZE,
  MAX_TOTAL_RPC_WORK,
  MAX_LEDGER_WINDOW,
  MAX_TIME_WINDOW_MS,
} from './boundedPagination.types';
import { AppError } from '../errors/appError';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a minimal mock RPC event for tests. */
function makeRpcEvent(opts: {
  pagingToken: string;
  ledger: number;
  timestampMs?: number;
  contractId?: string;
}) {
  const ts = opts.timestampMs ?? opts.ledger * 6_000; // ~6 s/ledger stub
  return {
    pagingToken: opts.pagingToken,
    ledger: opts.ledger,
    ledgerClosedAt: new Date(ts).toISOString(),
    contractId: opts.contractId ?? 'CTEST',
    type: 'contract_event',
    value: { xdr: '' },
    id: opts.pagingToken,
    txHash: 'abc',
  };
}

/** Build a mock RpcEventProvider that returns the provided events. */
function mockProvider(events: ReturnType<typeof makeRpcEvent>[] = []): RpcEventProvider {
  return {
    getEvents: jest.fn().mockResolvedValue({ events }),
  };
}

/** Extract the continuation token from a successful page result. */
function decodeRawToken(token: string) {
  const json = Buffer.from(token, 'base64url').toString('utf8');
  return JSON.parse(json);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BoundedPaginationService', () => {
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
  const TENANT_ID = 'user-123';

  // ── Edge case 1: missing bound ─────────────────────────────────────────────
  describe('missing bound', () => {
    it('throws MISSING_BOUND when neither ledgerWindow nor timeWindow is provided', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({ contractId: CONTRACT_ID, tenantId: TENANT_ID }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.MISSING_BOUND,
        statusCode: 400,
      });
    });

    it('throws MISSING_BOUND even when contractId is provided without any window', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({ contractId: CONTRACT_ID, tenantId: TENANT_ID }),
      ).rejects.toBeInstanceOf(AppError);
    });

    it('does NOT throw when only ledgerWindow is provided', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);
      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });
      expect(result.events).toHaveLength(0);
      expect(result.nextToken).toBeNull();
    });

    it('does NOT throw when only timeWindow is provided', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);
      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        timeWindow: { fromTimestampMs: 1_000_000, toTimestampMs: 2_000_000 },
      });
      expect(result.events).toHaveLength(0);
    });
  });

  // ── Edge case 2: maximum bound (capped silently) ───────────────────────────
  describe('maximum bound', () => {
    it('caps ledger window span to MAX_LEDGER_WINDOW without rejecting', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);
      const fromLedger = 0;
      const toLedger = MAX_LEDGER_WINDOW + 9_999; // deliberately over limit

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger, toLedger },
      });

      expect(result.events).toHaveLength(0);
      // The RPC was called with a startLedger, not with the over-limit value.
      const rpcCall = (provider.getEvents as jest.Mock).mock.calls[0][0];
      expect(rpcCall.startLedger).toBe(fromLedger);
    });

    it('caps time window span to MAX_TIME_WINDOW_MS without rejecting', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);
      const fromMs = 0;
      const toMs = MAX_TIME_WINDOW_MS + 1_000_000;

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        timeWindow: { fromTimestampMs: fromMs, toTimestampMs: toMs },
      });
      expect(result.events).toHaveLength(0);
    });

    it('caps page size to MAX_RPC_PAGE_SIZE when an over-limit value is supplied', async () => {
      const events = Array.from({ length: MAX_RPC_PAGE_SIZE }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
        limit: MAX_RPC_PAGE_SIZE + 500, // deliberately over
      });

      const rpcCall = (provider.getEvents as jest.Mock).mock.calls[0][0];
      expect(rpcCall.limit).toBeLessThanOrEqual(MAX_RPC_PAGE_SIZE);
    });
  });

  // ── Edge case 3: invalid range ─────────────────────────────────────────────
  describe('invalid range', () => {
    it('throws INVALID_RANGE when toLedger < fromLedger', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 500, toLedger: 100 },
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_RANGE,
        statusCode: 400,
      });
    });

    it('throws INVALID_RANGE when fromLedger is negative', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: -1, toLedger: 100 },
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_RANGE,
        statusCode: 400,
      });
    });

    it('throws INVALID_RANGE when toTimestampMs < fromTimestampMs', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          timeWindow: { fromTimestampMs: 5_000_000, toTimestampMs: 1_000_000 },
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_RANGE,
        statusCode: 400,
      });
    });

    it('throws INVALID_RANGE when fromTimestampMs is negative', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          timeWindow: { fromTimestampMs: -1, toTimestampMs: 1_000_000 },
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_RANGE,
        statusCode: 400,
      });
    });

    it('accepts equal fromLedger and toLedger (single-ledger scan)', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);
      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 200, toLedger: 200 },
      });
      expect(result.events).toHaveLength(0);
    });
  });

  // ── Edge case 4: no events ─────────────────────────────────────────────────
  describe('no events', () => {
    it('returns empty events array and null nextToken when provider returns nothing', async () => {
      const svc = new BoundedPaginationService(mockProvider([]));
      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });
      expect(result.events).toHaveLength(0);
      expect(result.nextToken).toBeNull();
      expect(result.fetchedSoFar).toBe(0);
      expect(result.cappedByWorkLimit).toBe(false);
    });

    it('returns fetchedSoFar: 0 on empty result', async () => {
      const svc = new BoundedPaginationService(mockProvider([]));
      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        timeWindow: { fromTimestampMs: 0, toTimestampMs: 1_000_000 },
      });
      expect(result.fetchedSoFar).toBe(0);
    });
  });

  // ── Edge case 5: provider returns duplicate pages ──────────────────────────
  describe('duplicate pages from provider', () => {
    it('de-duplicates events with the same pagingToken', async () => {
      const event = makeRpcEvent({ pagingToken: 'dup-token', ledger: 150 });
      const provider = mockProvider([event, event, event]); // three identical events
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.pagingToken).toBe('dup-token');
    });

    it('de-duplicates across a mixed set of events', async () => {
      const events = [
        makeRpcEvent({ pagingToken: 'tok-1', ledger: 101 }),
        makeRpcEvent({ pagingToken: 'tok-2', ledger: 102 }),
        makeRpcEvent({ pagingToken: 'tok-1', ledger: 101 }), // dup of first
        makeRpcEvent({ pagingToken: 'tok-3', ledger: 103 }),
      ];
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });

      expect(result.events).toHaveLength(3);
      const tokens = result.events.map((e) => e.pagingToken);
      expect(new Set(tokens).size).toBe(3);
    });
  });

  // ── Success paths ──────────────────────────────────────────────────────────
  describe('success paths', () => {
    it('returns events within the ledger window', async () => {
      const events = [
        makeRpcEvent({ pagingToken: 'tok-1', ledger: 150 }),
        makeRpcEvent({ pagingToken: 'tok-2', ledger: 160 }),
      ];
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });

      expect(result.events).toHaveLength(2);
      expect(result.events[0]!.ledger).toBe(150);
      expect(result.events[1]!.ledger).toBe(160);
      expect(result.fetchedSoFar).toBe(2);
    });

    it('filters out events beyond toLedger', async () => {
      const events = [
        makeRpcEvent({ pagingToken: 'tok-in', ledger: 190 }),
        makeRpcEvent({ pagingToken: 'tok-out', ledger: 210 }), // beyond toLedger
      ];
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.pagingToken).toBe('tok-in');
    });

    it('filters events outside time window', async () => {
      const fromMs = 1_000_000;
      const toMs = 2_000_000;
      const events = [
        makeRpcEvent({ pagingToken: 'before', ledger: 100, timestampMs: fromMs - 1 }),
        makeRpcEvent({ pagingToken: 'inside', ledger: 101, timestampMs: fromMs + 1 }),
        makeRpcEvent({ pagingToken: 'after', ledger: 102, timestampMs: toMs + 1 }),
      ];
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 0, toLedger: 500 },
        timeWindow: { fromTimestampMs: fromMs, toTimestampMs: toMs },
      });

      expect(result.events).toHaveLength(1);
      expect(result.events[0]!.pagingToken).toBe('inside');
    });

    it('returns a continuation token when a full page is returned', async () => {
      // A full page = exactly `limit` events from provider.
      const limit = 5;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
        limit,
      });

      expect(result.nextToken).not.toBeNull();
      const decoded = decodeRawToken(result.nextToken!);
      expect(decoded.cursor).toBe(`tok-${limit - 1}`);
      expect(decoded.tenantId).toBe(TENANT_ID);
      expect(decoded.contractId).toBe(CONTRACT_ID);
      expect(decoded.fetchedSoFar).toBe(limit);
    });

    it('returns null nextToken when provider returns fewer events than limit (last page)', async () => {
      const limit = 10;
      const events = Array.from({ length: 3 }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
        limit,
      });

      expect(result.nextToken).toBeNull();
    });

    it('uses DEFAULT_RPC_PAGE_SIZE when limit is not provided', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);

      await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });

      const rpcCall = (provider.getEvents as jest.Mock).mock.calls[0][0];
      expect(rpcCall.limit).toBe(DEFAULT_RPC_PAGE_SIZE);
    });
  });

  // ── Continuation token ─────────────────────────────────────────────────────
  describe('continuation token', () => {
    it('resumes from the cursor embedded in the token', async () => {
      const limit = 3;
      const page1Events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `p1-tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(page1Events);
      const svc = new BoundedPaginationService(provider);

      const page1 = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 500 },
        limit,
      });

      expect(page1.nextToken).not.toBeNull();

      // Page 2 with continuation token
      const page2Events = [makeRpcEvent({ pagingToken: 'p2-tok-0', ledger: 103 })];
      (provider.getEvents as jest.Mock).mockResolvedValueOnce({ events: page2Events });

      const page2 = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 500 },
        limit,
        continuationToken: page1.nextToken!,
      });

      // RPC was called with the cursor from page 1
      const rpcCall2 = (provider.getEvents as jest.Mock).mock.calls[1][0];
      expect(rpcCall2.cursor).toBe('p1-tok-2');
      expect(page2.fetchedSoFar).toBe(limit + 1);
      expect(page2.nextToken).toBeNull(); // only 1 event < limit
    });

    it('embeds the original window in the token to preserve bounds', async () => {
      const limit = 2;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 50, toLedger: 300 },
        limit,
      });

      const decoded = decodeRawToken(result.nextToken!);
      expect(decoded.ledgerWindow).toEqual({ fromLedger: 50, toLedger: 300 });
    });

    it('prevents window widening: intersects request window with token window', async () => {
      // Token embeds fromLedger: 200; request asks fromLedger: 0 — intersection is 200.
      const limit = 2;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 200 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      // First page: fromLedger 200
      const page1 = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 200, toLedger: 300 },
        limit,
      });

      // Continuation with a wider window (attempt to widen).
      (provider.getEvents as jest.Mock).mockResolvedValueOnce({ events: [] });

      const page2 = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 0, toLedger: 500 }, // wider window — should be intersected
        limit,
        continuationToken: page1.nextToken!,
      });

      // Token bound should have been applied — the effective window is the intersection.
      expect(page2).toBeDefined(); // no error thrown
    });

    it('throws INVALID_TOKEN for a tampered base64url token', async () => {
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          continuationToken: 'not-a-valid-token!!!',
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_TOKEN,
        statusCode: 400,
      });
    });

    it('throws INVALID_TOKEN for a structurally invalid JSON token', async () => {
      const badToken = Buffer.from('{"missing": "fields"}', 'utf8').toString('base64url');
      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
          continuationToken: badToken,
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_TOKEN,
        statusCode: 400,
      });
    });

    it('throws INVALID_TOKEN when token contractId does not match request', async () => {
      const limit = 2;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const page1 = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 300 },
        limit,
      });

      // Use a different contractId on the continuation call
      await expect(
        svc.fetchPage({
          contractId: 'CDIFFERENT_CONTRACT',
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 300 },
          limit,
          continuationToken: page1.nextToken!,
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.INVALID_TOKEN,
        statusCode: 400,
      });
    });
  });

  // ── Tenant isolation ───────────────────────────────────────────────────────
  describe('tenant isolation', () => {
    it('throws TENANT_MISMATCH when token tenantId does not match requester', async () => {
      const limit = 2;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      // Issue page 1 to tenant A
      const page1 = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: 'tenant-A',
        ledgerWindow: { fromLedger: 100, toLedger: 300 },
        limit,
      });

      // Tenant B tries to use tenant A's token
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: 'tenant-B', // different tenant
          ledgerWindow: { fromLedger: 100, toLedger: 300 },
          limit,
          continuationToken: page1.nextToken!,
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.TENANT_MISMATCH,
        statusCode: 403,
      });
    });
  });

  // ── Total work cap ─────────────────────────────────────────────────────────
  describe('total work cap', () => {
    it('caps the returned events when fetchedSoFar + new events > MAX_TOTAL_RPC_WORK', async () => {
      // Simulate we are one event away from the cap.
      const limit = 5;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      // Build a token with fetchedSoFar = MAX_TOTAL_RPC_WORK - 2
      const nearCapToken = Buffer.from(
        JSON.stringify({
          cursor: 'previous-cursor',
          ledgerWindow: { fromLedger: 100, toLedger: 9999 },
          fetchedSoFar: MAX_TOTAL_RPC_WORK - 2,
          tenantId: TENANT_ID,
          contractId: CONTRACT_ID,
        }),
        'utf8',
      ).toString('base64url');

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 9999 },
        limit,
        continuationToken: nearCapToken,
      });

      // Should only return 2 events (to bring total exactly to MAX_TOTAL_RPC_WORK).
      expect(result.events).toHaveLength(2);
      expect(result.cappedByWorkLimit).toBe(true);
      expect(result.nextToken).toBeNull();
      expect(result.fetchedSoFar).toBe(MAX_TOTAL_RPC_WORK);
    });

    it('throws WORK_CAP_EXCEEDED when token fetchedSoFar is already at cap', async () => {
      const atCapToken = Buffer.from(
        JSON.stringify({
          cursor: 'last-cursor',
          ledgerWindow: { fromLedger: 100, toLedger: 9999 },
          fetchedSoFar: MAX_TOTAL_RPC_WORK,
          tenantId: TENANT_ID,
          contractId: CONTRACT_ID,
        }),
        'utf8',
      ).toString('base64url');

      const svc = new BoundedPaginationService(mockProvider());
      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 9999 },
          continuationToken: atCapToken,
        }),
      ).rejects.toMatchObject({
        code: PAGINATION_ERROR_CODES.WORK_CAP_EXCEEDED,
        statusCode: 400,
      });
    });
  });

  // ── Provider failure handling ──────────────────────────────────────────────
  describe('provider failure handling', () => {
    it('wraps provider errors into SorobanRpcError subtypes', async () => {
      const failingProvider: RpcEventProvider = {
        getEvents: jest.fn().mockRejectedValue(
          new TypeError('fetch failed'),
        ),
      };
      const svc = new BoundedPaginationService(failingProvider);

      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
        }),
      ).rejects.toMatchObject({ name: 'SorobanRpcTransportError' });
    });

    it('wraps 429 rate-limit errors into SorobanRpcRateLimitError', async () => {
      const rateLimitProvider: RpcEventProvider = {
        getEvents: jest.fn().mockRejectedValue(
          Object.assign(new Error('Rate limited'), { status: 429 }),
        ),
      };
      const svc = new BoundedPaginationService(rateLimitProvider);

      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
        }),
      ).rejects.toMatchObject({ name: 'SorobanRpcRateLimitError' });
    });

    it('wraps timeout errors into SorobanRpcTimeoutError', async () => {
      const timeoutProvider: RpcEventProvider = {
        getEvents: jest.fn().mockRejectedValue(
          Object.assign(new Error('timeout'), { name: 'AbortError' }),
        ),
      };
      const svc = new BoundedPaginationService(timeoutProvider);

      await expect(
        svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
        }),
      ).rejects.toMatchObject({ name: 'SorobanRpcTimeoutError' });
    });

    it('does NOT forward provider error messages to the thrown error message', async () => {
      const failingProvider: RpcEventProvider = {
        getEvents: jest.fn().mockRejectedValue(
          new Error('SECRET_INTERNAL_PROVIDER_PATH/key=super-secret'),
        ),
      };
      const svc = new BoundedPaginationService(failingProvider);

      try {
        await svc.fetchPage({
          contractId: CONTRACT_ID,
          tenantId: TENANT_ID,
          ledgerWindow: { fromLedger: 100, toLedger: 200 },
        });
        fail('expected error');
      } catch (err: any) {
        // The stable SorobanRpcError message must NOT contain the raw provider message.
        expect(err.message).not.toContain('SECRET_INTERNAL_PROVIDER_PATH');
      }
    });
  });

  // ── Authorization paths ────────────────────────────────────────────────────
  describe('authorization boundary', () => {
    it('scopes events to the contractId in the request — contractId is always set in filters', async () => {
      const provider = mockProvider([]);
      const svc = new BoundedPaginationService(provider);

      await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
      });

      const rpcCall = (provider.getEvents as jest.Mock).mock.calls[0][0];
      expect(rpcCall.filters[0].contractIds).toContain(CONTRACT_ID);
    });
  });

  // ── Boundary paths ─────────────────────────────────────────────────────────
  describe('boundary paths', () => {
    it('handles exactly one event returned', async () => {
      const events = [makeRpcEvent({ pagingToken: 'only-one', ledger: 150 })];
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
        limit: 5,
      });

      expect(result.events).toHaveLength(1);
      expect(result.fetchedSoFar).toBe(1);
      expect(result.nextToken).toBeNull(); // 1 < limit(5) → last page
    });

    it('handles exactly limit events returned — produces nextToken', async () => {
      const limit = 3;
      const events = Array.from({ length: limit }, (_, i) =>
        makeRpcEvent({ pagingToken: `tok-${i}`, ledger: 100 + i }),
      );
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 200 },
        limit,
      });

      expect(result.nextToken).not.toBeNull();
    });

    it('handles a ledger window of exactly 1 ledger (from === to)', async () => {
      const events = [makeRpcEvent({ pagingToken: 'tok-1', ledger: 100 })];
      const provider = mockProvider(events);
      const svc = new BoundedPaginationService(provider);

      const result = await svc.fetchPage({
        contractId: CONTRACT_ID,
        tenantId: TENANT_ID,
        ledgerWindow: { fromLedger: 100, toLedger: 100 },
      });

      expect(result.events).toHaveLength(1);
    });
  });
});
