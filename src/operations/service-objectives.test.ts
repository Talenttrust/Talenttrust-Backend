import {
    DefaultServiceObjectives,
    DefaultAlertThresholds,
    isThresholdBreached,
    OperationType,
} from './service-objectives';

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
