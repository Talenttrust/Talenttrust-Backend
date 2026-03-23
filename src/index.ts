import { createServer, type Server } from 'http';

import { createApp } from './app';

/**
 * @notice Start the HTTP server for the TalentTrust backend.
 * @param port Port to bind to. Defaults to the PORT environment variable or 3001.
 */
export function startServer(port: number | string = process.env.PORT || 3001): Server {
  const app = createApp();
  const server = createServer(app);

  server.listen(port, () => {
    console.log(`TalentTrust API listening on http://localhost:${port}`);
  });

  return server;
}

if (require.main === module) {
  startServer();
}
