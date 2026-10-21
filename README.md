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

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info and endpoint list (JSON) |
| GET | `/health` | Health check |
| GET | `/docs` | Swagger UI |
| GET | `/openapi.json` | OpenAPI 3 spec |
| GET | `/api/v1/chain` | On-chain contract deployment info |
| GET | `/api/v1/stats` | Aggregate statistics |
| GET/POST | `/api/v1/contracts` | List (`?status=`, `?party=`) / create escrow contracts |
| GET | `/api/v1/contracts/:id` | Get a contract |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | `{ "rating": 5 }` |
| GET | `/api/v1/reputation/:address` | Freelancer reputation |

## Development

```bash
npm ci
npm run dev      # http://localhost:3001
npm run lint     # type check
npm test
npm run build && npm start
```

Configuration (all optional, see `.env.example`): `PORT`, `LOG_LEVEL` (debug|info|warn|error|silent, default info; silent in tests),
`ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `FRONTEND_URL`, `CORS_ORIGINS`.

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

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
