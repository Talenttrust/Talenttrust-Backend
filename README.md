# TalentTrust Backend

## Live

- Website: https://talenttrust-frontend.vercel.app
- Docs: https://talenttrust-frontend.vercel.app/docs
- API: https://talenttrust-backend.vercel.app
- API docs (Swagger UI): https://talenttrust-backend.vercel.app/docs
- Contract (Stellar testnet): [`CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W`](https://stellar.expert/explorer/testnet/contract/CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKTXK5W)

Express + TypeScript API for TalentTrust, a milestone-based freelancer escrow protocol on Stellar.
The API mirrors the state machine of the Soroban escrow contract
([Talenttrust-Contracts](https://github.com/Talenttrust/Talenttrust-Contracts)) so clients and
freelancers can create engagements, fund escrow, release milestones, raise disputes and build reputation.

Storage is in-memory (seeded with demo data), so no database is required. On serverless hosting the
data is per-instance and resets on redeploy.

## Endpoints

All `GET` endpoints for contracts return strong `ETag` and `Cache-Control: no-cache` headers and support `If-None-Match` conditional requests (returning `304 Not Modified` when matched). All `POST /api/v1/contracts/:id/*` mutation endpoints support `If-Match` for optimistic concurrency control (returning `412 Precondition Failed` on mismatch and `428 Precondition Required` when mandatory).

When the escrow contract is paused on-chain (`is_paused`, cached for `PAUSE_CHECK_TTL_MS`) or via the `API_PAUSED=true` operator override, mutations that mirror Soroban functions calling `require_not_paused` (`create`, `deposit`, `release`, `dispute`, `cancel`) are rejected with `503 Service Unavailable` (`Retry-After: 60`, `contractError: { name: 'Paused', code: 4 }`). Read-only endpoints as well as dispute resolution (`resolve`) and reputation rating (`reputation`) remain active.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info and endpoint list (JSON) |
| GET | `/health` | Health check (includes `paused`, `pauseSource` and, once a probe ran, the last readiness `checks`) |
| GET | `/health/live` | Liveness probe (always 200 while the process is up) |
| GET | `/health/ready` | Readiness probe: Soroban RPC, network passphrase, contract, storage |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3 spec |
| GET | `/api/v1/chain` | Deployment info, pause state (`paused`, `pauseSource`) and live on-chain status (`onChain`: `version`, `paused`, `contractCount`, `admin`, `latestLedger`); `?refresh=true` bypasses the 15s cache (rate-limited to once per 5s) |
| GET | `/api/v1/chain/contracts/:chainId` | Read an escrow contract directly from Soroban (`source: "chain"`, amounts as exact decimal strings) |
| GET | `/api/v1/chain/reputation/:address` | Read a freelancer's reputation directly from Soroban |
| GET | `/api/v1/chain/events` | Indexed contract events (`?escrowId=`, `?type=`, `?limit=`, `?cursor=`), newest first |
| GET | `/api/v1/chain/indexer` | Event indexer status (cursor, last run, last error, lag) |
| GET/POST | `/api/cron/index-events` | Index a batch of contract events (`Authorization: Bearer $CRON_SECRET`) |
| GET | `/api/v1/parties/:address/statement.csv` | Downloadable RFC 4180 CSV statement for an address (`?from=&to=&role=client\|freelancer\|all&bom=true`; formula-injection safe) |
| GET | `/api/v1/parties/:address/statement.json` | Same rows as JSON |
| GET | `/api/v1/state-machine` | Transition table, actor enforcement metadata and generated Mermaid diagram |
| GET | `/api/v1/contracts/:id/actions?as=<address>` | Allowed actions now, with error codes/reasons, releasable indexes and remaining deposit capacity |
| GET | `/api/v1/stats` | Aggregate statistics |
| GET | `/api/v1/auth/whoami` | Id and scopes of the presented scoped API key |
| GET | `/api/v1/auth/challenge` | Request a sign challenge (`?address=G…`) |
| POST | `/api/v1/auth/token` | Exchange a signed challenge for a bearer token |
| POST | `/api/v1/tx/build` | Build a simulated, unsigned Soroban transaction for a wallet to sign `{ "action": "...", "source": "G…", "args": {} }` |
| GET/POST | `/api/v1/contracts` | List (`?status=a,b`, `?party=`, `?role=`, `?token=`, `?createdAfter=`, `?createdBefore=`, `?linked=true\|false`, `?fields=`, `?sort=`, `?limit=` 1-100 default 20, `?cursor=`) / create escrow contracts; list responses are `{ data, page: { limit, nextCursor, hasMore } }` |
| GET | `/api/v1/contracts/:id` | Get a contract (`?fields=`) |
| GET | `/api/v1/contracts/:id/stream` | Live contract events via Server-Sent Events (`Last-Event-ID` resumes from the in-process 500-event buffer) |
| PATCH | `/api/v1/contracts/:id` | Edit an unfunded contract; `{ "client": "G...", "title": "...", "milestones": [{ "title": "...", "amount": 150 }] }` |
| DELETE | `/api/v1/contracts/:id` | Withdraw an unfunded contract; `{ "client": "G..." }` |
| GET | `/api/v1/contracts/:id/revisions` | Get contract term revision history |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/extend-deadline` | `{ "client": "G...", "fundingDeadline": "2026-01-15T00:00:00.000Z" }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` — requires a scoped API key with `disputes:resolve` (`X-API-Key`) when `API_KEYS` is set |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | Client rates freelancer: `{ "rating": 5 }` (backward-compatible) |
| POST | `/api/v1/contracts/:id/reviews` | Two-sided review: `{ "reviewer": "G...", "rating": 5, "comment": "..." }` |
| POST | `/api/v1/contracts/:id/link` | Link to on-chain escrow `{ "escrowId": "3" }` (demo fixture for `"3"` is gated by `ENABLE_DEMO_CHAIN_FIXTURE`) |
| GET | `/api/v1/contracts/:id/parity` | Parity check report against on-chain state |
| GET | `/api/v1/reputation` | Ranked freelancer leaderboard (`?sort=score\|completed\|average&minCompleted=&limit=&cursor=`) |
| GET | `/api/v1/reputation/:address` | Reputation (freelancer fields + `asClient`) |
| GET | `/api/v1/reputation/:address/reviews` | Reviews received (`?role=`, `?limit=`, `?cursor=`) |
| GET | `/.well-known/talenttrust-receipts.json` | Published ed25519 public keys for offline verification |
| GET | `/api/v1/contracts/:id/receipt` | Get detached signed JWS receipt for contract state |
| POST | `/api/v1/receipts/verify` | Verify JWS receipt and check against current state |
| GET/POST | `/api/cron/expire-contracts` | Authenticated daily sweep of due unfunded contracts |
| GET/POST | `/api/cron/reconcile-parity` | Authenticated parity reconciliation for all linked contracts (bounded concurrency and time budget); reports in-sync/drifted/unreachable counts and drifted contract IDs, emits `contract.drift_detected`, and updates parity metrics |
| GET | `/api/v1/disputes` | Admin dispute queue (`?status=`, `?sort=`, `?overdue=`, `?limit=`, `?cursor=`), requires `Authorization: Bearer $ADMIN_READ_TOKEN` |
| GET | `/api/v1/disputes/:contractId` | Dispute view for one contract (404 if it never had a dispute), same auth |
| POST | `/api/v1/tx/submit` | Validate and relay a signed escrow transaction (`{ "xdr": "..." }`) |
| GET | `/api/v1/tx` | List recent relayed transactions (`?limit=`) |
| GET | `/api/v1/tx/:hash` | Transaction status, decoded `returnValue` and `contractError` (`?wait=true` long-polls up to 20s) |
| POST/GET | `/api/v1/webhook-subscriptions` | Create or list signed webhook subscriptions |
| GET/PATCH/DELETE | `/api/v1/webhook-subscriptions/:id` | Manage a subscription without exposing its secret |
| POST | `/api/v1/webhook-subscriptions/:id/rotate-secret` | Rotate a subscription secret |
| GET | `/api/v1/webhook-subscriptions/:id/deliveries` | Bounded delivery history |
| POST/GET | `/api/v1/templates` | Create a milestone template (`fixed` amounts or `percent` bps summing to 10000) / list by `?owner=` |
| GET/PUT/DELETE | `/api/v1/templates/:id` | Get / update (owner only, bumps `version`) / delete (owner only) a template |
| GET | `/api/v1/contracts/:id/history` | Hash-chained audit history of a contract (`?limit=`, `?cursor=`) |
| GET | `/api/v1/audit/verify` | Verify audit chain integrity (`{ valid, entries, truncatedBeforeSeq, maxEntries, brokenAt? }`) |
| GET | `/metrics` | Prometheus exposition-format metrics (requires `Authorization: Bearer <METRICS_TOKEN>`; disabled when `METRICS_TOKEN` unset) |

*Note: All contract mutation endpoints accept `?receipt=true` to attach a signed `Receipt` JWS header.*

## Webhooks

Webhook management is disabled (404) when `WEBHOOK_ADMIN_TOKEN` is unset. When configured, management
requests use `Authorization: Bearer <token>`. Create a subscription with `{ "url":
"https://example.com/events", "events": ["milestone.released"], "filter": { "parties": ["G..."], "contractIds": [42] } }`; `filter` is optional, and either array may contain up to 50 entries. When both are present, both criteria must match; parties match a contract's `client` or `freelancer`, and IDs match its `id`. A filtered subscription skips events without `data.contract`. Filters are returned by GET and can be changed with PATCH; send `"filter": null` to clear one. Invalid filters return `400 invalid_filter`. The generated `whsec_`
secret is returned only in that creation response and again when explicitly rotated. Events:
`contract.created`, `contract.updated`, `contract.funded`, `milestone.released`, `dispute.raised`,
`dispute.resolved`, `contract.cancelled`, `reputation.issued`, `contract.drift_detected` (dispute reasons are never included). Delivery
payloads are signed as `sha256=HMAC_SHA256(secret, timestamp + "." + rawBody)` and include
`X-Timestamp`, `X-Event-Type`, and `X-Event-ID`. Delivery is asynchronous, retries transient
failures up to six attempts with exponential backoff and jitter, and retains bounded delivery
history. Public hosting rejects private, loopback, link-local, and reserved DNS destinations;
`http://localhost` is allowed only outside production. DNS can still change after validation,
so production deployments should use egress controls as defense in depth.

## Milestone templates

`POST /api/v1/contracts` accepts `{ templateId, budget?, client, freelancer, token?, title? }` instead of
`milestones`. Fixed templates copy their amounts (`budget` not allowed); percent templates require `budget` and
give each milestone `floor(budget * percentBps / 10000)`, adding the remainder to the last milestone. Supplying both
`templateId` and `milestones` is a 400. Contracts record `templateId` and `templateVersion`; editing or deleting a
template never changes contracts already created from it.

## Audit log

Every successful state transition (`create`, `deposit`, `release`, `dispute`, `resolve`, `cancel`, `rate`) appends an
entry with the before/after state (`status`, funded and released amounts), the authenticated actor, the request id and
action details (e.g. the resolution split). Failed or rejected requests never create entries. Entries are hash-chained
(`hash = sha256(prevHash + canonicalJSON(entry))`), so modification, deletion or reordering is detected by
`GET /api/v1/audit/verify`. The log is in-memory and bounded by `AUDIT_MAX_ENTRIES` (default 100,000), with the oldest entries
evicted first. Verification reports `truncatedBeforeSeq` when eviction has occurred and starts from the oldest retained entry.
Dispute reasons are not recorded.

## Admin dispute queue

The dispute queue returns `{ data, summary, page }`. `summary` (`open`, `overdue`, `totalHeld`) always
covers **all** disputes in the store, regardless of the query filters; `page.nextCursor` is an opaque
cursor for stable pagination (`limit` 1–100, default 20). Each `DisputeView` includes `ageHours`,
`held`/`heldUnits` (escrow still held while the dispute is open; 0 once resolved), `slaDeadline`
(`openedAt + DISPUTE_SLA_HOURS`, default 72h) and `overdue` (true only while open and strictly past the
deadline), plus `resolvedAt`/`freelancerBps` once resolved. Dispute **reasons are confidential**: they are
served only by these two authenticated routes and are omitted from every public contract response and receipt.

## Reviews

Reviews are per-contract and two-sided: a client can rate a freelancer and a freelancer can
rate a client. Each direction is allowed once per contract and only after the contract reaches
`Completed` or `Resolved`. Reviews of `Resolved` contracts carry `context: 'disputed'`.

- `role` is derived from the reviewer: client → freelancer is `client_to_freelancer`, freelancer → client is
  `freelancer_to_client`.
- `comment` is optional, trimmed, at most 1000 characters, and must not contain control characters.
- Reviews are immutable (no edit/delete).

The legacy `POST /api/v1/contracts/:id/reputation` endpoint is equivalent to a client review of the
freelancer without a comment and still sets `reputationIssued`. A following client `POST /reviews` for the
same contract returns `409 already_reviewed`.

## Sparse fieldsets

GET `/api/v1/contracts` and GET `/api/v1/contracts/:id` accept a `?fields=` query parameter so
clients can download only the fields they need. `id` is always returned.

```
GET /api/v1/contracts?fields=title,status,totalAmount
GET /api/v1/contracts/1?fields=milestones.amount
```

Allowed top-level fields: `title`, `client`, `freelancer`, `token`, `milestones`, `totalAmount`,
`totalAmountUnits`, `fundedAmount`, `fundedAmountUnits`, `releasedAmount`, `releasedAmountUnits`,
`status`, `reputationIssued`, `dispute`, `chain`, `revision`, `createdAt`, `updatedAt`.
Use dot notation for milestone sub-fields: `milestones.index`, `milestones.title`,
`milestones.amount`, `milestones.amountUnits`, `milestones.released`. Unknown fields return `400 invalid_fields`.

## Response compression

JSON responses larger than 1 KB are compressed with gzip or Brotli when the client sends
`Accept-Encoding`. A `Vary: Accept-Encoding` header is set on compressed responses. Responses
are not compressed when `Cache-Control: no-transform` is present or the content type is
`text/event-stream`.
### Idempotency

Every `POST`, `PATCH`, `PUT` and `DELETE` under `/api/v1` accepts an optional `Idempotency-Key` header
(1-255 printable ASCII characters), following `draft-ietf-httpapi-idempotency-key-header`. Retrying a
request with the same key and body replays the stored response with `Idempotent-Replayed: true` instead
of applying it again. `DELETE` request bodies are optional and empty bodies fingerprint as `{}`.

| Situation | Result |
| --- | --- |
| Same key, same body, first request finished | Stored status and body replayed, `Idempotent-Replayed: true` |
| Same key, different body | `422 idempotency_key_reused` |
| Same key while the first request is still running | `409 idempotency_request_in_progress`, `Retry-After: 1` |
| Malformed key | `400 invalid_idempotency_key` |
| No key | Current behaviour, unless `IDEMPOTENCY_REQUIRED=true` on `POST` (`400 idempotency_key_required`; `PATCH`/`PUT`/`DELETE` remain optional) |

Keys are scoped by method, path and authenticated principal (if `req.user.id` is set). Responses with
status below 500 are kept for 24h (max 10,000 entries, LRU eviction); 5xx responses are not stored, so the
client can retry. Storage is in-memory and per-instance; the `IdempotencyStore` interface in
`src/idempotency.ts` allows a shared store later.

## Authentication

Mutating routes accept a **bearer token** obtained via the SEP-10-style wallet-signature flow:

1. `GET /api/v1/auth/challenge?address=G…` — receive a short-lived, HMAC-signed challenge string.
2. Sign the exact challenge string with your Stellar ed25519 private key (base64-encode the signature).
3. `POST /api/v1/auth/token` with `{ address, challenge, signature }` — receive an HS256 JWT (≤ 1 h).
4. Send `Authorization: Bearer <token>` on protected routes.

Tokens are **required** on `POST /contracts`, `PATCH`/`DELETE /contracts/:id`, `deposit`, `release`,
`dispute`, `cancel`, `reputation` and `reviews` when the server runs with `AUTH_SECRET` set (or
`AUTH_REQUIRED=true`); missing or invalid tokens get `401 unauthorized` with `WWW-Authenticate: Bearer`.
Without `AUTH_SECRET` the challenge flow uses a random per-process secret and unauthenticated requests keep
working as before, but a token that is sent is always verified.

For authenticated calls the token subject (`sub`) is the caller's Stellar address and the store enforces the
same party rules as the on-chain contract: `deposit`, `release`, `cancel`, `reputation` and contract
edits/withdrawals require the caller to be the contract client (`POST /contracts` forces `client` to the
caller); `dispute` and `reviews` require the client or freelancer. A body `raisedBy`/`reviewer`/`client` is
accepted for backwards compatibility but rejected (`403 forbidden`) if it differs from the token subject.

## Security

- **CORS allowlist**: cross-origin requests are answered only for `FRONTEND_URL`, extra origins listed
  in `CORS_ORIGINS` (comma-separated), local dev origins outside production, and the API's own origin.
  Any other `Origin` gets `403 origin_not_allowed` before a handler runs; requests without an `Origin`
  (curl, server-to-server) are unaffected.
- **CSP**: every response carries a `Content-Security-Policy` (no `unsafe-inline` scripts) that permits
  only self-hosted code plus the pinned Swagger UI assets on `/docs`.
- **SRI**: the `/docs` page loads `swagger-ui-dist@5.17.14` from unpkg with `sha384` `integrity`
  hashes and `crossorigin="anonymous"`; the page's inline style/script are allowed by exact `sha256`
  hashes derived from the served markup.

## Method handling

- An unsupported method on a known path returns `405 method_not_allowed` with an `Allow` header and
  `allowed: [...]` in the body. The supported methods are read from the routes registered on the app,
  so they always match the handlers.
- `OPTIONS` on a known path returns `204` with `Allow` (CORS preflight responses keep their CORS headers).
- `HEAD` is supported for every `GET` route.
- Unknown paths still return `404 not_found`.

## Scoped API keys

Operator-only routes use hashed, scoped API keys from `API_KEYS`, a JSON array of
`{ "id": "ops-1", "hash": "sha256:<64 hex>", "scopes": ["disputes:resolve"] }` (scopes: `disputes:resolve`,
`admin:read`, `contracts:write`). Malformed JSON, unknown scopes, duplicate ids or bad hashes stop the app at
startup. Send the key as `X-API-Key: <key>` or `Authorization: ApiKey <key>`; it is SHA-256 hashed and compared
against every configured digest in constant time, and never echoed back.

An entry may add an optional `"expiresAt"`, an ISO 8601 date-time with a timezone (`"2027-01-31T00:00:00Z"`)
or a bare date (`"2027-01-31"`, read as UTC midnight). From that instant on the key is rejected with
`401` "API key expired", so rotating a contractor's key is a config change rather than a manual removal. An
invalid `expiresAt` stops the app at startup with the key id in the message. Entries without `expiresAt` never
expire and behave exactly as before.

- `POST /api/v1/contracts/:id/resolve` needs `disputes:resolve` (401 without/with an invalid key, 403
  `insufficient_scope` with `required`); the key id is stored as `dispute.resolvedBy`. With `NODE_ENV=production`
  and no `API_KEYS`, resolution fails closed (401); outside production with no keys configured it stays open for
  local development.
- `GET /api/v1/auth/whoami` returns `{ keyId, scopes, expiresAt }` for the presented key (`expiresAt` is an ISO
  8601 UTC string, or `null` for a key that never expires).
- `npm run apikey:new -- <id> <scope...>` prints a new `tt__…` key once plus the `API_KEYS` entry to add. Add
  `--expires-in-days <n>` (a positive whole number) to include an `expiresAt` n days from now.

## Health probes

Readiness (`/health/ready`) checks four dependencies in parallel — Soroban RPC `getHealth`, the
network passphrase, the escrow contract's ledger entry and the store — and answers `200 ready` /
`200 degraded` (only warnings) / `503 unready`. Results are cached for `HEALTH_CACHE_MS` with
single-flight, so a burst of probes performs at most one round of RPC calls. Failure details are
fixed strings and never include the RPC URL. `/health/live` never touches a dependency, and
`/health` reports the summary of the last readiness run once one has happened.

## Lifecycle discovery

The store and the discovery endpoints share `src/stateMachine.ts`, so discovery can never disagree with what the
mutations accept. Checks run in order: contract existence → actor → status → guards (the order the API has always
used). Discovery is read-only; `allowed` means there is a valid argument for that action right now.
`release.params.index` lists the currently releasable milestones and `deposit.params.maxDeposit` is the remaining
funding capacity as an exact base-unit decimal string.

`as` is an optional advisory address, used as `raisedBy` for the dispute party check (missing `as` makes dispute
unavailable); empty, repeated or structured values return `400 invalid_actor`. It is not authentication: only
`dispute` is actor-checked by the store itself (`actorEnforced: true`). Client-only actions are enforced for
wallet-authenticated callers and dispute resolution by scoped API keys, so their roles are listed with
`actorEnforced: false`.

## OpenAPI specification

The single source of truth for the OpenAPI document is `src/openapi.ts`, served
at `GET /openapi.json`. The committed `docs/openapi.json` is generated from
that exact export, using the app's default Stellar network and contract settings
so local environment variables cannot change the snapshot.

Regenerate the document after changing the API specification:

```bash
npm run openapi:export
npx jest tests/openapi-conformance.test.ts --runInBand
```

The conformance suite fails if `docs/openapi.json` is out of date. Do not edit
the generated JSON manually.

## Development

```bash
npm ci
npm run dev      # http://localhost:3001
npm run lint     # type check
npm test
npm run build && npm start
```

Configuration (all optional, see `.env.example`): `PORT`, `LOG_LEVEL` (debug|info|warn|error|silent, default info; silent in tests),
`METRICS_TOKEN` (protects `GET /metrics`; when unset the endpoint is disabled),
`CURSOR_SECRET` (signs contract-list cursors; random per-process default), `REQUIRE_IF_MATCH` (`true` makes `If-Match` mandatory on contract mutations),
`INDEXER_START_LEDGER` (first ledger to index; defaults to the RPC retention window), `API_KEYS` (scoped API keys, see below), `SSE_MAX_CONNECTIONS` (maximum concurrent contract event streams per app process; default 100), `HEALTH_CHECK_TIMEOUT_MS` (per readiness check, default 2000), `HEALTH_CACHE_MS` (readiness
`ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `TX_TIMEOUT_SECONDS`, `FRONTEND_URL`, `IDEMPOTENCY_REQUIRED`, `AUTH_SECRET`, `AUTH_REQUIRED`, `ENABLE_DEMO_CHAIN_FIXTURE` (enables the local `DEMO_ESCROW_3` fixture for `escrowId: "3"` in `SorobanRpcChainReader`; defaults to `true` when `NODE_ENV` is `development` or `test`, and `false` in `production`),
`BODY_LIMIT` (maximum request body size, default `100kb`), `CORS_ORIGINS` (extra comma-separated CORS origins), `INDEXER_INTERVAL_MS` (event-indexer poll interval for the long-running server, 0 = off),
`INDEXER_START_LEDGER` (first ledger to index; defaults to the RPC retention window), `INDEXER_MAX_RUN_MS` (maximum execution time budget per indexer run in milliseconds, default 8000), `INDEXER_MAX_PAGES` (maximum event pages fetched per run, default 5), `API_KEYS` (scoped API keys, see below), `HEALTH_CHECK_TIMEOUT_MS` (per readiness check, default 2000), `HEALTH_CACHE_MS` (readiness
result cache, default 10000), `REPUTATION_PRIOR_WEIGHT` (Bayesian prior weight C, default 5), `RPC_TIMEOUT_MS` (default 4000), `TX_CACHE_MAX` (recent relayed transactions kept, default 200), `CHAIN_READ_TTL_MS` (cache for the
`/api/v1/chain/contracts` and `/api/v1/chain/reputation` read-through endpoints, default 5000; identical concurrent
reads share one simulation and each client may make 60 chain reads per minute), `CHAIN_STATUS_TTL_MS`
(default 15000), `CHAIN_REFRESH_MIN_INTERVAL_MS` (default 5000),
`RECEIPT_SIGNING_SECRET` (Stellar `S...` ed25519 seed), and `CRON_SECRET` (required to authenticate
`GET`/`POST /api/cron/expire-contracts` and `/api/cron/index-events`). New contracts default to a funding deadline 14 days after
creation; explicit deadlines must be between one hour and 90 days in the future. GET/POST /api/cron/reconcile-parity (same CRON_SECRET bearer auth) checks every linked contract against the chain with bounded concurrency (5) and a time budget, returning counts (checked, inSync, drifted, unreachable), driftedContractIds, and 	imedOut; per-contract chain failures do not abort the run. Drifted contracts emit contract.drift_detected and update gauges escrow_parity_drift_contracts and escrow_parity_last_run_timestamp_seconds. Contracts still unfunded
(`Created`) at their deadline become `Expired` (lazily on read and by the daily Vercel cron sweep); any
partial funding is reported as `refundableAmount`/`refundableAmountUnits`. A client can extend a deadline
through the endpoint above.

`POST /api/v1/tx/build` assembles an unsigned `invokeHostFunction` transaction against the configured
escrow contract (`ESCROW_CONTRACT_ID`), simulates it via `STELLAR_RPC_URL`, and returns the assembled XDR
plus the addresses whose Soroban auth entries the wallet must sign. The server never holds or requires user
secret keys. `source` must be the Stellar account that the contract will `require_auth` (client for
create/deposit/release/cancel/issue_reputation, caller for open_dispute). `TX_TIMEOUT_SECONDS` (default 300)
sets the transaction timebounds so a leaked unsigned XDR cannot be signed and submitted much later.
`resolve_dispute` and `set_paused` are admin-only and not buildable.

Every request is assigned a correlation id. Send `X-Request-Id` (must match `^[A-Za-z0-9._-]{8,128}$`) and it is echoed back in the
`X-Request-Id` response header and included in every error JSON body. Access logs are emitted as structured JSON (one line per request) and
unexpected 500s are logged with a stack trace (never leaked to the client). Authorization, `x-api-key` and `Cookie` header values are redacted
and request bodies are never logged.

Standalone server timeouts (env, all optional): `KEEP_ALIVE_TIMEOUT_MS` (default 65000),
`HEADERS_TIMEOUT_MS` (default 66000, must be > keep-alive), `REQUEST_TIMEOUT_MS` (default 30000).
`SHUTDOWN_GRACE_MS` (default 10000) controls how long to wait for in-flight requests on shutdown.
`PORT` is validated: non-integer or out-of-range (1–65535) values cause a fast fail with a clear message.

On SIGTERM/SIGINT the server stops accepting connections, sets `Connection: close` on responses,
returns `503 { status: 'draining' }` from `/health` while draining, waits for in-flight requests up to
the grace deadline, then force-closes remaining sockets and exits.

## Request bodies

Routes that take a body (`POST /api/v1/contracts` and `/extend-deadline`, `/deposit`, `/dispute`, `/resolve`, `/reputation`, `/reviews`, `/link`) require `Content-Type: application/json`. Body-less POSTs (`/release`, `/cancel`) need no content type. Body failures return a stable error code (and the request's `requestId`):

| Situation | Status | Error code |
| --- | --- | --- |
| Body larger than `BODY_LIMIT` | 413 | `payload_too_large` |
| Non-JSON content type, unsupported charset or content encoding | 415 | `unsupported_media_type` |
| JSON body whose top level is not an object | 400 | `invalid_body` |
| Malformed JSON | 400 | `invalid_json` |
| Request aborted before the body was received | 400 | `request_aborted` |

## Snapshot persistence (self-hosted)

For self-hosted deployments running `src/index.ts`, set `STORE_SNAPSHOT_PATH` to persist `EscrowStore` state (contracts, revisions, templates, reputation, reviews, ID counters, and the hash-chained audit log) to a JSON file without introducing a database dependency.

- `STORE_SNAPSHOT_PATH`: path to the snapshot file (unset = disabled, pure in-memory mode).
- `STORE_SNAPSHOT_INTERVAL_MS`: periodic flush interval in milliseconds (default `30000`).

Snapshots are written atomically (temp file in the same directory + rename) on each interval and on graceful shutdown (`SIGTERM`/`SIGINT`). On startup, an existing snapshot is loaded and validated (including `schemaVersion` and the audit hash chain); a corrupt or newer-version file aborts startup immediately with a clear error.

**Limitations:**
- **Not enabled on Vercel** (`api/index.ts` remains pure in-memory; serverless filesystems are ephemeral).
- **Single-process only**: concurrent writers sharing one snapshot file are not supported.
- **Crash window**: an ungraceful crash (`SIGKILL`, power loss) can lose mutations made since the last interval flush.

The request body and parameter schemas published at `/openapi.json` (contracts: create, deposit, dispute,
resolve, reputation, cancel, the list query; templates: create, update, delete, owner query) are generated from
the zod validators in `src/validation/schemas.ts` with `z.toJSONSchema`, so changing a validator changes the spec.
Rules a JSON Schema cannot express (`.refine`, such as "client and freelancer must differ") are listed in the
operation's description. `tests/openapi-conformance.test.ts` fails if a documented request schema drifts from its
validator.

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
