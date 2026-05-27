import { DependencyScanService } from './dependency-scan.service';

const cleanAuditOutput = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {},
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
    dependencies: { prod: 20, dev: 10, total: 30 },
  },
});

const highVulnAuditOutput = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    lodash: {
      name: 'lodash',
      severity: 'high',
      fixAvailable: true,
      range: '<4.17.21',
    },
    axios: {
      name: 'axios',
      severity: 'critical',
      fixAvailable: { name: 'axios', version: '1.7.0', isSemVerMajor: false },
      range: '<1.7.0',
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 2 },
    dependencies: { prod: 20, dev: 10, total: 30 },
  },
});

const moderateVulnAuditOutput = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    semver: {
      name: 'semver',
      severity: 'moderate',
      fixAvailable: true,
      range: '<7.5.2',
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 1, high: 0, critical: 0, total: 2 },
    dependencies: { prod: 20, dev: 10, total: 30 },
  },
});

describe('DependencyScanService', () => {
  describe('parseAuditOutput', () => {
    it('returns status=clean when total vulnerabilities is 0', () => {
      const service = new DependencyScanService();
      const report = service.parseAuditOutput(cleanAuditOutput);

      expect(report.status).toBe('clean');
      expect(report.summary.total).toBe(0);
      expect(report.vulnerabilities).toHaveLength(0);
      expect(report.recommendation).toMatch(/No production dependency vulnerabilities/);
    });

    it('returns status=vulnerable with high/critical recommendation', () => {
      const service = new DependencyScanService();
      const report = service.parseAuditOutput(highVulnAuditOutput);

      expect(report.status).toBe('vulnerable');
      expect(report.summary.high).toBe(1);
      expect(report.summary.critical).toBe(1);
      expect(report.summary.total).toBe(2);
      expect(report.recommendation).toMatch(/High or critical/);
    });

    it('returns correct vulnerability entries including fixAvailable as string for object form', () => {
      const service = new DependencyScanService();
      const report = service.parseAuditOutput(highVulnAuditOutput);

      const axiosEntry = report.vulnerabilities.find((v) => v.name === 'axios');
      expect(axiosEntry).toBeDefined();
      expect(axiosEntry?.fixAvailable).toBe('axios');

      const lodashEntry = report.vulnerabilities.find((v) => v.name === 'lodash');
      expect(lodashEntry?.fixAvailable).toBe(true);
    });

    it('returns low/moderate recommendation when no high or critical vulns', () => {
      const service = new DependencyScanService();
      const report = service.parseAuditOutput(moderateVulnAuditOutput);

      expect(report.status).toBe('vulnerable');
      expect(report.summary.high).toBe(0);
      expect(report.summary.critical).toBe(0);
      expect(report.recommendation).toMatch(/Low or moderate/);
    });

    it('includes a scannedAt ISO timestamp', () => {
      const service = new DependencyScanService();
      const before = new Date().toISOString();
      const report = service.parseAuditOutput(cleanAuditOutput);
      const after = new Date().toISOString();

      expect(report.scannedAt >= before).toBe(true);
      expect(report.scannedAt <= after).toBe(true);
    });

    it('throws when stdout is not valid JSON', () => {
      const service = new DependencyScanService();
      expect(() => service.parseAuditOutput('not-json')).toThrow(
        'Failed to parse npm audit output',
      );
    });
  });

  describe('getReport', () => {
    it('returns the parsed report from the audit runner', async () => {
      const runner = jest.fn().mockResolvedValue(cleanAuditOutput);
      const service = new DependencyScanService(runner);

      const report = await service.getReport();

      expect(report.status).toBe('clean');
      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('returns cached report on second call within TTL', async () => {
      const runner = jest.fn().mockResolvedValue(cleanAuditOutput);
      const service = new DependencyScanService(runner);

      await service.getReport();
      await service.getReport();

      expect(runner).toHaveBeenCalledTimes(1);
    });

    it('bypasses cache when forceRefresh=true', async () => {
      const runner = jest.fn().mockResolvedValue(cleanAuditOutput);
      const service = new DependencyScanService(runner);

      await service.getReport();
      await service.getReport(true);

      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('re-fetches after cache TTL expires', async () => {
      const runner = jest.fn().mockResolvedValue(cleanAuditOutput);
      const service = new DependencyScanService(runner);

      await service.getReport();

      (service as unknown as { cacheTimestamp: number }).cacheTimestamp =
        Date.now() - 6 * 60 * 1000;

      await service.getReport();

      expect(runner).toHaveBeenCalledTimes(2);
    });

    it('propagates errors from the audit runner', async () => {
      const runner = jest.fn().mockRejectedValue(new Error('Failed to run npm audit'));
      const service = new DependencyScanService(runner);

      await expect(service.getReport()).rejects.toThrow('Failed to run npm audit');
    });
  });
});
