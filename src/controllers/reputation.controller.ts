import { Request, Response } from 'express';
import { ReputationService } from '../services/reputation.service';
import { UpdateReputationPayload } from '../types/reputation';

/**
 * @title Reputation Controller
 * @dev NatSpec: Controller handling HTTP requests for the Freelancer Reputation Profile API.
 */
export class ReputationController {
  /**
   * @notice Get a freelancer's reputation profile
   * @param req The Express request containing freelancerId in params
   * @param res The Express response object
   */
  public static getProfile(req: Request, res: Response): void {
    try {
      const { id } = req.params;
      const profile = ReputationService.getProfile(id);
      
      // We always return a profile, defaulting to an empty one if no rating exists
      res.status(200).json({ status: 'success', data: profile });
    } catch (error: any) {
      if (error.message === 'Freelancer ID is required') {
        res.status(400).json({ status: 'error', message: error.message });
      } else {
        res.status(500).json({ status: 'error', message: 'Internal server error' });
      }
    }
  }

  /**
   * @notice Update a freelancer's reputation profile with a new review
   * @param req The Express request containing freelancerId in params and payload in body
   * @param res The Express response object
   */
  public static updateProfile(req: Request, res: Response): void {
    try {
      const { id } = req.params;
      const payload: UpdateReputationPayload = req.body;
      
      // Basic input validation handles securely before reaching service
      if (!payload || !payload.reviewerId || typeof payload.rating !== 'number') {
        res.status(400).json({ status: 'error', message: 'Invalid payload: reviewerId and rating are required' });
        return;
      }

      const updatedProfile = ReputationService.updateProfile(id, payload);
      res.status(200).json({ status: 'success', data: updatedProfile });
    } catch (error: any) {
      if (error.message.includes('required') || error.message.includes('Rating must be between 1 and 5')) {
        res.status(400).json({ status: 'error', message: error.message });
      } else {
        res.status(500).json({ status: 'error', message: 'Internal server error' });
      }
    }
  }
}
