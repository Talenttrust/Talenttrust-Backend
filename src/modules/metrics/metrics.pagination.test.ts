import {
  InvalidMetricsCursorError,
  METRICS_DEFAULT_PAGE_SIZE,
  METRICS_MAX_PAGE_SIZE,
  paginateMetrics,
  resolveMetricsPageSize,
} from './metrics.pagination';

interface TestMetric {
  id: string;
  createdAt: string;
  name: string;
}

function metrics(count: number): TestMetric[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `metric-${String(index + 1).padStart(3, '0')}`,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
    name: `metric-${index + 1}`,
  }));
}

describe('metrics cursor pagination', () => {
  it('uses the default page size', () => {
    expect(resolveMetricsPageSize(undefined)).toBe(METRICS_DEFAULT_PAGE_SIZE);
    expect(resolveMetricsPageSize('')).toBe(METRICS_DEFAULT_PAGE_SIZE);
  });

  it('clamps an over-limit request to the maximum page size', () => {
    expect(resolveMetricsPageSize(METRICS_MAX_PAGE_SIZE + 50)).toBe(METRICS_MAX_PAGE_SIZE);
  });

  it('falls back to the default for invalid limits', () => {
    expect(resolveMetricsPageSize('not-a-number')).toBe(METRICS_DEFAULT_PAGE_SIZE);
    expect(resolveMetricsPageSize(0)).toBe(METRICS_DEFAULT_PAGE_SIZE);
    expect(resolveMetricsPageSize(-1)).toBe(METRICS_DEFAULT_PAGE_SIZE);
  });

  it('clamps a positive fractional limit to one item', () => {
    expect(resolveMetricsPageSize(0.5)).toBe(1);
  });

  it('returns an empty page without a cursor for an empty set', () => {
    expect(paginateMetrics([], { limit: 10 })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('returns exactly one page and no next cursor at the page boundary', () => {
    const result = paginateMetrics(metrics(3), { limit: 3 }, 'status=active');

    expect(result.items.map((item) => item.id)).toEqual([
      'metric-001',
      'metric-002',
      'metric-003',
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it('returns subsequent pages without changing item shape', () => {
    const first = paginateMetrics(metrics(5), { limit: 2 }, 'type=gauge');
    const second = paginateMetrics(
      metrics(5),
      { limit: 2, cursor: first.nextCursor ?? undefined },
      'type=gauge',
    );

    expect(first.items).toHaveLength(2);
    expect(second.items.map((item) => item.id)).toEqual(['metric-003', 'metric-004']);
    expect(second.items[0]).toEqual(metrics(5)[2]);
    expect(second.nextCursor).not.toBeNull();
  });

  it('keeps filters bound to the cursor across pages', () => {
    const first = paginateMetrics(metrics(3), { limit: 1 }, 'status=active');

    expect(() => paginateMetrics(
      metrics(3),
      { limit: 1, cursor: first.nextCursor ?? undefined },
      'status=inactive',
    )).toThrow(InvalidMetricsCursorError);
  });

  it('rejects malformed cursors', () => {
    expect(() => paginateMetrics(metrics(2), { cursor: 'invalid!' }, ''))
      .toThrow(InvalidMetricsCursorError);
  });

  it('rejects an explicitly empty cursor', () => {
    expect(() => paginateMetrics(metrics(2), { cursor: '' }, ''))
      .toThrow(InvalidMetricsCursorError);
  });

  it('produces a stable cursor for the same records and filters', () => {
    const records = metrics(3);
    const first = paginateMetrics(records, { limit: 1 }, 'status=active');
    const repeated = paginateMetrics(records, { limit: 1 }, 'status=active');

    expect(repeated.nextCursor).toBe(first.nextCursor);
  });

  it('uses the id as a deterministic tie-breaker for equal timestamps', () => {
    const records: TestMetric[] = [
      { id: 'b', createdAt: '2026-01-01T00:00:00.000Z', name: 'b' },
      { id: 'a', createdAt: '2026-01-01T00:00:00.000Z', name: 'a' },
    ];

    expect(paginateMetrics(records, { limit: 1 }).items[0].id).toBe('a');
  });
});
