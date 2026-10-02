import { Request, Response } from 'express';
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

  it('returns 200 with a single allowed asset (boundary: minimum non-empty)', () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC'] });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenCalledWith({ allowedAssets: ['USDC'] });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('returns 200 with a large allowedAssets list (boundary: upper size)', () => {
    const large = Array.from({ length: 1000 }, (_, i) => `ASSET_${i}`);
    mockLoadConfig.mockReturnValue({ allowedAssets: large });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenCalledWith({ allowedAssets: large });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and preserves duplicate entries deterministically', () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC', 'USDC', 'XLM'] });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenCalledWith({ allowedAssets: ['USDC', 'USDC', 'XLM'] });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('returns 200 with an empty array when allowedAssets is undefined (invalid input tolerated)', () => {
    mockLoadConfig.mockReturnValue({});

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenCalledWith({ allowedAssets: [] });
    expect(mockStatus).not.toHaveBeenCalled();
  });

  it('returns 500 with error envelope when loadConfig returns null', () => {
    mockLoadConfig.mockReturnValue(null);

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

  it('does not leak internal error details in the 500 response', () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('Sensitive path /etc/secrets leaked');
    });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockStatus).toHaveBeenCalledWith(500);
    const payload = mockJson.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain('/etc/secrets');
  });

  it('is deterministic across repeated invocations with the same input', () => {
    mockLoadConfig.mockReturnValue({ allowedAssets: ['USDC', 'XLM'] });

    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);
    ConfigController.getConfig(mockRequest as Request, mockResponse as Response);

    expect(mockJson).toHaveBeenNthCalledWith(1, { allowedAssets: ['USDC', 'XLM'] });
    expect(mockJson).toHaveBeenNthCalledWith(2, { allowedAssets: ['USDC', 'XLM'] });
  });
});
