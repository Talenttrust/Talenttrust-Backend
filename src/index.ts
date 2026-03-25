import { Server } from 'http';

import { createApp } from './app';

export const app = createApp();

/**
 * Starts the API server on the configured port.
 */
export function startServer(port: number | string = process.env.PORT || 3001): Server {
  return app.listen(port, () => {
    console.log(`TalentTrust API listening on http://localhost:${port}`);
  });
}

/* istanbul ignore next */
if (process.env.NODE_ENV !== 'test') {
  startServer();
}
