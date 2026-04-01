import { Request, Response } from 'express';
import { ReputationController } from './reputation.controller';
import { ReputationService } from '../services/reputation.service';

jest.mock('../services/reputation.service');

describe('ReputationController', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    req = { params: { id: 'user-1' }, body: {} };
    res = { status: statusMock } as unknown as Response;
    jest.clearAllMocks();
  });

  describe('getProfile', () => {
    it('should return 400 if service throws Freelancer ID is required', () => {
      (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
        throw new Error('Freelancer ID is required');
      });

      ReputationController.getProfile(req as Request, res as Response);
      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Freelancer ID is required' });
    });

    it('should return 500 for unknown service errors in getProfile', () => {
      (ReputationService.getProfile as jest.Mock).mockImplementation(() => {
        throw new Error('Database down');
      });

      ReputationController.getProfile(req as Request, res as Response);
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Internal server error' });
    });
  });

  describe('updateProfile', () => {
    it('should return 500 for unknown service errors in updateProfile', () => {
      req.body = { reviewerId: 'client-1', rating: 5 };
      (ReputationService.updateProfile as jest.Mock).mockImplementation(() => {
        throw new Error('Unexpected failure');
      });

      ReputationController.updateProfile(req as Request, res as Response);
      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith({ status: 'error', message: 'Internal server error' });
    });
  });
});
