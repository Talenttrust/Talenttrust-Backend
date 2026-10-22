# TalentTrust Backend

## Live

- Website: https://talenttrust-frontend.vercel.app
- Docs: https://talenttrust-frontend.vercel.app/docs
- API: https://talenttrust-backend.vercel.app
- API docs (Swagger UI): https://talenttrust-backend.vercel.app/docs
- Contract (Stellar testnet): [`CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCHIFIJBGZBKTXK5W`](https://stellar.expert/explorer/testnet/contract/CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCHIFIJBGZBKTXK5W)

Express + TypeScript API for TalentTrust, a milestone-based freelancer escrow protocol on Stellar.
The API mirrors the state machine of the Soroban escrow contract
([Talenttrust-Contracts](https://github.com/Talenttrust/Talenttrust-Contracts)) so clients and
freelancers can create engagements, fund escrow, release milestones, raise disputes and build reputation.

Storage is in-memory (seeded with demo data), so no database is required. On serverless hosting the
data is per-instance and resets on redeploy.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info and endpoint list (JSON) |
| GET | `/health` | Health check |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3 spec |
| GET | `/api/v1/chain` | On-chain contract deployment info |
| GET | `/api/v1/stats` | Aggregate statistics |
| GET/POST | `/api/v1/contracts` | List (`?status=`, `?party=`, `?linked=true\|false`) / create escrow contracts |
| GET | `/api/v1/contracts/:id` | Get a contract (includes `dispute.evidenceCount`) |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/dispute/evidence` | Submit evidence item `{ "submittedBy": "G...", "kind": "text" | "link" | "file_hash", ... }` |
| GET | `/api/v1/contracts/:id/dispute/evidence` | List evidence items and sealed digest `{ data, digest }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | `{ "rating": 5 }` |
| POST | `/api/v1/contracts/:id/link` | Link to on-chain escrow `{ "escrowId": "3" }` |
| GET | `/api/v1/contracts/:id/parity` | Parity check report against on-chain state |
| GET | `/api/v1/reputation/:address` | Freelancer reputation |

## Dispute evidence

Both parties can attach structured, content-hashed evidence to an open dispute.
Each item is `{ id, contractId, submittedBy, kind, text?, url?, sha256?, fileName?, submittedAt }`, where
`kind` is one of `text` (text ≤ 4000), `link` (https URL) or `file_hash` (sha256 64 hex + fileName ≤ 200).

Rules:

-  submittedBy` must be the contract client or freelancer (else `403 forbidden`).
- The contract must be in `Disputed` state (else `409 dispute_not_open`).
- At most 20 items per party per dispute (else `409 evidence_limit_reached`).
- Kind-specific fields are validated; invalid combinations return `400 invalid_evidence`.
- Text is trimmed and control characters (other than newline and tab) are rejected.
- After resolution the dispute is sealed: further submissions return `409 dispute_closed` and the `evidenceDigest` stored on the dispute equals the digest returned by `GET` before resolution.

The digest is `sha256` over the canonical JSON of all evidence items for the dispute, ordered by `submittedAt`.

## Development

```bash
npm ci
npm run dev      # http://localhost:3001
npm run lint     # type check
npm test
npm run build && npm start
```

Configuration (all optional, see `.env.example`): `PORT`, `LOG_LEVEL` (debug|info|warn|error|silent, default info; silent in tests),
`ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `FRONTEND_URL`.

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
`vercel.json` `rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT