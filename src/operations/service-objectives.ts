/**
 * @title Service Objectives and Alert Thresholds
 * @dev Defines the Service Level Objectives (SLOs) and Service Level Agreements (SLAs) for the backend operations.
 */

import { Registry } from 'prom-client';

export enum OperationType {
    API_REQUEST = 'API_REQUEST',
    DATABASE_QUERY = 'DATABASE_QUERY',
    EXTERNAL_API_CALL = 'EXTERNAL_API_CALL',
}

/**
 * @dev Represents the target metrics for a specific service or operation to ensure high reliability.
 */
export interface ServiceObjective {
    operationType: OperationType;
    /**
     * @dev Target availability/success rate as a percentage (e.g., 99.9). Must be <= 100.
     */
    targetSuccessRatePercent: number;
    /**
     * @dev Maximum acceptable latency in milliseconds for the 95th percentile (p95).
     */
    targetLatencyP95Ms: number;
    /**
     * @dev Maximum acceptable latency in milliseconds for the 99th percentile (p99).
     */
    targetLatencyP99Ms: number;
}

/**
 * @dev Defines conditions under which an alert should be triggered for a specific operation.
 */
export interface AlertThreshold {
    operationType: OperationType;
    /**
     * @dev Trigger alert if error rate percentage exceeds this value.
     */
    maxErrorRatePercent: number;
    /**
     * @dev Trigger alert if average latency exceeds this value over the evaluation window.
     */
    maxAverageLatencyMs: number;
    /**
     * @dev The time window in seconds over which the metrics should be evaluated to trigger alerts.
     */
    evaluationWindowSeconds: number;
}

// --------------------------------------------------------------------------
// SLO Compliance Report Types
// --------------------------------------------------------------------------

/**
 * @dev Observed values extracted from the Prometheus registry for a single evaluation window.
 * All values are `null` when the corresponding metric series is missing or empty.
 */
export interface ObservedMetrics {
    /** Observed success rate as a percentage (e.g., 99.95). */
    successRatePercent: number | null;
    /** Observed p95 latency in milliseconds. */
    latencyP95Ms: number | null;
    /** Observed p99 latency in milliseconds. */
    latencyP99Ms: number | null;
}

/**
 * @dev Per-objective compliance report indicating which dimensions are breaching.
 */
export interface BreachSummary {
    successRate: boolean;
    latencyP95: boolean;
    latencyP99: boolean;
}

/**
 * @dev Structured compliance report returned by {@link evaluateObjectives}.
 */
export interface ObjectiveComplianceReport {
    /** Logical key from the objectives registry (e.g. `"healthCheck"`). */
    objectiveKey: string;
    /** The objective definition that was evaluated. */
    objective: ServiceObjective;
    /** Observed metric values (may be null if a metric series is missing). */
    observed: ObservedMetrics;
    /** Summary of which dimensions are in breach. */
    breaches: BreachSummary;
    /** `true` when at least one dimension is breaching. */
    breached: boolean;
}

/**
 * @dev Registry of default service objectives for key system operations.
 */
export const DefaultServiceObjectives: Record<string, ServiceObjective> = {
    healthCheck: {
        operationType: OperationType.API_REQUEST,
        targetSuccessRatePercent: 99.99,
        targetLatencyP95Ms: 50,
        targetLatencyP99Ms: 100,
    },
    contractsApi: {
        operationType: OperationType.API_REQUEST,
        targetSuccessRatePercent: 99.9,
        targetLatencyP95Ms: 200,
        targetLatencyP99Ms: 500,
    },
};

/**
 * @dev Registry of default alert thresholds corresponding to the system operations.
 */
export const DefaultAlertThresholds: Record<string, AlertThreshold> = {
    healthCheck: {
        operationType: OperationType.API_REQUEST,
        maxErrorRatePercent: 0.1,    // Alert if error rate > 0.1%
        maxAverageLatencyMs: 150,
        evaluationWindowSeconds: 300, // Evaluate over 5 minutes
    },
    contractsApi: {
        operationType: OperationType.API_REQUEST,
        maxErrorRatePercent: 1.0,    // Alert if error rate > 1.0%
        maxAverageLatencyMs: 400,
        evaluationWindowSeconds: 300,
    },
};

