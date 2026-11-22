import { createApp } from './app';
import { config } from './config';
import { startServer, parsePort } from './server';
import { EscrowStore } from './store';
import {
  loadSnapshotFile,
  parseSnapshotIntervalMs,
  startSnapshotPersistence,
  type SnapshotController,
} from './persistence';
import { InMemoryEventStore } from './indexer/store';
import { EventIndexer, withBackoff } from './indexer/indexer';

const port = parsePort(process.env.PORT);

if (require.main === module) {
  const store = new EscrowStore();
  const snapshotPath = process.env.STORE_SNAPSHOT_PATH?.trim();
  let snapshotController: SnapshotController | undefined;

  if (snapshotPath) {
    const intervalMs = parseSnapshotIntervalMs(process.env.STORE_SNAPSHOT_INTERVAL_MS);
    const loaded = loadSnapshotFile(snapshotPath, store);
    if (!loaded) {
      store.seed();
    }
    snapshotController = startSnapshotPersistence(store, {
      filePath: snapshotPath,
      intervalMs,
    });
  } else {
    store.seed();
  }

  // The poller and the API share one event store, so indexed events are served by /api/v1/chain/events.
  const eventStore = new InMemoryEventStore();
  const indexer = new EventIndexer(eventStore);
  startServer({
    app: createApp(store, eventStore, indexer),
    port,
    onShutdown: snapshotController ? () => snapshotController.stop() : undefined,
  });

  if (config.indexerIntervalMs > 0) {
    const poll = async () => {
      try {
        await withBackoff(() => indexer.runOnce());
      } catch (err) {
        console.error('Indexer error:', err instanceof Error ? err.message : err);
      }
    };
    console.log(`Starting indexer poller with interval ${config.indexerIntervalMs}ms`);
    void poll();
    setInterval(() => void poll(), config.indexerIntervalMs).unref();
  }
}

export { createApp };
