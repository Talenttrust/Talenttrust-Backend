import { Request, Response, NextFunction } from 'express';

const mockGetReport = jest.fn();

jest.mock('../services/dependency-scan.service', () => ({
  DependencyScanService: jest.fn().mockImplementation(() => ({
    getReport: mockGetReport,
  })),
}));

import { DependencyScanController } from './dependency-scan.controller';

const mockReport = {
  status: 'clean',
  scannedAt: '2026-01-01T00:00:00.000Z',
  summary: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
  vulnerabilities: [],
  recommendation: 'No production dependency vulnerabilities detected.',
};

describe('DependencyScanController', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockReq = { query: {} };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    mockGetReport.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns 200 with success status and report data', async () => {
    mockGetReport.mockResolvedValue(mockReport);

    await DependencyScanController.getReport(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockRes.status).toHaveBeenCalledWith(200);
    expect(mockRes.json).toHaveBeenCalledWith({ status: 'success', data: mockReport });
  });

  it('calls getReport with forceRefresh=false when no query param', async () => {
    mockGetReport.mockResolvedValue(mockReport);
    mockReq.query = {};

    await DependencyScanController.getReport(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockGetReport).toHaveBeenCalledWith(false);
  });

  it('calls getReport with forceRefresh=true when ?refresh=true', async () => {
    mockGetReport.mockResolvedValue(mockReport);
    mockReq.query = { refresh: 'true' };

    await DependencyScanController.getReport(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockGetReport).toHaveBeenCalledWith(true);
  });

  it('delegates errors to next()', async () => {
    const error = new Error('audit failed');
    mockGetReport.mockRejectedValue(error);

    await DependencyScanController.getReport(
      mockReq as Request,
      mockRes as Response,
      mockNext,
    );

    expect(mockNext).toHaveBeenCalledWith(error);
    expect(mockRes.json).not.toHaveBeenCalled();
  });
});
