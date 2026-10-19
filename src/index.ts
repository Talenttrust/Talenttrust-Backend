import { createApp } from './app';

const port = Number(process.env.PORT) || 3001;

if (require.main === module) {
  const app = createApp();
  app.locals.ready.then(() => {
    const server = app.listen(port, () => {
      console.log(`TalentTrust API listening on http://localhost:${port}`);
    });
    const shutdown = () => server.close(() => { void app.locals.close(); });
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }).catch(async () => {
    console.error('Storage initialization failed');
    await app.locals.close();
    process.exitCode = 1;
  });
}

export { createApp };
