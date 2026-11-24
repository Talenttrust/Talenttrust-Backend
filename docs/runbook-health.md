# Runbook: Health Probes

Operational guide for the `/health`, `/health/live` and `/health/ready`
endpoints. For the full response contract see [`docs/health.md`](health.md).

**Code:** `src/health.ts` (`HealthService`), `src/app.ts` (routes),
`src/server.ts` (graceful shutdown), `src/pauseGuard.ts` (pause state),
`src/config.ts` (environment variables).

---

## Quick reference

| Endpoint | Healthy | Unhealthy | Hits the RPC? |
|---|---|---|---|
| `GET /health/live` | `200 {"status":"ok"}` | No response at all (process down or hung) | No |
| `GET /health/ready` | `200 {"status":"ready"}` (or `"degraded"`) | `503 {"status":"unready"}` | Yes, at most once per `HEALTH_CACHE_MS` |
| `GET /health` | `200 {"status":"ok", ...}` | `503 {"status":"draining"}` during shutdown | No |

| Variable | Default | Effect |
|---|---|---|
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per-check timeout for `/health/ready` |
| `HEALTH_CACHE_MS` | `10000` | How long a readiness report is reused |
| `STELLAR_RPC_URL` | `https://soroban-testnet.stellar.org` | RPC for the `rpc`, `network` and `contract` checks |
| `STELLAR_NETWORK` | `testnet` | Selects the expected passphrase |
| `STELLAR_NETWORK_PASSPHRASE` | Derived from `STELLAR_NETWORK` | Overrides the expected passphrase |
| `ESCROW_CONTRACT_ID` | Built-in testnet contract | Contract looked up by the `contract` check |
| `SHUTDOWN_GRACE_MS` | `10000` | How long `/health` reports `draining` before connections are force-closed |
| `API_PAUSED` | unset | `true` forces `paused: true, pauseSource: "env"` on `/health` |
| `PAUSE_CHECK_CHAIN` | unset (chain check on) | `false` skips the on-chain `is_paused()` lookup |
| `PAUSE_CHECK_TTL_MS` | `10000` | Cache lifetime of the on-chain pause state |
| `PAUSE_FAIL_MODE` | `open` | `closed` reports paused when the pause lookup fails |

---

## First look

Set `BASE` to the instance you are checking, then run:

```bash
BASE=http://localhost:3001

curl -s -o /dev/null -w '%{http_code}\n' "$BASE/health/live"
curl -s -w '\n%{http_code}\n' "$BASE/health/ready" | jq .
curl -s "$BASE/health" | jq .
```

Read `checks` in the `/health/ready` body. Each failing check carries a fixed
`detail` string; find it in the table below.

