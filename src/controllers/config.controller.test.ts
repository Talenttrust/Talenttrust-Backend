import { Request, Response } from 'express';

// ── Mock appConfiguration before importing the controller ────────────────────
const mockLoadConfig = jest.fn();
jest.mock('../appConfiguration', () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
}));

import { ConfigController } from './config.controller';

describe('ConfigController.getConfig', () => {
  let mockRequest: Partial<Request>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockResponse: Partial<Response>;

  beforeEach(() => {
    mockRequest = {};
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockResponse = {
      json: mockJson,
      status: mockStatus,
    };
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns 200 with allowedAssets from config', () => {
    mockLoadConfig.mockReturnValue({
      allowedAssets: ['USDC', 'XLM', 'BTC', 'ETH'],
    });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenCalledWith({ allowedAssets: ['USDC', 'XLM', 'BTC', 'ETH'] });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('returns 200 with an empty allowedAssets array when config has none', () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: [] });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenCalledWith({ allowedAssets: [] });
  });

  it('returns 500 with error envelope when loadConfig throws', () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('Config read failure');
    });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockStatus).toHaveBeenCalledWith(500);
    expect(mockJson).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'internal_error',
          message: expect.any(String),
        }),
      }),
    );
  });
});
