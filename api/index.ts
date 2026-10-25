import { createApp } from '../src/app';

// Vercel serverless entry: export the Express app as the request handler.
const app = createApp();
export default app;
