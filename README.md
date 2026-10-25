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

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info and endpoint list (JSON) |
| GET | `/health` | Health check |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3 spec |
| GET | `/api/v1/chain` | On-chain contract deployment info |
| GET | `/api/v1/stats` | Aggregate statistics |
| GET | `/api/v1/auth/challenge` | Request a sign challenge (`?address=G…`) |
| POST | `/api/v1/auth/token` | Exchange a signed challenge for a bearer token |
| POST | `/api/v1/tx/build` | Build a simulated, unsigned Soroban transaction for a wallet to sign `{ "action": "...", "source": "G…", "args": {} }` |
| GET/POST | `/api/v1/contracts` | List (`?status=a,b`, `?party=`, `?role=`, `?token=`, `?createdAfter=`, `?createdBefore=`, `?linked=true\|false`, `?fields=`, `?sort=`, `?limit=` 1-100 default 20, `?cursor=`) / create escrow contracts; list responses are `{ data, page: { limit, nextCursor, hasMore } }` |
| GET | `/api/v1/contracts/:id` | Get a contract (`?fields=`) |
| PATCH | `/api/v1/contracts/:id` | Edit an unfunded contract; `{ "client": "G...", "title": "...", "milestones": [{ "title": "...", "amount": 150 }] }` |
| DELETE | `/api/v1/contracts/:id` | Withdraw an unfunded contract; `{ "client": "G..." }` |
| GET | `/api/v1/contracts/:id/revisions` | Get contract term revision history |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/extend-deadline` | `{ "client": "G...", "fundingDeadline": "2026-01-15T00:00:00.000Z" }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | Client rates freelancer: `{ "rating": 5 }` (backward-compatible) |
| POST | `/api/v1/contracts/:id/reviews` | Two-sided review: `{ "reviewer": "G...", "rating": 5, "comment": "..." }` |
| POST | `/api/v1/contracts/:id/link` | Link to on-chain escrow `{ "escrowId": "3" }` |
| GET | `/api/v1/contracts/:id/parity` | Parity check report against on-chain state |
| GET | `/api/v1/reputation/:address` | Reputation (freelancer fields + `asClient`) |
| GET | `/api/v1/reputation/:address/reviews` | Reviews received (`?role=`, `?limit=`, `?cursor=`) |
| GET | `/.well-known/talenttrust-receipts.json` | Published ed25519 public keys for offline verification |
| GET | `/api/v1/contracts/:id/receipt` | Get detached signed JWS receipt for contract state |
| POST | `/api/v1/receipts/verify` | Verify JWS receipt and check against current state |
| GET/POST | `/api/cron/expire-contracts` | Authenticated daily sweep of due unfunded contracts |
| GET | `/metrics` | Prometheus exposition-format metrics (requires `Authorization: Bearer <METRICS_TOKEN>`; disabled when `METRICS_TOKEN` unset) |

*Note: All contract mutation endpoints accept `?receipt=true` to attach a signed `Receipt` JWS header.*

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

Every `POST` under `/api/v1` accepts an optional `Idempotency-Key` header (1-255 printable ASCII
characters), following `draft-ietf-httpapi-idempotency-key-header`. Retrying a request with the same key
and body replays the stored response with `Idempotent-Replayed: true` instead of applying it again.

| Situation | Result |
| --- | --- |
| Same key, same body, first request finished | Stored status and body replayed, `Idempotent-Replayed: true` |
| Same key, different body | `422 idempotency_key_reused` |
| Same key while the first request is still running | `409 idempotency_request_in_progress`, `Retry-After: 1` |
| Malformed key | `400 invalid_idempotency_key` |
| No key | Current behaviour, unless `IDEMPOTENCY_REQUIRED=true` (`400 idempotency_key_required`) |

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
`ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE`, `TX_TIMEOUT_SECONDS`, `FRONTEND_URL`, `IDEMPOTENCY_REQUIRED`, `AUTH_SECRET`, `AUTH_REQUIRED`,
`RECEIPT_SIGNING_SECRET` (Stellar `S...` ed25519 seed), and `CRON_SECRET` (required to authenticate
`GET`/`POST /api/cron/expire-contracts`). New contracts default to a funding deadline 14 days after
creation; explicit deadlines must be between one hour and 90 days in the future. Contracts still unfunded
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

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
