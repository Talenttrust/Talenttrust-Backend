/**
 * Export the same OpenAPI document served at GET /openapi.json.
 *
 * The API spec includes deployment-dependent values from src/config.ts.
 * Use the config defaults so the committed documentation is reproducible
 * regardless of the developer's STELLAR_* or TX_CACHE_MAX settings.
 *
 * Run in a fresh Node process (npm run openapi:export).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SPEC_CONFIG_ENV = ['STELLAR_NETWORK', 'ESCROW_CONTRACT_ID', 'TX_CACHE_MAX'] as const;

export function generateOpenApiJson(): string {
  const original = SPEC_CONFIG_ENV.map((name) => process.env[name]);

  try {
    for (const name of SPEC_CONFIG_ENV) delete process.env[name];

    // Import *after* fixing the config: src/openapi.ts builds the document
    // when loaded. Reuse the served export instead of maintaining a copy.
    const { openapi } = require('../src/openapi') as typeof import('../src/openapi');
    return JSON.stringify(openapi, null, 2) + '\n';
  } finally {
    SPEC_CONFIG_ENV.forEach((name, index) => {
      if (original[index] === undefined) delete process.env[name];
      else process.env[name] = original[index];
    });
  }
}

if (require.main === module) {
  const output = resolve(__dirname, '../docs/openapi.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, generateOpenApiJson(), 'utf8');
  process.stdout.write('Exported docs/openapi.json from src/openapi.ts\n');
}