// --------------------------------------------------------------------------
// SLO Evaluation
// --------------------------------------------------------------------------

/**
 * Metric names used by {@link MetricsService} — kept in sync as constants so
 * the evaluator does not depend on the full MetricsService class.
 */
const METRIC_HTTP_REQUESTS_TOTAL = 'http_requests_total';
const METRIC_HTTP_DURATION_SECONDS = 'http_request_duration_seconds';

/**
 * @dev Evaluate every objective in the supplied registry against live
 * Prometheus metrics. Observations are sourced from the existing
 * `MetricsService` registry (prom-client `Registry`).
 *
 * The evaluator:
 * - Reads the `http_requests_total` counter for success-rate computation.
 * - Reads the `http_request_duration_seconds` histogram for p95/p99 latency.
 * - Aggregates across all label combinations (method, route, status_code).
 * - Never throws on missing/empty metric series — returns `null` observed
 *   values for absent data and marks those dimensions as NOT breached.
 *
 * @param register  The prom-client {@link Registry} that the application's
 *                  {@link MetricsService} writes to.
 * @param objectives  A record of named objectives to evaluate. Defaults to
 *                    {@link DefaultServiceObjectives}.
 * @returns A per-objective compliance report array in the same iteration order
 *          as the supplied objectives.
 */
export async function evaluateObjectives(
    register: Registry,
    objectives: Record<string, ServiceObjective> = DefaultServiceObjectives,
): Promise<ObjectiveComplianceReport[]> {
    const metricsJson = await register.getMetricsAsJSON();

    const successRatePercent = extractSuccessRate(metricsJson);
    const latencyP95Ms = extractPercentile(metricsJson, METRIC_HTTP_DURATION_SECONDS, 0.95);
    const latencyP99Ms = extractPercentile(metricsJson, METRIC_HTTP_DURATION_SECONDS, 0.99);

    const observed: ObservedMetrics = {
        successRatePercent,
        latencyP95Ms,
        latencyP99Ms,
    };

    return Object.entries(objectives).map(([key, objective]) =>
        buildReport(key, objective, observed),
    );
}

/**
 * @dev Expose the current observed metrics without an objectives registry, so
 * the health/observability layer can read raw observations without needing a
 * full objectives registry.
 *
 * @returns A single {@link ObservedMetrics} snapshot, or `null` if no metrics
 *          have been recorded at all.
 */
export async function readObservedMetrics(
    register: Registry,
): Promise<ObservedMetrics | null> {
    const metricsJson = await register.getMetricsAsJSON();

    const successRatePercent = extractSuccessRate(metricsJson);
    const latencyP95Ms = extractPercentile(metricsJson, METRIC_HTTP_DURATION_SECONDS, 0.95);
    const latencyP99Ms = extractPercentile(metricsJson, METRIC_HTTP_DURATION_SECONDS, 0.99);

    if (successRatePercent === null && latencyP95Ms === null && latencyP99Ms === null) {
        return null;
    }

    return { successRatePercent, latencyP95Ms, latencyP99Ms };
}

// --------------------------------------------------------------------------
// Internal helpers
// --------------------------------------------------------------------------

interface MetricJsonEntry {
    name: string;
    help: string;
    type: number; // MetricType enum ordinal
    aggregator: string;
    values: Array<{
        value: number;
        labels: Partial<Record<string, string | number>>;
        metricName?: string;
    }>;
}

/**
 * Extract the aggregate success rate from the http_requests_total counter.
 * Returns null when the counter has no data.
 */
function extractSuccessRate(metricsJson: MetricJsonEntry[]): number | null {
    const counterEntry = metricsJson.find(
        (m) => m.name === METRIC_HTTP_REQUESTS_TOTAL,
    );
    if (!counterEntry || counterEntry.values.length === 0) {
        return null;
    }

    let totalRequests = 0;
    let successRequests = 0;

    for (const v of counterEntry.values) {
        const count = v.value;
        totalRequests += count;
        const statusCode = v.labels.status_code;
        if (statusCode !== undefined && statusCode !== null && String(statusCode).startsWith('2')) {
            successRequests += count;
        }
    }

    if (totalRequests === 0) {
        return null;
    }

    return (successRequests / totalRequests) * 100;
}

