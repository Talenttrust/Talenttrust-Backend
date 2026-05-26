# Environment Variables & Secrets Reference

Complete reference for every environment variable and secret used across all TalentTrust Backend modules. Variables are grouped by the module or concern they configure.

---

## Quick Start

```bash
cp .env.example .env
# Fill in required values, then:
npm run dev
```

The application validates all variables at startup via Zod (`src/config/env.schema.ts`). Missing required values cause an immediate exit with a clear error message — no silent misconfigurations.

---

## Table of Contents

1. [Server & Runtime](#1-server--runtime)
2. [Security & Authentication](#2-security--authentication)
3. [CORS Configuration](#3-cors-configuration)
4. [Database](#4-database)
5. [Redis & Queue](#5-redis--queue)
6. [Stellar / Soroban Blockchain](#6-stellar--soroban-blockchain)
7. [Rate Limiting](#7-rate-limiting)
8. [Request Limits](#8-request-limits)
9. [Circuit Breaker](#9-circuit-breaker)
10. [Blue-Green Deployment / Router](#10-blue-green-deployment--router)
11. [Observability & Logging](#11-observability--logging)
12. [Audit & Compliance](#12-audit--compliance)
13. [Chaos Testing](#13-chaos-testing)
14. [Health Checks](#14-health-checks)
15. [Upstream Services](#15-upstream-services)
16. [Queue Retry Policies](#16-queue-retry-policies)
17. [Secrets Management Summary](#17-secrets-management-summary)
18. [Per-Environment Checklist](#18-per-environment-checklist)

---

## 1. Server & Runtime

Defined in: `src/config/env.schema.ts`, `src/config/environment.ts`

| Variable           | Required | Default                   | Description                                                                                                                                                     |
| ------------------ | -------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`             | No       | `3001`                    | HTTP port the Express server listens on. Must be 1–65535.                                                                                                       |
| `NODE_ENV`         | No       | `development`             | Runtime environment. Accepted values: `development`, `staging`, `production`, `test`. Controls security policies, log verbosity, and Stellar network selection. |
| `API_BASE_URL`     | No       | `http://localhost:{PORT}` | Public base URL of this API. Must be a valid HTTPS URL in staging/production. SSRF-protected — cannot point to internal addresses.                              |
| `DEBUG`            | No       | `false`                   | Set to `true` to enable verbose debug logging. Must be `false` in production.                                                                                   |
| `MAX_REQUEST_SIZE` | No       | `10mb`                    | Maximum request body size accepted by the Express body parser (e.g. `10mb`, `1mb`).                                                                             |

---

## 2. Security & Authentication

Defined in: `src/middleware/authorization.ts`, `src/config/secrets.ts`

| Variable     | Required             | Default                   | Description                                                                                                                              |
| ------------ | -------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET` | **Yes (production)** | `dev-secret-keep-it-safe` | HMAC-SHA256 signing key for JWT tokens. Minimum 8 characters. **Must be a strong random value in production — the default is insecure.** |

> **Security note:** `JWT_SECRET` is read lazily at request time so test suites can set it before making requests. Never log this value. Rotate it by updating the environment variable and restarting the service (existing tokens will be invalidated).

---

## 3. CORS Configuration

Defined in: `src/config/security.ts`, `src/config/env.schema.ts`

Two separate CORS variables exist — one used by the security middleware and one by the Zod schema. Both should be set consistently.

| Variable          | Required | Default                                        | Description                                                                                                                                                           |
| ----------------- | -------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ALLOWED_ORIGINS` | No       | `http://localhost:3000, http://localhost:3001` | Comma-separated list of origins allowed by the CORS middleware (`src/config/security.ts`). Wildcards (`*`) and `localhost` origins are rejected in `production` mode. |
| `CORS_ORIGINS`    | No       | `http://localhost:3000`                        | Comma-separated origins used by the Zod-validated config (`src/config/env.schema.ts`). Automatically parsed into an array.                                            |

**Production rules enforced at startup:**

- Wildcard `*` is rejected.
- `localhost` origins are rejected.
- An empty allowlist is rejected.

---

## 4. Database

Defined in: `src/config/secrets.ts`, `src/db/database.ts`, `src/audit/repository.ts`

| Variable                | Required | Default                                   | Description                                                                                                                        |
| ----------------------- | -------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | No       | `postgresql://localhost:5432/talenttrust` | PostgreSQL connection string. Required in staging and production.                                                                  |
| `DB_PATH`               | No       | `talenttrust.db` (cwd)                    | File path for the SQLite database used by the event store (`src/db/database.ts`). Overrides the default path.                      |
| `AUDIT_STORAGE_BACKEND` | No       | `memory`                                  | Storage backend for the audit log. Accepted values: `memory`, `sqlite`. Use `sqlite` for persistence.                              |
| `AUDIT_DB_PATH`         | No       | `talenttrust-audit.db` (cwd)              | File path for the SQLite audit log database. In `test` mode defaults to `:memory:`. Only used when `AUDIT_STORAGE_BACKEND=sqlite`. |
| `WEBHOOK_DLQ_PATH`      | No       | `data/webhook-dlq.db` (cwd)               | File path for the webhook dead-letter queue SQLite database (`src/queue/webhook-dlq.ts`).                                          |

---

## 5. Redis & Queue

Defined in: `src/queue/config.ts`, `src/health/probes.ts`

| Variable         | Required | Default     | Description                                                                                        |
| ---------------- | -------- | ----------- | -------------------------------------------------------------------------------------------------- |
| `REDIS_HOST`     | No       | `localhost` | Redis server hostname.                                                                             |
| `REDIS_PORT`     | No       | `6379`      | Redis server port.                                                                                 |
| `REDIS_PASSWORD` | No       | _(none)_    | Redis authentication password. Leave unset for unauthenticated connections. **Treat as a secret.** |

> Used by BullMQ for job queues and by the Redis health probe. In multi-instance deployments, all instances must point to the same Redis server to share rate-limit state.

---

## 6. Stellar / Soroban Blockchain

Defined in: `src/config/env.schema.ts`, `src/sorobanEnv.ts`, `src/rpc/stellarClient.ts`

| Variable                     | Required | Default                                  | Description                                                                                                                                                                        |
| ---------------------------- | -------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STELLAR_HORIZON_URL`        | No       | `https://horizon-testnet.stellar.org`    | Stellar Horizon REST API endpoint. SSRF-protected. Use mainnet URL in production.                                                                                                  |
| `STELLAR_NETWORK_PASSPHRASE` | No       | `Test SDF Network ; September 2015`      | Network passphrase used for transaction signing. Must match the target network.                                                                                                    |
| `SOROBAN_RPC_URL`            | No       | `https://soroban-testnet.stellar.org`    | Soroban JSON-RPC endpoint for smart contract interaction. SSRF-protected. Also read by `src/sorobanEnv.ts` with a different futurenet default — set explicitly to avoid ambiguity. |
| `SOROBAN_CONTRACT_ID`        | No       | _(empty)_                                | Deployed escrow smart contract ID on the Stellar network.                                                                                                                          |
| `STELLAR_RPC_URL`            | No       | `https://rpc-testnet.stellar.org`        | Alternative Stellar RPC endpoint used by `src/rpc/stellarClient.ts`. SSRF-protected.                                                                                               |
| `SOROBAN_NETWORK_PASSPHRASE` | No       | `Test SDF Future Network ; October 2022` | Network passphrase used specifically by `src/sorobanEnv.ts`. Set this explicitly if it differs from `STELLAR_NETWORK_PASSPHRASE`.                                                  |

> **Production requirement:** All Stellar/Soroban URLs must point to mainnet endpoints when `NODE_ENV=production`. The application automatically selects `stellarNetwork: 'mainnet'` in production but does not auto-switch the URLs — you must set them explicitly.

---

## 7. Rate Limiting

Defined in: `src/config/rateLimit.ts`

All rate limit variables are optional. The defaults are tuned for production use.

### Standard Tier (authenticated read endpoints)

| Variable                | Default | Description                                 |
| ----------------------- | ------- | ------------------------------------------- |
| `RL_STANDARD_MAX`       | `600`   | Max requests per window.                    |
| `RL_STANDARD_WINDOW_MS` | `60000` | Window duration in milliseconds (1 minute). |

### Sensitive Tier (write operations: POST/PUT/DELETE)

| Variable                 | Default | Description                      |
| ------------------------ | ------- | -------------------------------- |
| `RL_SENSITIVE_MAX`       | `300`   | Max requests per window.         |
| `RL_SENSITIVE_WINDOW_MS` | `60000` | Window duration in milliseconds. |

### Strict Tier (auth/login endpoints, job creation)

| Variable              | Default | Description                      |
| --------------------- | ------- | -------------------------------- |
| `RL_STRICT_MAX`       | `180`   | Max requests per window.         |
| `RL_STRICT_WINDOW_MS` | `60000` | Window duration in milliseconds. |

### Audit Export Tier (compliance downloads)

| Variable                            | Default    | Description                               |
| ----------------------------------- | ---------- | ----------------------------------------- |
| `RL_AUDIT_EXPORT_MAX`               | `5`        | Max requests per window.                  |
| `RL_AUDIT_EXPORT_WINDOW_MS`         | `3600000`  | Window duration in milliseconds (1 hour). |
| `RL_AUDIT_EXPORT_ABUSE_THRESHOLD`   | `3`        | Violations before hard block.             |
| `RL_AUDIT_EXPORT_BLOCK_WINDOW_MS`   | `21600000` | Violation observation window (6 hours).   |
| `RL_AUDIT_EXPORT_BLOCK_DURATION_MS` | `3600000`  | Initial block duration (1 hour).          |
| `RL_AUDIT_EXPORT_MAX_BLOCK_MS`      | `86400000` | Maximum block duration (24 hours).        |

### Shared Abuse Detection (all tiers)

| Variable               | Default           | Description                                                      |
| ---------------------- | ----------------- | ---------------------------------------------------------------- |
| `RL_ABUSE_THRESHOLD`   | `5` (strict: `3`) | Number of violations before a hard block is applied.             |
| `RL_BLOCK_WINDOW_MS`   | `300000`          | Observation window for counting violations (5 minutes).          |
| `RL_BLOCK_DURATION_MS` | `600000`          | Initial block duration after threshold is exceeded (10 minutes). |
| `RL_MAX_BLOCK_MS`      | `86400000`        | Maximum block duration with exponential backoff (24 hours).      |

---

## 8. Request Limits

Defined in: `src/middleware/requestLimits.ts`

| Variable                       | Default            | Description                                                                        |
| ------------------------------ | ------------------ | ---------------------------------------------------------------------------------- |
| `MAX_REQUEST_BODY_SIZE`        | `1048576` (1 MB)   | Maximum request body size in bytes. Requests exceeding this return HTTP 413.       |
| `ENFORCE_JSON_CONTENT_TYPE`    | `true`             | Set to `false` to disable Content-Type enforcement. Not recommended in production. |
| `ALLOWED_CONTENT_TYPES`        | `application/json` | Comma-separated list of allowed Content-Type values for non-GET/HEAD requests.     |
| `REQUEST_LIMITS_EXCLUDE_PATHS` | `/health,/metrics` | Comma-separated path prefixes excluded from content-type and size validation.      |

---

## 9. Circuit Breaker

Defined in: `src/appConfiguration.ts`

| Variable               | Default | Constraints | Description                                                         |
| ---------------------- | ------- | ----------- | ------------------------------------------------------------------- |
| `CB_FAILURE_THRESHOLD` | `5`     | 1–100       | Consecutive failures before the circuit opens.                      |
| `CB_SUCCESS_THRESHOLD` | `1`     | 1–20        | Consecutive successes in HALF_OPEN state before the circuit closes. |
| `CB_TIMEOUT_MS`        | `30000` | 1000–300000 | Milliseconds to wait in OPEN state before probing again.            |

---

## 10. Blue-Green Deployment / Router

Defined in: `src/router.ts`, `src/config/env.schema.ts`, `src/deploy.ts`

| Variable       | Default  | Description                                                                           |
| -------------- | -------- | ------------------------------------------------------------------------------------- |
| `ACTIVE_COLOR` | `blue`   | Which backend instance is currently active. Accepted values: `blue`, `green`.         |
| `BLUE_PORT`    | `3001`   | Port of the blue backend instance.                                                    |
| `GREEN_PORT`   | `3002`   | Port of the green backend instance.                                                   |
| `APP_COLOR`    | _(none)_ | Set by npm scripts (`blue`, `green`) to identify which color a process is running as. |
| `MODE`         | _(none)_ | Set to `router` to start the proxy router, or `deploy` to run deployment commands.    |

---

## 11. Observability & Logging

Defined in: `src/logger.ts`, `src/middleware/metricsAuth.ts`, `src/middleware/httpLogger.ts`, `src/app.ts`

| Variable             | Required | Default                              | Description                                                                                                                                                    |
| -------------------- | -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`          | No       | `info` (production), `debug` (other) | Pino log level. Accepted values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.                                                                           |
| `HOSTNAME`           | No       | `unknown`                            | Hostname included in every log record. Typically set automatically by the OS or container runtime.                                                             |
| `METRICS_AUTH_TOKEN` | No       | _(none)_                             | Bearer token required to access the `/metrics` endpoint. If unset, the endpoint is open (acceptable in development, not in production). **Treat as a secret.** |
| `TRUST_PROXY`        | No       | `false`                              | Set to `true` to trust the `X-Forwarded-For` header for client IP resolution. Enable only when running behind a trusted reverse proxy.                         |
| `SERVICE_NAME`       | No       | `talenttrust-backend`                | Service name label attached to Prometheus metrics.                                                                                                             |

---

## 12. Audit & Compliance

Defined in: `src/retention/audit.ts`

| Variable                  | Required             | Default                                  | Description                                                                                                                       |
| ------------------------- | -------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `COMPLIANCE_AUDIT_SECRET` | **Yes (production)** | `talenttrust-compliance-secret-key-2024` | HMAC-SHA256 key used to sign compliance audit exports. **The default is hardcoded and insecure — always override in production.** |

> **Warning:** This variable is missing from `.env.example`. Add it before deploying to any non-development environment.

---

## 13. Chaos Testing

Defined in: `src/appConfiguration.ts`

These variables are for controlled fault injection during load and resilience testing. They should never be set in production.

| Variable            | Default   | Description                                                                     |
| ------------------- | --------- | ------------------------------------------------------------------------------- |
| `CHAOS_MODE`        | `off`     | Fault injection mode. Accepted values: `off`, `error`, `timeout`, `random`.     |
| `CHAOS_TARGETS`     | _(empty)_ | Comma-separated list of target service names to inject faults into.             |
| `CHAOS_PROBABILITY` | `0`       | Probability (0.0–1.0) that a chaos fault is triggered on each eligible request. |

---

## 14. Health Checks

Defined in: `src/health/probes.ts`

| Variable            | Default   | Description                                                                                                                                                                                                     |
| ------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRED_ENV_VARS` | _(empty)_ | Comma-separated list of variable names that the `env` health probe verifies are present at runtime. Values are never exposed — only existence is checked. Example: `REQUIRED_ENV_VARS=JWT_SECRET,DATABASE_URL`. |

---

## 15. Upstream Services

Defined in: `src/appConfiguration.ts`

| Variable                       | Required | Default                             | Description                                                                                                       |
| ------------------------------ | -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `UPSTREAM_CONTRACTS_URL`       | No       | `https://example.invalid/contracts` | URL of the upstream contracts service. Must be a public URL — SSRF protection blocks internal addresses.          |
| `UPSTREAM_TIMEOUT_MS`          | No       | `1200`                              | Timeout in milliseconds for upstream HTTP requests. Clamped to 100–10000 ms.                                      |
| `GRACEFUL_DEGRADATION_ENABLED` | No       | `true`                              | When `true`, the application returns degraded responses instead of errors when upstream services are unavailable. |
| `ALLOWED_ASSETS`               | No       | `USDC,XLM,BTC,ETH`                  | Comma-separated list of allowed asset codes. Values are normalised to uppercase.                                  |

---

## 16. Queue Retry Policies

Defined in: `src/queue/retry-manager.ts` (loaded from environment at runtime)

Retry policies can be overridden per job type using the pattern:
`RETRY_POLICY_{JOB_TYPE}_{FIELD}`

Where `{JOB_TYPE}` is the job type name in uppercase with spaces replaced by underscores, and `{FIELD}` is one of:

| Field suffix  | Description                 | Safety cap     |
| ------------- | --------------------------- | -------------- |
| `_ATTEMPTS`   | Maximum retry attempts      | 10             |
| `_DELAY`      | Initial backoff delay in ms | 300000 (5 min) |
| `_MULTIPLIER` | Backoff multiplier          | 5.0            |
| `_JITTER`     | Jitter factor (0.0–1.0)     | 1.0            |

**Example** — override the email notification retry policy:

```bash
RETRY_POLICY_EMAIL_NOTIFICATION_ATTEMPTS=7
RETRY_POLICY_EMAIL_NOTIFICATION_DELAY=1500
RETRY_POLICY_EMAIL_NOTIFICATION_MULTIPLIER=2.5
RETRY_POLICY_EMAIL_NOTIFICATION_JITTER=0.2
```

Invalid values are silently ignored and the default policy is used.

---

## 17. Secrets Management Summary

The `SecretsManager` (`src/config/secrets.ts`) provides a central registry for sensitive values. The following secrets are registered at startup via `initializeSecrets()`:

| Secret name    | Source variable | Default (dev only)                        |
| -------------- | --------------- | ----------------------------------------- |
| `PORT`         | `PORT`          | `3001`                                    |
| `NODE_ENV`     | `NODE_ENV`      | `development`                             |
| `DATABASE_URL` | `DATABASE_URL`  | `postgresql://localhost:5432/talenttrust` |
| `JWT_SECRET`   | `JWT_SECRET`    | `dev-secret-keep-it-safe`                 |

Additional secrets (Redis password, metrics token, compliance audit secret) are read directly from `process.env` in their respective modules and should be added to `SecretsManager` if centralised rotation is needed.

**Rotation:** Call `secretsManager.refreshAll()` to reload all registered secrets from the environment without restarting the process.

---

## 18. Per-Environment Checklist

### Development

```bash
NODE_ENV=development
PORT=3001
DEBUG=true
JWT_SECRET=<any-value-at-least-8-chars>
# All other variables use safe defaults
```

### Staging

```bash
NODE_ENV=staging
PORT=3002
DEBUG=false
API_BASE_URL=https://staging-api.talenttrust.example.com
CORS_ORIGINS=https://staging.talenttrust.example.com
ALLOWED_ORIGINS=https://staging.talenttrust.example.com
DATABASE_URL=postgresql://user:pass@staging-db.example.com:5432/talenttrust
JWT_SECRET=<strong-random-secret>
REDIS_HOST=<redis-host>
REDIS_PASSWORD=<redis-password>
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
METRICS_AUTH_TOKEN=<strong-random-token>
COMPLIANCE_AUDIT_SECRET=<strong-random-secret>
REQUIRED_ENV_VARS=JWT_SECRET,DATABASE_URL,REDIS_PASSWORD
```

### Production

```bash
NODE_ENV=production
PORT=3000
DEBUG=false
API_BASE_URL=https://api.talenttrust.example.com
CORS_ORIGINS=https://app.talenttrust.example.com
ALLOWED_ORIGINS=https://app.talenttrust.example.com
DATABASE_URL=postgresql://user:pass@prod-db.example.com:5432/talenttrust
JWT_SECRET=<strong-random-secret>          # ⚠️ Required
REDIS_HOST=<redis-host>
REDIS_PASSWORD=<redis-password>            # ⚠️ Required
STELLAR_HORIZON_URL=https://horizon.stellar.org
STELLAR_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
SOROBAN_RPC_URL=https://soroban-rpc.mainnet.stellar.gateway.fm
STELLAR_RPC_URL=https://rpc.mainnet.stellar.org
METRICS_AUTH_TOKEN=<strong-random-token>   # ⚠️ Required
COMPLIANCE_AUDIT_SECRET=<strong-random-secret>  # ⚠️ Required
REQUIRED_ENV_VARS=JWT_SECRET,DATABASE_URL,REDIS_PASSWORD,COMPLIANCE_AUDIT_SECRET
TRUST_PROXY=true                           # if behind a load balancer
```

---

## Known Gaps & Recommendations

| Issue                                                                                | Recommendation                                                          |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `COMPLIANCE_AUDIT_SECRET` has a hardcoded insecure default                           | Add to `.env.example` and enforce via `REQUIRED_ENV_VARS` in production |
| `ALLOWED_ORIGINS` and `CORS_ORIGINS` serve the same purpose in two different modules | Consolidate to a single variable in a future refactor                   |
| `SOROBAN_RPC_URL` has different defaults in `env.schema.ts` vs `sorobanEnv.ts`       | Set `SOROBAN_RPC_URL` explicitly in all environments to avoid ambiguity |
| `METRICS_AUTH_TOKEN` is optional but the `/metrics` endpoint is open without it      | Enforce this variable via `REQUIRED_ENV_VARS` in staging and production |
| Redis password is not registered in `SecretsManager`                                 | Register it for centralised rotation support                            |
