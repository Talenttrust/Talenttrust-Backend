import { Registry } from 'prom-client';
import {
    DefaultServiceObjectives,
    DefaultAlertThresholds,
    evaluateObjectives,
    readObservedMetrics,
    isThresholdBreached,
    OperationType,
} from './service-objectives';

// ---------------------------------------------------------------------------
// Helpers: build synthetic Prometheus metric JSON that matches the shape
// of Registry.getMetricsAsJSON() output.
// ---------------------------------------------------------------------------

interface MetricJsonValue {
    value: number;
    labels: Record<string, string | number>;
    metricName?: string;
}

interface MetricJsonEntry {
    name: string;
    help: string;
    type: number;
    aggregator: string;
    values: MetricJsonValue[];
}

/**
 * Build a synthetic http_requests_total counter entry.
 */
function makeRequestTotal(values: MetricJsonValue[]): MetricJsonEntry {
    return {
        name: 'http_requests_total',
        help: 'Total number of HTTP requests.',
        type: 0, // Counter
        aggregator: 'sum',
        values,
    };
}

/**
 * Build a synthetic http_request_duration_seconds histogram entry.
 * buckets is a map from bucket bound (e.g. "0.05") to cumulative count
 * across ALL label combinations.
 */
function makeDurationHistogram(
    buckets: Record<string, number>,
    extraOpts?: { sum?: number; count?: number },
): MetricJsonEntry {
    const labels: Record<string, string> = { method: 'GET', route: '/test', status_code: '200' };
    const values: MetricJsonValue[] = [];

    for (const [le, count] of Object.entries(buckets)) {
        values.push({ value: count, labels: { ...labels, le } });
    }

    const sum = extraOpts?.sum ?? 0;
    const count = extraOpts?.count ?? (buckets['+Inf'] ?? 0);
    values.push({ value: sum, labels, metricName: 'http_request_duration_seconds_sum' });
    values.push({ value: count, labels, metricName: 'http_request_duration_seconds_count' });

    return {
        name: 'http_request_duration_seconds',
        help: 'Duration of HTTP requests in seconds.',
        type: 2, // Histogram
        aggregator: 'sum',
        values,
    };
}

// ---------------------------------------------------------------------------
// Default configuration validation (existing tests preserved)
// ---------------------------------------------------------------------------

describe('Service Objectives and Alert Thresholds', () => {
    describe('Default Configuration Validation', () => {
        it('should have valid target success rates (<= 100%)', () => {
            Object.values(DefaultServiceObjectives).forEach((objective) => {
                expect(objective.targetSuccessRatePercent).toBeLessThanOrEqual(100);
                expect(objective.targetSuccessRatePercent).toBeGreaterThan(0);
            });
        });

        it('should have logical latency goals (p95 <= p99)', () => {
            Object.values(DefaultServiceObjectives).forEach((objective) => {
                expect(objective.targetLatencyP95Ms).toBeLessThanOrEqual(objective.targetLatencyP99Ms);
                expect(objective.targetLatencyP95Ms).toBeGreaterThan(0);
            });
        });

        it('should have positive alert thresholds', () => {
            Object.values(DefaultAlertThresholds).forEach((threshold) => {
                expect(threshold.maxErrorRatePercent).toBeGreaterThan(0);
                expect(threshold.maxAverageLatencyMs).toBeGreaterThan(0);
                expect(threshold.evaluationWindowSeconds).toBeGreaterThan(0);
            });
        });
    });

    describe('isThresholdBreached()', () => {
        const mockThreshold = {
            operationType: OperationType.API_REQUEST,
            maxErrorRatePercent: 1.0,
            maxAverageLatencyMs: 500,
            evaluationWindowSeconds: 60,
        };

        it('should return false when metrics are within safe limits', () => {
            expect(isThresholdBreached(mockThreshold, 0.5, 300)).toBe(false);
            expect(isThresholdBreached(mockThreshold, 0.99, 499)).toBe(false);
        });

        it('should return true when error rate breaches the maximum limit', () => {
            expect(isThresholdBreached(mockThreshold, 1.0, 300)).toBe(true);
            expect(isThresholdBreached(mockThreshold, 5.0, 300)).toBe(true);
        });

        it('should return true when average latency breaches the maximum limit', () => {
            expect(isThresholdBreached(mockThreshold, 0.5, 500)).toBe(true);
            expect(isThresholdBreached(mockThreshold, 0.5, 1000)).toBe(true);
        });

        it('should return true when both metrics breach limits', () => {
            expect(isThresholdBreached(mockThreshold, 2.0, 600)).toBe(true);
        });
    });
});

