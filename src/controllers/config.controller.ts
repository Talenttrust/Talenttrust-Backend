import { Request, Response } from 'express';
import { loadConfig } from '../appConfiguration';

export class ConfigController {
  /**
   * Returns the application configuration, specifically the allowed assets.
   * 
   * @param req - Express request
   * @param res - Express response
   */
  static getConfig(req: Request, res: Response) {
    try {
      const config = loadConfig() as unknown as Record<string, unknown>;
      return res.json({
        allowedAssets: config['allowedAssets'] ?? [],
      });
    } catch (error) {
      console.error('Failed to load config:', error);
      return res.status(500).json({
        error: {
          code: 'internal_error',
          message: 'Failed to load configuration',
        },
      });
    }
  }
}
