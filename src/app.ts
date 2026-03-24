/**
 * Express Application Configuration
 * Configures and exports the Express app without starting the server
 */

import express, { Request, Response } from 'express';
import { versionMiddleware, registerDeprecation } from './versioning';
import { config } from './config/environment';
import contractsV1 from './routes/v1/contracts';
import contractsV2 from './routes/v2/contracts';

const app = express();

// Middleware
app.use(express.json());
app.use(versionMiddleware);

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ 
    status: 'ok', 
    service: 'talenttrust-backend',
    version: config.apiVersion,
    timestamp: new Date().toISOString(),
  });
});

// API version routes
app.use('/api/v1/contracts', contractsV1);
app.use('/api/v2/contracts', contractsV2);

// Example: Register a deprecated endpoint
// This demonstrates how to mark endpoints for deprecation
registerDeprecation('GET', '/api/v1/contracts', {
  deprecatedIn: 'v1',
  deprecatedAt: new Date('2024-01-01'),
  sunsetDate: new Date('2024-12-31'),
  replacement: '/api/v2/contracts',
  notes: 'v2 includes enhanced filtering and pagination',
});

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested endpoint does not exist',
  });
});

export default app;