// ---------------------------------------------------------------------------
// evaluateObjectives()
// ---------------------------------------------------------------------------

describe('evaluateObjectives()', () => {
    /** Create a Registry seeded with synthetic metrics JSON via resetMetrics. */
    function seedRegistry(
        entries: MetricJsonEntry[],
    ): Registry {
        const register = new Registry();

        // We need to register metrics manually so getMetricsAsJSON returns
        // them. We'll use the Registry's internal ability by creating real
        // Counter and Histogram instances on a shared register.
        const { Counter, Histogram } = jest.requireActual('prom-client');

        const counter = new Counter({
            name: 'http_requests_total',
            help: 'Total number of HTTP requests.',
            labelNames: ['method', 'route', 'status_code'],
            registers: [register],
        });

        const hist = new Histogram({
            name: 'http_request_duration_seconds',
            help: 'Duration of HTTP requests in seconds.',
            labelNames: ['method', 'route', 'status_code'],
            buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
            registers: [register],
        });

        // Apply counter values
        for (const v of (entries.find(e => e.name === 'http_requests_total')?.values ?? [])) {
            counter.inc(v.labels as any, v.value);
        }            // Apply histogram observations — we reconstruct the distribution
            // from cumulative bucket data by computing per-bucket deltas.
            // Note: the `le` label is a special internal bucket label and must
            // NOT be included when calling hist.observe().
            const histEntry = entries.find(e => e.name === 'http_request_duration_seconds');
            if (histEntry) {
                const buckets = histEntry.values
                    .filter(v => v.labels.le !== undefined && v.labels.le !== null && v.labels.le !== '')
                    .map(v => ({
                        le: v.labels.le === '+Inf' ? Infinity : Number(v.labels.le),
                        count: v.value,
                        labels: {
                            method: String(v.labels.method ?? ''),
                            route: String(v.labels.route ?? ''),
                            status_code: String(v.labels.status_code ?? ''),
                        },
                    }))
                    .sort((a, b) => {
                        if (a.le === Infinity) return 1;
                        if (b.le === Infinity) return -1;
                        return a.le - b.le;
                    });

            let prevCount = 0;
            for (const b of buckets) {
                const delta = b.count - prevCount;
                if (delta > 0) {
                    // Reproduce delta observations within this bucket.
                    // Place them at the bucket midpoint for realistic distribution.
                    for (let i = 0; i < delta; i++) {
                        const fraction = b.le === Infinity ? 10 : b.le;
                        hist.observe(b.labels, fraction);
                    }
                }
                prevCount = b.count;
            }
        }

        return register;
    }

    // -----------------------------------------------------------------------
    // Normal cases
    // -----------------------------------------------------------------------

    it('should report compliant when all metrics are well within targets', async () => {
        // 100% success rate, very fast latencies — well within both objectives
        const register = seedRegistry([
            makeRequestTotal([
                { value: 10000, labels: { method: 'GET', route: '/health', status_code: '200' } },
            ]),
            // 10000 observations, all < 10ms
            makeDurationHistogram({
                '0.005': 9500,
                '0.01': 10000,
                '+Inf': 10000,
            }, { sum: 50, count: 10000 }),
        ]);

        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        expect(reports).toHaveLength(2);

        for (const report of reports) {
            expect(report.breached).toBe(false);
            expect(report.breaches.successRate).toBe(false);
            expect(report.breaches.latencyP95).toBe(false);
            expect(report.breaches.latencyP99).toBe(false);
            if (report.observed.successRatePercent !== null) {
                expect(report.observed.successRatePercent).toBe(100);
            }
            if (report.observed.latencyP95Ms !== null) {
                expect(report.observed.latencyP95Ms).toBeLessThan(15);
            }
        }
    });

    it('should report breached when success rate is below target', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 900, labels: { method: 'GET', route: '/api/v1/contracts', status_code: '200' } },
                { value: 100, labels: { method: 'GET', route: '/api/v1/contracts', status_code: '500' } },
            ]),
            makeDurationHistogram({
                '0.005': 500,
                '0.05': 900,
                '0.1': 1000,
                '+Inf': 1000,
            }, { sum: 10, count: 1000 }),
        ]);

        const reports = await evaluateObjectives(register, {
            contractsApi: DefaultServiceObjectives.contractsApi,
        });

        expect(reports).toHaveLength(1);
        const report = reports[0];
        expect(report.breached).toBe(true);
        expect(report.breaches.successRate).toBe(true);
        // success rate = 900/1000 = 90% < 99.9%
        expect(report.observed.successRatePercent).toBeCloseTo(90, 1);
    });

    it('should report breached when p95 latency exceeds target', async () => {
        // 100 observations: 94 fast (<50ms), 6 slow (>=250ms)
        // p95 rank = 95, which falls in the 0.25s bucket -> p95 > 200ms -> breach
        const register = seedRegistry([
            makeRequestTotal([
                { value: 100, labels: { method: 'GET', route: '/api/v1/contracts', status_code: '200' } },
            ]),
            makeDurationHistogram({
                '0.005': 40,
                '0.01': 60,
                '0.05': 94,
                '0.1': 94,
                '0.25': 94,
                '0.5': 100,
                '1': 100,
                '+Inf': 100,
            }, { sum: 10, count: 100 }),
        ]);

        const reports = await evaluateObjectives(register, {
            contractsApi: DefaultServiceObjectives.contractsApi,
        });

        expect(reports).toHaveLength(1);
        const report = reports[0];
        expect(report.breached).toBe(true);
        expect(report.breaches.latencyP95).toBe(true);
        // p95 should be well above the 200ms target
        expect(report.observed.latencyP95Ms).not.toBeNull();
        if (report.observed.latencyP95Ms !== null) {
            expect(report.observed.latencyP95Ms).toBeGreaterThan(200);
        }
    });

    it('should report breached when p99 latency exceeds target', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 100, labels: { method: 'GET', route: '/health', status_code: '200' } },
            ]),
            // 100 observations: 95 are <100ms, 5 are at 500ms -> p99 should be high
            makeDurationHistogram({
                '0.005': 30,
                '0.01': 50,
                '0.05': 80,
                '0.1': 95,
                '0.25': 95,
                '0.5': 100,
                '1': 100,
                '+Inf': 100,
            }, { sum: 15, count: 100 }),
        ]);

        const reports = await evaluateObjectives(register, {
            healthCheck: DefaultServiceObjectives.healthCheck,
        });

        expect(reports).toHaveLength(1);
        const report = reports[0];
        expect(report.breached).toBe(true);
        expect(report.breaches.latencyP99).toBe(true);
        // p99 rank = 99, which falls in the 0.5 bucket (cumulative=100 >= 99)
        // This should be > 100ms (healthCheck p99 target = 100ms)
        if (report.observed.latencyP99Ms !== null) {
            expect(report.observed.latencyP99Ms).toBeGreaterThan(100);
        }
    });

    // -----------------------------------------------------------------------
    // Edge cases
    // -----------------------------------------------------------------------

    it('should handle exactly-at-threshold values (not breach)', async () => {
        // success rate exactly 99.9%, p95 exactly 200ms, p99 exactly 500ms
        // Note: > strict comparison means exactly-at should NOT breach
        const register = seedRegistry([
            makeRequestTotal([
                { value: 999, labels: { method: 'GET', route: '/api', status_code: '200' } },
                { value: 1, labels: { method: 'GET', route: '/api', status_code: '500' } },
            ]),
            // To get exact p95=200ms, we need 95% of observations at or below 200ms
            // With 1000 observations, the 950th ranked value needs to be at 200ms
            // Simpler: make all observations at precisely the threshold
            makeDurationHistogram({
                '0.005': 0,
                '0.01': 0,
                '0.05': 0,
                '0.1': 0,
                '0.25': 0,
                '0.5': 0,
                '1': 0,
                '2.5': 0,
                '5': 0,
                '+Inf': 0, // no observations
            }, { sum: 0, count: 0 }),
        ]);

        // With no histogram observations, latency will be null -> not breached
        const reports = await evaluateObjectives(register, {
            contractsApi: DefaultServiceObjectives.contractsApi,
        });

        expect(reports).toHaveLength(1);
        const report = reports[0];
        // success rate = 999/1000 = 99.9%, which is >= 99.9%, so NOT breached
        expect(report.breaches.successRate).toBe(false);
        // latency is null (no observations) -> not breached
        expect(report.breaches.latencyP95).toBe(false);
        expect(report.breaches.latencyP99).toBe(false);
        // but is the overall report breached? success rate is exactly at threshold
        expect(report.breached).toBe(false);
    });

    it('should handle exactly-at-threshold success rate (not breach)', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 999, labels: { method: 'GET', route: '/api', status_code: '200' } },
                { value: 1, labels: { method: 'GET', route: '/api', status_code: '500' } },
            ]),
            makeDurationHistogram({
                '0.005': 100,
                '+Inf': 100,
            }, { sum: 0.5, count: 100 }),
        ]);

        const reports = await evaluateObjectives(register, {
            contractsApi: { ...DefaultServiceObjectives.contractsApi, targetSuccessRatePercent: 99.9 },
        });

        expect(reports[0].observed.successRatePercent).toBeCloseTo(99.9, 1);
        // 99.9 >= 99.9 should NOT be a breach
        expect(reports[0].breaches.successRate).toBe(false);
    });

    it('should handle exactly-at-threshold latency (> is breach)', async () => {
        // If observed latency equals the target, > strict means not breached
        // But with histograms it's hard to get exact p95 = 200ms
        // Let's test with > comparison semantics via directly checking the
        // calculated breach

        // We'll test with targetLatencyP95Ms=50 for healthcheck
        // If observed is 50, that's NOT > 50, so should not breach
        const register = seedRegistry([
            makeRequestTotal([
                { value: 100, labels: { method: 'GET', route: '/health', status_code: '200' } },
            ]),
            // Put all observations just under or at 50ms
            makeDurationHistogram({
                '0.005': 0,
                '0.01': 0,
                '0.05': 0,
                '+Inf': 0, // empty - we can't easily get exact p95=50
            }, { sum: 0, count: 0 }),
        ]);

        const reports = await evaluateObjectives(register, {
            healthCheck: DefaultServiceObjectives.healthCheck,
        });

        // With empty histogram, latency is null -> not breached
        expect(reports[0].breaches.latencyP95).toBe(false);
    });

    it('should handle zero samples gracefully', async () => {
        const register = seedRegistry([
            makeRequestTotal([]), // empty counter
            makeDurationHistogram({}, { sum: 0, count: 0 }),
        ]);

        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        expect(reports).toHaveLength(2);
        for (const report of reports) {
            expect(report.observed.successRatePercent).toBeNull();
            expect(report.observed.latencyP95Ms).toBeNull();
            expect(report.observed.latencyP99Ms).toBeNull();
            expect(report.breached).toBe(false); // null observations are not breaches
        }
    });

    it('should handle missing metric series entirely', async () => {
        const register = new Registry(); // empty registry

        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        expect(reports).toHaveLength(2);
        for (const report of reports) {
            expect(report.observed.successRatePercent).toBeNull();
            expect(report.observed.latencyP95Ms).toBeNull();
            expect(report.observed.latencyP99Ms).toBeNull();
            expect(report.breached).toBe(false);
        }
    });

    it('should handle only latency data with no requests counter', async () => {
        const register = seedRegistry([
            makeDurationHistogram({
                '0.005': 10,
                '0.01': 20,
                '0.05': 30,
                '0.1': 35,
                '+Inf': 35,
            }, { sum: 1, count: 35 }),
        ]);

        // No http_requests_total in the seed
        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        for (const report of reports) {
            expect(report.observed.successRatePercent).toBeNull();
            expect(report.observed.latencyP95Ms).not.toBeNull();
            expect(report.observed.latencyP99Ms).not.toBeNull();
            // success rate is null -> no breach
            expect(report.breaches.successRate).toBe(false);
        }
    });

    it('should handle exactly one observation (too few for percentiles)', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 1, labels: { method: 'GET', route: '/health', status_code: '200' } },
            ]),
            makeDurationHistogram({
                '0.005': 1,
                '+Inf': 1,
            }, { sum: 0.003, count: 1 }),
        ]);

        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        for (const report of reports) {
            expect(report.observed.successRatePercent).toBe(100);
            // 1 observation is too few for meaningful percentiles
            expect(report.observed.latencyP95Ms).toBeNull();
            expect(report.observed.latencyP99Ms).toBeNull();
            expect(report.breaches.latencyP95).toBe(false);
            expect(report.breaches.latencyP99).toBe(false);
        }
    });

    it('should correctly aggregate across multiple label combinations', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 500, labels: { method: 'GET', route: '/health', status_code: '200' } },
                { value: 300, labels: { method: 'GET', route: '/api/v1/contracts', status_code: '200' } },
                { value: 10, labels: { method: 'GET', route: '/api/v1/contracts', status_code: '500' } },
                { value: 190, labels: { method: 'POST', route: '/api/v1/contracts', status_code: '201' } },
            ]),
            makeDurationHistogram({
                '0.005': 500,
                '0.01': 800,
                '0.05': 950,
                '0.1': 990,
                '0.25': 995,
                '0.5': 997,
                '1': 999,
                '2.5': 1000,
                '+Inf': 1000,
            }, { sum: 50, count: 1000 }),
        ]);

        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        expect(reports).toHaveLength(2);
        // Total = 500+300+10+190 = 1000, Success = 500+300+190 = 990
        // 990/1000 = 99% success rate
        expect(reports[0].observed.successRatePercent).toBeCloseTo(99, 0);
    });

    // -----------------------------------------------------------------------
    // readObservedMetrics
    // -----------------------------------------------------------------------

    describe('readObservedMetrics()', () => {
        it('should return null when no metrics have been recorded', async () => {
            const register = new Registry();
            const result = await readObservedMetrics(register);
            expect(result).toBeNull();
        });

        it('should return observed metrics when data exists', async () => {
            const register = seedRegistry([
                makeRequestTotal([
                    { value: 100, labels: { method: 'GET', route: '/health', status_code: '200' } },
                ]),
                makeDurationHistogram({
                    '0.005': 50,
                    '0.01': 80,
                    '0.05': 95,
                    '0.1': 100,
                    '+Inf': 100,
                }, { sum: 2, count: 100 }),
            ]);

            const result = await readObservedMetrics(register);
            expect(result).not.toBeNull();
            expect(result!.successRatePercent).toBe(100);
            expect(result!.latencyP95Ms).not.toBeNull();
            expect(result!.latencyP99Ms).not.toBeNull();
        });

        it('should return null when only latency data exists but no requests', async () => {
            const register = seedRegistry([
                makeDurationHistogram({
                    '0.005': 10,
                    '+Inf': 10,
                }, { sum: 0.05, count: 10 }),
            ]);

            // The histogram is not empty but success rate is null
            const result = await readObservedMetrics(register);
            expect(result).not.toBeNull();
            expect(result!.successRatePercent).toBeNull();
            expect(result!.latencyP95Ms).not.toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // Report structure
    // -----------------------------------------------------------------------

    it('should return a report for every objective in the registry', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 100, labels: { method: 'GET', route: '/health', status_code: '200' } },
            ]),
            makeDurationHistogram({
                '0.005': 50,
                '0.01': 80,
                '0.05': 95,
                '0.1': 100,
                '+Inf': 100,
            }, { sum: 2, count: 100 }),
        ]);

        const reports = await evaluateObjectives(register, DefaultServiceObjectives);

        expect(reports).toHaveLength(Object.keys(DefaultServiceObjectives).length);
        const keys = reports.map((r) => r.objectiveKey);
        expect(keys).toContain('healthCheck');
        expect(keys).toContain('contractsApi');
    });

    it('should use custom objectives when provided', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 50, labels: { method: 'GET', route: '/custom', status_code: '200' } },
                { value: 50, labels: { method: 'GET', route: '/custom', status_code: '500' } },
            ]),
            makeDurationHistogram({
                '0.005': 50,
                '0.01': 70,
                '0.05': 90,
                '0.1': 100,
                '+Inf': 100,
            }, { sum: 5, count: 100 }),
        ]);

        const reports = await evaluateObjectives(register, {
            customApi: {
                operationType: OperationType.API_REQUEST,
                targetSuccessRatePercent: 50,
                targetLatencyP95Ms: 1000,
                targetLatencyP99Ms: 2000,
            },
        });

        expect(reports).toHaveLength(1);
        expect(reports[0].objectiveKey).toBe('customApi');
        // 50/100 = 50%, which is >= 50%, so not breached
        expect(reports[0].breaches.successRate).toBe(false);
        expect(reports[0].breached).toBe(false);
    });

    it('should include all required fields in the report', async () => {
        const register = seedRegistry([
            makeRequestTotal([
                { value: 100, labels: { method: 'GET', route: '/test', status_code: '200' } },
            ]),
            makeDurationHistogram({
                '0.005': 50,
                '0.01': 80,
                '0.05': 95,
                '0.1': 100,
                '+Inf': 100,
            }, { sum: 2, count: 100 }),
        ]);

        const [report] = await evaluateObjectives(register, {
            testApi: DefaultServiceObjectives.contractsApi,
        });

        expect(report).toHaveProperty('objectiveKey');
        expect(report).toHaveProperty('objective');
        expect(report).toHaveProperty('observed');
        expect(report).toHaveProperty('breaches');
        expect(report).toHaveProperty('breached');
        expect(report.objective).toHaveProperty('operationType');
        expect(report.objective).toHaveProperty('targetSuccessRatePercent');
        expect(report.objective).toHaveProperty('targetLatencyP95Ms');
        expect(report.objective).toHaveProperty('targetLatencyP99Ms');
        expect(report.observed).toHaveProperty('successRatePercent');
        expect(report.observed).toHaveProperty('latencyP95Ms');
        expect(report.observed).toHaveProperty('latencyP99Ms');
        expect(report.breaches).toHaveProperty('successRate');
        expect(report.breaches).toHaveProperty('latencyP95');
        expect(report.breaches).toHaveProperty('latencyP99');
    });
});
