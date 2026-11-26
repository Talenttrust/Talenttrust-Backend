import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { createApp } from '../src/app';
import { EscrowStore } from '../src/store';
import { type HealthRpcClient } from '../src/health';
import { NETWORK_PASSPHRASES } from '../src/config';

/**
 * Keeps docs/health.md and docs/runbook-health.md honest: every source path
 * they name must exist, every env var they name must be read by the code, and
 * the routes they document must be the ones the app serves.
 */
const root = path.resolve(__dirname, '..');
const DOCS = ['docs/health.md', 'docs/runbook-health.md'] as const;
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

function listTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTs(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

const sourceText = listTs(path.join(root, 'src'))
  .map((file) => fs.readFileSync(file, 'utf8'))
  .join('\n');

const healthyRpc: HealthRpcClient = {
  getHealth: async () => 'healthy',
  getNetworkPassphrase: async () => NETWORK_PASSPHRASES.testnet,
  hasContractInstance: async () => true,
};

describe.each(DOCS)('%s', (doc) => {
  const text = read(doc);

  it('references only source and test files that exist', () => {
    const paths = new Set(text.match(/\b(?:src|tests)\/[\w./-]+\.ts\b/g) ?? []);
    expect(paths.size).toBeGreaterThan(0);
    const missing = [...paths].filter((rel) => !fs.existsSync(path.join(root, rel)));
    expect(missing).toEqual([]);
  });

  it('links only to docs that exist', () => {
    const links = [...text.matchAll(/\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)].map((m) => m[1]);
    const missing = links.filter((link) => !fs.existsSync(path.resolve(root, 'docs', link)));
    expect(missing).toEqual([]);
  });

  it('names only environment variables the code reads', () => {
    const vars = new Set(
      text.match(/\b(?:HEALTH|STELLAR|ESCROW|SHUTDOWN|API|PAUSE|STORE)_[A-Z_]+\b/g) ?? [],
    );
    const unknown = [...vars].filter((name) => !sourceText.includes(`'${name}'`) && !sourceText.includes(`.${name}`));
    expect(unknown).toEqual([]);
  });

  it('does not document removed modules or a POST /health route', () => {
    expect(text).not.toMatch(/src\/health\/|src\/routes\/health\.ts/);
    // A heading or table row for POST /health would mean the route is documented as existing.
    expect(text).not.toMatch(/^#+\s*POST \/health|^\|\s*`POST \/health`/m);
  });
});

describe('documented health routes', () => {
  const app = createApp({ store: new EscrowStore(), health: { rpc: healthyRpc } });

  it('serves the three documented GET probes', async () => {
    expect((await request(app).get('/health/live')).body).toEqual({ status: 'ok' });
    expect((await request(app).get('/health/ready')).body).toMatchObject({ status: 'ready' });
    const health = await request(app).get('/health');
    expect(Object.keys(health.body).sort()).toEqual(
      ['checks', 'pauseSource', 'paused', 'status', 'storage', 'timestamp', 'uptimeSeconds', 'version'],
    );
  });

  it('has no POST /health route', async () => {
    expect((await request(app).post('/health')).status).toBe(405);
  });
});
