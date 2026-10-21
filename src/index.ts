import { createApp } from './app';
import { startServer, parsePort } from './server';

const port = parsePort(process.env.PORT);

if (require.main === module) {
  startServer({ app: createApp(), port });
}

export { createApp };
