import { createApp } from './app';
import { config } from './config';
import { InMemoryEventStore } from './indexer/store';
import { EventIndexer, withBackoff } from './indexer/indexer';

const port = Number(process.env.PORT) || 3001;

if (require.main === module) {
  const app = createApp();
  app.listen(port, () => {
    console.log(`TalentTrust API listening on http://localhost:${port}`);
  });

  if (config.indexerIntervalMs > 0) {
    const store = new InMemoryEventStore();
    const indexer = new EventIndexer(store);

    async function poll() {
      try {
        await withBackoff(() => indexer.runOnce());
        console.log('Indexer batch completed');
      } catch (err) {
        console.error('Indexer error:', err);
      }
    }

    console.log(`Starting indexer poller with interval ${config.indexerIntervalMs}ms`);
    poll();
    setInterval(poll, config.indexerIntervalMs);
  }
}

export { createApp };
