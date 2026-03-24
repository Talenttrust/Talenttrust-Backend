/**
 * Server Entry Point
 * Starts the Express server
 */

import app from './app';
import { config } from './config/environment';

const PORT = config.port;

/**
 * Start the Express server
 */
export function startServer(): void {
  app.listen(PORT, () => {
    console.log(`TalentTrust API listening on http://localhost:${PORT}`);
    console.log(`API Version: ${config.apiVersion}`);
  });
}

// Start server only if not in test environment
if (process.env.NODE_ENV !== 'test') {
  startServer();
}

export default app;
