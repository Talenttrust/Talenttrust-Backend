import { Request, Response, NextFunction } from 'express';

const mockGetAllContracts = jest.fn();
const mockCreateContract = jest.fn();

jest.mock('../services/contracts.service', () => {
  return {
    ContractsService: jest.fn().mockImplementation(() => {
      return {
        getAllContracts: mockGetAllContracts,
        createContract: mockCreateContract,
      };
    }),
  };
});

import { ContractsController } from './contracts.controller';

describe('ContractsController fallback errors', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockRequest = {
      body: { title: 'Test Contract' }
    };
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
    mockGetAllContracts.mockClear();
    mockCreateContract.mockClear();
  });

  afterEach(() => {
      jest.restoreAllMocks();
  });

  it('should catch error in getContracts and call next()', async () => {
    const mockError = new Error('DB Down');
    mockGetAllContracts.mockRejectedValue(mockError);

    await ContractsController.getContracts(mockRequest as Request, mockResponse as Response, mockNext);
    
    expect(mockNext).toHaveBeenCalledWith(mockError);
  });

  it('should catch error in createContract and call next()', async () => {
    const mockError = new Error('Creation failed');
    mockCreateContract.mockRejectedValue(mockError);

    await ContractsController.createContract(mockRequest as Request, mockResponse as Response, mockNext);
    
    expect(mockNext).toHaveBeenCalledWith(mockError);
  });
});