/**
 * Extract a percentile value from the http_request_duration_seconds histogram.
 * Uses standard Prometheus linear interpolation within histogram buckets.
 * Returns null when the histogram has no data.
 */
function extractPercentile(
    metricsJson: MetricJsonEntry[],
    metricName: string,
    percentile: number,
): number | null {
    const histEntry = metricsJson.find((m) => m.name === metricName);
    if (!histEntry || histEntry.values.length === 0) {
        return null;
    }

    // Group bucket counts by le, aggregating across all label combinations.
    const bucketMap = new Map<string, number>();

    for (const v of histEntry.values) {
        const le = v.labels.le;
        if (le === undefined || le === null || le === '') {
            continue; // skip _sum / _count entries
        }
        const key = String(le);
        bucketMap.set(key, (bucketMap.get(key) ?? 0) + v.value);
    }

    if (bucketMap.size === 0) {
        return null;
    }

    // Sort buckets by le numeric value (handle +Inf as Infinity).
    const buckets = Array.from(bucketMap.entries())
        .map(([le, count]) => ({
            le: le === '+Inf' ? Infinity : Number(le),
            count,
        }))
        .sort((a, b) => a.le - b.le);

    // Find the total observation count from the last (largest) bucket.
    const totalCount = buckets[buckets.length - 1].count;
    if (totalCount <= 1) {
        // With 0 or 1 observation a percentile is meaningless.
        return null;
    }

    const targetCount = totalCount * percentile;

    // Walk buckets to find the one containing our target rank.
    for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].count < targetCount) {
            continue;
        }

        // First bucket — interpolate between 0 and bucket upper bound.
        if (i === 0) {
            const fraction = buckets[0].count > 0 ? targetCount / buckets[0].count : 0;
            return (buckets[0].le * fraction * 1000); // seconds → ms
        }

        const prevCount = buckets[i - 1].count;
        const bucketWidth = buckets[i].le - buckets[i - 1].le;
        const bucketCount = buckets[i].count - prevCount;

        if (bucketCount <= 0) {
            // All observations landed exactly at the bucket boundary.
            const boundaryMs = buckets[i - 1].le * 1000;
            return Number.isFinite(boundaryMs) ? boundaryMs : null;
        }

        const rankInBucket = targetCount - prevCount;
        const fraction = rankInBucket / bucketCount;
        const interpolated = (buckets[i - 1].le + fraction * bucketWidth) * 1000;
        return Number.isFinite(interpolated) ? interpolated : null;
    }

    // Should not be reached — the last bucket covers everything up to +Inf.
    return buckets[buckets.length - 1].le === Infinity
        ? null
        : buckets[buckets.length - 1].le * 1000;
}

/**
 * Build a single {@link ObjectiveComplianceReport} from an objective and the
 * aggregate observed metrics.
 */
function buildReport(
    objectiveKey: string,
    objective: ServiceObjective,
    observed: ObservedMetrics,
): ObjectiveComplianceReport {
    const breaches: BreachSummary = {
        successRate:
            observed.successRatePercent !== null &&
            observed.successRatePercent < objective.targetSuccessRatePercent,
        latencyP95:
            observed.latencyP95Ms !== null &&
            observed.latencyP95Ms > objective.targetLatencyP95Ms,
        latencyP99:
            observed.latencyP99Ms !== null &&
            observed.latencyP99Ms > objective.targetLatencyP99Ms,
    };

    return {
        objectiveKey,
        objective,
        observed,
        breaches,
        breached: breaches.successRate || breaches.latencyP95 || breaches.latencyP99,
    };
}

/**
 * @dev Evaluates whether the current metrics breach the defined alert threshold for an operation.
 * @param threshold The threshold configuration to evaluate against.
 * @param currentErrorRateThe observed error rate percentage.
 * @param currentAverageLatencyMs The observed average latency in ms.
 * @returns true if an alert should be triggered, false otherwise.
 */
export function isThresholdBreached(
    threshold: AlertThreshold,
    currentErrorRate: number,
    currentAverageLatencyMs: number
): boolean {
    if (currentErrorRate >= threshold.maxErrorRatePercent) {
        return true;
    }
    if (currentAverageLatencyMs >= threshold.maxAverageLatencyMs) {
        return true;
    }
    return false;
}