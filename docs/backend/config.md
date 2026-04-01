# Configuration Guide

TalentTrust Backend uses a centralized configuration module located at
`src/config/`. All environment variables are parsed, validated, and
type-checked at startup so misconfigurations fail fast with a clear error
message.

## Quick Start

```bash
cp .env.example .env   # create your local env file
# edit .env with your values
npm run dev             # config is validated on startup
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | No | `3001` | HTTP port for the Express server |
| `NODE_ENV` | No | `development` | Runtime environment (`development`, `production`, `test`) |
| `STELLAR_HORIZON_URL` | No | `https://horizon-testnet.stellar.org` | Stellar Horizon API endpoint |
| `STELLAR_NETWORK_PASSPHRASE` | No | `Test SDF Network ; September 2015` | Network passphrase for transaction signing |
| `SOROBAN_RPC_URL` | No | `https://soroban-testnet.stellar.org` | Soroban JSON-RPC endpoint |
| `SOROBAN_CONTRACT_ID` | No | *(empty)* | Deployed escrow contract ID |

## How It Works

### Module Structure

```
src/config/
├── env.ts            # Low-level env parsing & validation utilities
├── index.ts          # Config interface, loader, and singleton export
└── config.test.ts    # Unit tests
```

### Validation Rules

- **Empty strings** are treated as missing. A variable set to `""` or `"   "`
  behaves as if it were unset.
- **Numeric variables** (e.g. `PORT`) must parse to a finite integer.
  Non-numeric or floating-point values cause a startup error.
- **Boolean variables** accept `"true"`, `"1"`, `"false"`, or `"0"`
  (case-insensitive). Any other value causes a startup error.
- **Required variables** (when added in the future) throw a descriptive error
  at boot time if missing. Currently all variables have safe defaults.

### Usage in Application Code

Import the singleton `config` object anywhere in the application:

```ts
import { config } from './config';

console.log(config.server.port);           // number
console.log(config.stellar.horizonUrl);    // string
console.log(config.server.isProduction);   // boolean
```

The config object is deeply frozen (`Object.freeze`) and should not be
mutated at runtime.

### Usage in Tests

Use the `loadConfig()` factory function to create isolated config snapshots
with controlled environment variables:

```ts
import { loadConfig } from './config';

beforeEach(() => {
  delete process.env.PORT;
});

it('uses default port', () => {
  const cfg = loadConfig();
  expect(cfg.server.port).toBe(3001);
});
```

### Adding a New Variable

1. Add the variable to `.env.example` with a comment.
2. Add a field to the appropriate interface in `src/config/index.ts`
   (`ServerConfig`, `StellarConfig`, `SorobanConfig`, or create a new one).
3. Parse it in `loadConfig()` using the helpers from `src/config/env.ts`:
   - `requireEnv(key)` — required string
   - `optionalEnv(key, default)` — optional string with default
   - `parseIntEnv(key, default)` — optional integer with default
   - `parseBoolEnv(key, default)` — optional boolean with default
4. Add tests in `src/config/config.test.ts`.
5. Update the table in this document and in `README.md`.

## Security Notes

- **Never log secrets.** The config module does not log any values. Avoid
  printing the full config object in production.
- **Keep `.env` out of version control.** The `.gitignore` already excludes
  `.env` and `.env.local`.
- **Use `requireEnv()` for secrets** (API keys, signing keys) so the
  application refuses to start without them.
