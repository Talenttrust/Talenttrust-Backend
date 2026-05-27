/**
 * @title Service Objectives and Alert Thresholds
 * @dev Defines the Service Level Objectives (SLOs) and Service Level Agreements (SLAs) for the backend operations.
 */

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
