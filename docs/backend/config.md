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
├── env.schema.ts     # Zod schema for environment variables
├── environment.ts    # Main configuration loader and interface
├── secrets.ts        # Secrets manager and EnvSecret implementation
└── environment.test.ts # Configuration tests
```

### Validation Rules (powered by Zod)

- **Numeric variables** (e.g. `PORT`) are automatically parsed and validated as integers.
- **Enums** (e.g. `NODE_ENV`) are strictly validated against allowed values.
- **URLs** (e.g. `STELLAR_HORIZON_URL`) must be valid URL formats.
- **Transformation**: Comma-separated strings (e.g. `CORS_ORIGINS`) are automatically converted to arrays.
- **Fail-Fast**: If validation fails, the application prints a safe error (no secret values leaked) and exits with code `1`.

### Adding a New Variable

1. Add the variable to `.env.example` with a comment.
2. Add the field to the `envSchema` in `src/config/env.schema.ts`.
3. If it needs to be mapped to the `EnvironmentConfig` interface, update `src/config/environment.ts`.
4. Add tests in `src/config/environment.test.ts`.
5. Update this document and `README.md`.


## Security Notes

- **Never log secrets.** The config module does not log any values. Avoid
  printing the full config object in production.
- **Keep `.env` out of version control.** The `.gitignore` already excludes
  `.env` and `.env.local`.
- **Use `requireEnv()` for secrets** (API keys, signing keys) so the
  application refuses to start without them.
