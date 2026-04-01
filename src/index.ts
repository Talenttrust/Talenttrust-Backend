/**
 * @module index
 * @description Server entry point.
 *
 * Bootstraps the Express application and binds it to a port.
 * Import `createApp` from `./app` in tests — never import this file directly
 * in test suites, as it starts the HTTP server immediately.
 */

import { createApp } from './app';

const PORT = process.env.PORT || 3001;
const app = createApp();

/**
 * Enqueue a background job
 * POST /api/v1/jobs
 * Body: { type: JobType, payload: JobPayload, options?: { priority, delay } }
 */
app.post('/api/v1/jobs', async (req: Request, res: Response) => {
  try {
    const { type, payload, options } = req.body;

    if (!type || !payload) {
      return res.status(400).json({ error: 'Job type and payload are required' });
    }

    if (!Object.values(JobType).includes(type)) {
      return res.status(400).json({ error: `Invalid job type: ${type}` });
    }

    const jobId = await queueManager.addJob(type, payload, options);
    res.status(201).json({ jobId, type, status: 'queued' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to enqueue job: ${message}` });
  }
});

/**
 * Get job status
 * GET /api/v1/jobs/:type/:jobId
 */
app.get('/api/v1/jobs/:type/:jobId', async (req: Request, res: Response) => {
  try {
    const { type, jobId } = req.params;

    if (!Object.values(JobType).includes(type as JobType)) {
      return res.status(400).json({ error: `Invalid job type: ${type}` });
    }

    const status = await queueManager.getJobStatus(type as JobType, jobId);
    
    if (!status) {
      return res.status(404).json({ error: 'Job not found' });
    }

    res.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: `Failed to get job status: ${message}` });
  }
});

/**
 * Initialize queues on startup
 */
async function initializeQueues() {
  console.log('Initializing background job queues...');
  
  for (const jobType of Object.values(JobType)) {
    await queueManager.initializeQueue(jobType);
    console.log(`Queue initialized: ${jobType}`);
  }
  
  console.log('All queues initialized successfully');
}

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown() {
  console.log('Received shutdown signal, closing gracefully...');
  await queueManager.shutdown();
  process.exit(0);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

/**
 * Start the server
 */
async function startServer() {
  try {
    await initializeQueues();
    
    app.listen(PORT, () => {
      console.log(`TalentTrust API listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