| Check | `detail` | Go to |
|---|---|---|
| any | `timeout` | [A check times out](#a-check-times-out) |
| any | `check raised` | [A check raised](#a-check-raised) |
| `rpc` | `rpc reported '<status>'` | [RPC is unhealthy](#rpc-is-unhealthy) |
| `network` | `passphrase mismatch: ...` | [Network passphrase mismatch](#network-passphrase-mismatch) |
| `network` | `no passphrase known for network ...` | [Network passphrase mismatch](#network-passphrase-mismatch) |
| `contract` | `contract instance ledger entry not found` | [Contract entry not found](#contract-entry-not-found) |
| `storage` | `store read failed` | [Store read failed](#store-read-failed) |

Remember that readiness reports are cached for `HEALTH_CACHE_MS`. Check
`checkedAt` in the body: if it is older than the moment you fixed something,
wait out the cache (default 10 s) and probe again.

---

## Troubleshooting

### A check times out

**Symptom:** one or more checks show `"detail": "timeout"` with `latencyMs`
close to `HEALTH_CHECK_TIMEOUT_MS`. When the RPC is unreachable, `rpc`,
`network` and `contract` usually time out together while `storage` passes.

1. Confirm the RPC answers from the instance's network:
   ```bash
   curl -s -X POST "$STELLAR_RPC_URL" \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}'
   ```
2. If it answers, but slowly, compare its latency with
   `HEALTH_CHECK_TIMEOUT_MS`. Raise the timeout only if the RPC is
   legitimately slow, and keep the orchestrator's probe timeout above it.
3. If it does not answer, check DNS, egress firewall rules and the RPC
   provider's status, or point `STELLAR_RPC_URL` at another provider and
   restart.

### A check raised

**Symptom:** `"detail": "check raised"`. The RPC call threw instead of
returning, typically a connection refused, TLS error or malformed URL. The raw
error is deliberately not exposed by the probe.

1. Verify `STELLAR_RPC_URL` is a full URL (`https://...`). Plain `http://` is
   allowed by the client but should only be used for local RPC nodes.
2. Run the `getHealth` call from [A check times out](#a-check-times-out) step 1
   to see the actual error.
3. For `contract` only: an invalid `ESCROW_CONTRACT_ID` (not a valid `C...`
   strkey) makes building the ledger key throw. Check the value.

### RPC is unhealthy

**Symptom:** `rpc` fails with `rpc reported '<status>'`, where `<status>` is
whatever the RPC's `getHealth` returned instead of `healthy`.

1. The RPC node itself is reporting a problem (often lagging behind the
   network). This is on the provider's side.
2. Switch `STELLAR_RPC_URL` to a healthy provider and restart, or wait for the
   node to catch up.

### Network passphrase mismatch

**Symptom:** `network` fails with
`passphrase mismatch: configured '<STELLAR_NETWORK>', rpc reported '<passphrase>'`.
The RPC serves a different Stellar network than the backend is configured for.
Transactions built by this instance would be rejected.

1. Compare `STELLAR_NETWORK` with the network of `STELLAR_RPC_URL`:

   | `STELLAR_NETWORK` | Expected passphrase |
   |---|---|
   | `testnet` (default) | `Test SDF Network ; September 2015` |
   | `mainnet`, `public` | `Public Global Stellar Network ; September 2015` |
   | `futurenet` | `Test SDF Future Network ; October 2022` |
   | anything else | testnet passphrase, unless `STELLAR_NETWORK_PASSPHRASE` is set |

2. Fix whichever of `STELLAR_NETWORK` or `STELLAR_RPC_URL` is wrong. For a
   custom or local network, set `STELLAR_NETWORK_PASSPHRASE` to the exact
   passphrase the RPC reports.
3. Restart the instance; configuration is read at startup.

The `no passphrase known for network ...` variant only occurs when
`HealthService` is constructed without a passphrase (for example in tests).
The app always passes `config.networkPassphrase`, so in a deployed instance
use the mismatch steps above.

### Contract entry not found

**Symptom:** `contract` fails with `contract instance ledger entry not found`.
The RPC answered, but there is no persistent contract-instance ledger entry for
`ESCROW_CONTRACT_ID` on that network.

1. Confirm `ESCROW_CONTRACT_ID` is the contract deployed on the network that
   `STELLAR_NETWORK` / `STELLAR_RPC_URL` point at. A testnet contract ID will
   not exist on mainnet and vice versa.
2. Look the contract up on a block explorer for that network.
3. On testnet, check whether the network was reset or the contract instance
   archived; redeploy or restore it and update `ESCROW_CONTRACT_ID`.

### Store read failed

**Symptom:** `storage` fails with `store read failed`. `EscrowStore.list()`
threw. The store is in memory, so this indicates a bug or a corrupted state
(for example after loading a bad `STORE_SNAPSHOT_PATH` snapshot), not an
external outage.

1. Check the instance logs for the exception around `checkedAt`.
2. Restart the instance. If it recurs after restart with a snapshot configured,
   move the snapshot file aside and start again.
3. File a bug with the logs.

### Readiness stays unready after a fix

Reports, including failed ones, are cached for `HEALTH_CACHE_MS`. Wait for the
cache to expire and probe again. Environment-variable changes need a restart.

### `/health` returns 503 `{"status":"draining"}`

The process received `SIGTERM` or `SIGINT` and is shutting down. This is
expected during deploys and scale-down. It will exit within `SHUTDOWN_GRACE_MS`
(default 10 s); exit code `1` means in-flight requests had to be force-closed.
If an instance stays draining much longer than that, it is hung: kill it.

### `/health` has no `checks` field

`checks` only appears after `/health/ready` has run at least once in that
process. Call `/health/ready` (or wait for the orchestrator's readiness probe)
and look again. `/health` never runs the checks itself.

### `/health` reports `paused: true`

Not a health failure. While paused, the guarded mutation routes listed in
`GUARDED_ROUTES` (`src/pauseGuard.ts`: create, deposit, release milestone,
dispute, cancel) answer `503 contract_paused` with `Retry-After: 60`; reads
keep working.

| `pauseSource` | Cause | Action |
|---|---|---|
| `env` | `API_PAUSED=true` operator override | Unset `API_PAUSED` and restart when the pause should end |
| `chain` | The escrow contract's `is_paused()` returned true, or the lookup failed with `PAUSE_FAIL_MODE=closed` | Check the contract's pause state; check RPC reachability if fail-closed |

The value is refreshed in the background every `PAUSE_CHECK_TTL_MS`, so a
change on chain can take that long to appear.

### `/health/live` does not answer

The process is down or its event loop is blocked. Check that it is running,
inspect logs for a startup error (an invalid integer in
`HEALTH_CHECK_TIMEOUT_MS`, `HEALTH_CACHE_MS` or another `envInt` variable
stops the process with `Invalid <NAME>: "<value>"`), and restart it.

---

## Escalation

1. Note the instance, the full `/health/ready` body and its `checkedAt`.
2. If every instance fails `rpc`/`network`/`contract` at the same time, treat
   it as an RPC provider or network incident.
3. If a single instance fails, take it out of rotation and compare its
   environment variables with a healthy instance.

## Related

- [`docs/health.md`](health.md): endpoint reference
- [`docs/configuration.md`](configuration.md): environment variables
- [`docs/deploy.md`](deploy.md): deployment and probe wiring
- [`docs/observability.md`](observability.md): metrics and logging
