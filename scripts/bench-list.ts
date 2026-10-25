/**
 * Benchmark: payload sizes for GET /api/v1/contracts with and without
 * sparse fieldsets and gzip compression.
 *
 * Seeds 1000 contracts (each with 5 milestones) into an in-memory store,
 * then measures the byte size of the JSON response in four scenarios:
 *
 *   1. Full response, no compression
 *   2. Full response, gzip
 *   3. Sparse response (?fields=title,status,totalAmount), no compression
 *   4. Sparse response, gzip
 *
 * Run with: npx ts-node scripts/bench-list.ts
 */
import http from 'http';
import zlib from 'zlib';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';

function seedStore(n: number): EscrowStore {
  const store = new EscrowStore();
  for (let i = 0; i < n; i++) {
    store.create({
      title: `Engagement ${i}`,
      client: `GCLIENT${String(i).padStart(10, '0')}`,
      freelancer: `GFREELANCER${String(i).padStart(10, '0')}`,
      milestones: Array.from({ length: 5 }, (_, j) => ({
        title: `Milestone ${j + 1}`,
        amount: 100 + j * 50,
      })),
    });
  }
  return store;
}

async function main() {
  const store = seedStore(1000);
  const app = createApp(store);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://localhost:${port}`;

  function get(path: string, acceptEncoding?: string): Promise<{ headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (acceptEncoding) headers['Accept-Encoding'] = acceptEncoding;
      http.get(baseUrl + path, { headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  const fields = 'title,status,totalAmount';
  const fullPath = '/api/v1/contracts';
  const sparsePath = `/api/v1/contracts?fields=${encodeURIComponent(fields)}`;

  console.log('\n=== GET /api/v1/contracts payload benchmark (1000 contracts, 5 milestones each) ===\n');

  // 1. Full response, no compression
  const fullRaw = await get(fullPath, 'identity');
  const fullRawSize = fullRaw.body.length;

  // 2. Full response, gzip
  const fullGz = await get(fullPath, 'gzip');
  const fullGzSize = fullGz.body.length;

  // 3. Sparse response, no compression
  const sparseRaw = await get(sparsePath, 'identity');
  const sparseRawSize = sparseRaw.body.length;

  // 4. Sparse response, gzip
  const sparseGz = await get(sparsePath, 'gzip');
  const sparseGzSize = sparseGz.body.length;

  const fmt = (n: number) => n.toLocaleString() + ' B';
  const pct = (a: number, b: number) => `${Math.round((1 - b / a) * 100)}% smaller`;

  console.log('Scenario                              | Size          | Reduction vs full');
  console.log('--------------------------------------|---------------|------------------');
  console.log(`Full response (no compression)        | ${fmt(fullRawSize).padEnd(13)} | —`);
  console.log(`Full response (gzip)                 | ${fmt(fullGzSize).padEnd(13)} | ${pct(fullRawSize, fullGzSize)}`);
  console.log(`Sparse (?fields=title,status,amount)  | ${fmt(sparseRawSize).padEnd(13)} | ${pct(fullRawSize, sparseRawSize)}`);
  console.log(`Sparse + gzip                         | ${fmt(sparseGzSize).padEnd(13)} | ${pct(fullRawSize, sparseGzSize)}`);

  console.log('\n=== Summary ===');
  console.log(`Combining sparse fieldsets + gzip reduces payload by ${pct(fullRawSize, sparseGzSize)} `);
  console.log(`(${fmt(fullRawSize)} → ${fmt(sparseGzSize)} bytes)\n`);

  server.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
