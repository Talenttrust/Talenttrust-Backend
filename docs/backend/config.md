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
| `REPUTATION_ENABLED` | No | `false` | Feature flag to enable/disable the reputation scoring system at runtime |

## Feature Flags

Feature flags are boolean environment variables that toggle product behaviour at runtime without a deploy. They follow the same Zod-validated config pipeline as all other variables.

| Variable | Default | Description |
|---|---|---|
| `MILESTONES_ENABLED` | `true` | Enable or disable the milestones feature. When `false`, any `milestones` field in a request body is silently stripped before the service layer — no validation errors are raised and contracts are processed as if no milestones were provided. Set to `false` to disable the feature during a rollout pause. |
| `WEBHOOKS_ENABLED` | `true` | Enable or disable the webhooks subsystem. When `false`, `WebhookService.trigger()` is a no-op (no subscriptions queried, no deliveries attempted, no DLQ writes) and the `/api/v1/webhook-subscriptions` router is not mounted (all endpoints return `404`). Omit the variable to keep webhooks enabled (safe default). |

### Toggling `MILESTONES_ENABLED`

```bash
# Disable milestones
MILESTONES_ENABLED=false

# Enable milestones (default — omitting the variable has the same effect)
MILESTONES_ENABLED=true
```

Accepted values are case-insensitive: `true`, `false`, `1`, `0`.

See [`docs/milestones.md`](../milestones.md#feature-flag-milestones_enabled) for the full behavioural specification.

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
- **Transformation**: Comma-separated strings (e.g. `CORS_ALLOWED_ORIGINS`) are automatically converted to arrays.
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
