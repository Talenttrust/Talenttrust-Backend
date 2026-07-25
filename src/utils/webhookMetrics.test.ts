/**
 * @fileoverview Tests for webhook delivery metrics counters.
 *
 * Metrics: success, retry, dlq counters. Labels bounded to host/status only.
 * Metrics are reset between test cases to avoid registry pollution.
 * No raw URLs appear in label values.
 *
 * @module utils/webhookMetrics
 */

import {
  recordWebhookDelivery,
  recordWebhookRetry,
  recordWebhookDlq,
  getWebhookMetricsSnapshot,
  resetWebhookMetrics,
  WEBHOOK_COUNTER_NAMES,
} from './webhookMetrics';

describe('webhookMetrics', () => {
  beforeEach(() => {
    resetWebhookMetrics();
  });

  afterAll(() => {
    resetWebhookMetrics();
  });

  describe('counter increments', () => {
    it('increments success counter by 1 on delivery', () => {
      recordWebhookDelivery('api.example.com', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const successCount = snapshot.success.find(
        (m) => m.labels.host === 'api.example.com' && m.labels.status === '200'
      )?.value;

      expect(successCount).toBe(1);
    });

    it('increments retry counter by 1 on retry', () => {
      recordWebhookRetry('hooks.partner.com', 503);

      const snapshot = getWebhookMetricsSnapshot();
      const retryCount = snapshot.retry.find(
        (m) => m.labels.host === 'hooks.partner.com' && m.labels.status === '503'
      )?.value;

      expect(retryCount).toBe(1);
    });

    it('increments dlq counter by 1 on dead-letter', () => {
      recordWebhookDlq('failed.service.com', 500);

      const snapshot = getWebhookMetricsSnapshot();
      const dlqCount = snapshot.dlq.find(
        (m) => m.labels.host === 'failed.service.com' && m.labels.status === '500'
      )?.value;

      expect(dlqCount).toBe(1);
    });

    it('accumulates multiple deliveries to same host/status', () => {
      recordWebhookDelivery('api.example.com', 200);
      recordWebhookDelivery('api.example.com', 200);
      recordWebhookDelivery('api.example.com', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const successCount = snapshot.success.find(
        (m) => m.labels.host === 'api.example.com' && m.labels.status === '200'
      )?.value;

      expect(successCount).toBe(3);
    });

    it('tracks different status codes separately for same host', () => {
      recordWebhookDelivery('api.example.com', 200);
      recordWebhookDelivery('api.example.com', 201);

      const snapshot = getWebhookMetricsSnapshot();

      const okCount = snapshot.success.find(
        (m) => m.labels.host === 'api.example.com' && m.labels.status === '200'
      )?.value;

      const createdCount = snapshot.success.find(
        (m) => m.labels.host === 'api.example.com' && m.labels.status === '201'
      )?.value;

      expect(okCount).toBe(1);
      expect(createdCount).toBe(1);
    });
  });

  describe('label cardinality bounds', () => {
    it('uses host label, never full URL', () => {
      recordWebhookDelivery('https://api.example.com/webhooks/receive?token=abc', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const labels = snapshot.success[0]?.labels;

      expect(labels?.host).toBe('api.example.com');
      expect(labels?.host).not.toContain('https://');
      expect(labels?.host).not.toContain('/webhooks');
      expect(labels?.host).not.toContain('?token');
    });

    it('uses status code string as status label', () => {
      recordWebhookDelivery('api.example.com', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const labels = snapshot.success[0]?.labels;

      expect(labels?.status).toBe('200');
      expect(labels?.status).toBeString();
    });

    it('only exposes host and status labels', () => {
      recordWebhookDelivery('api.example.com', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const labelKeys = Object.keys(snapshot.success[0]?.labels || {});

      expect(labelKeys).toHaveLength(2);
      expect(labelKeys).toContain('host');
      expect(labelKeys).toContain('status');
    });

    it('sanitizes host from URL with port', () => {
      recordWebhookDelivery('api.example.com:8080', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const host = snapshot.success[0]?.labels?.host;

      expect(host).toBe('api.example.com');
      expect(host).not.toContain(':8080');
    });

    it('sanitizes host from URL with auth info', () => {
      recordWebhookDelivery('user:pass@api.example.com', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const host = snapshot.success[0]?.labels?.host;

      expect(host).toBe('api.example.com');
      expect(host).not.toContain('user');
      expect(host).not.toContain('pass');
    });

    it('sanitizes host from URL with path', () => {
      recordWebhookDelivery('api.example.com/v1/webhooks', 200);

      const snapshot = getWebhookMetricsSnapshot();
      const host = snapshot.success[0]?.labels?.host;

      expect(host).toBe('api.example.com');
    });
  });

  describe('metric reset isolation', () => {
    it('resets all counters between tests', () => {
      recordWebhookDelivery('api.example.com', 200);
      resetWebhookMetrics();

      const snapshot = getWebhookMetricsSnapshot();

      expect(snapshot.success).toHaveLength(0);
      expect(snapshot.retry).toHaveLength(0);
      expect(snapshot.dlq).toHaveLength(0);
    });

    it('metrics from one test do not leak to next', () => {
      // This test assumes a previous test may have run
      const snapshot = getWebhookMetricsSnapshot();

      // After beforeEach reset, should be clean
      const totalSuccess = snapshot.success.reduce((sum, m) => sum + m.value, 0);
      const totalRetry = snapshot.retry.reduce((sum, m) => sum + m.value, 0);
      const totalDlq = snapshot.dlq.reduce((sum, m) => sum + m.value, 0);

      expect(totalSuccess).toBe(0);
      expect(totalRetry).toBe(0);
      expect(totalDlq).toBe(0);
    });
  });

  describe('edge cases', () => {
    it('handles empty host string gracefully', () => {
      expect(() => recordWebhookDelivery('', 200)).not.toThrow();
    });

    it('handles unusual status codes', () => {
      recordWebhookDelivery('api.example.com', 418);
      recordWebhookRetry('api.example.com', 0);
      recordWebhookDlq('api.example.com', -1);

      const snapshot = getWebhookMetricsSnapshot();

      expect(snapshot.success[0]?.labels?.status).toBe('418');
      expect(snapshot.retry[0]?.labels?.status).toBe('0');
      expect(snapshot.dlq[0]?.labels?.status).toBe('-1');
    });

    it('handles very long hostnames', () => {
      const longHost = 'a'.repeat(253);
      recordWebhookDelivery(longHost, 200);

      const snapshot = getWebhookMetricsSnapshot();
      expect(snapshot.success[0]?.labels?.host).toBe(longHost);
    });
  });

  describe('exported constants', () => {
    it('exposes expected counter names', () => {
      expect(WEBHOOK_COUNTER_NAMES).toContain('webhook_delivery_total');
      expect(WEBHOOK_COUNTER_NAMES).toContain('webhook_retry_total');
      expect(WEBHOOK_COUNTER_NAMES).toContain('webhook_dlq_total');
    });
  });
});