import { createApp } from './app';

const PORT = process.env.PORT || 3001;

export const startServer = () => {
  const { app } = createApp();
  return app.listen(PORT, () => {
    console.log(`TalentTrust API listening on http://localhost:${PORT}`);
  });
};

if (require.main === module) {
  startServer();
}
