# TalentTrust Backend

## Live

- Website: https://talenttrust-frontend.vercel.app
- Docs: https://talenttrust-frontend.vercel.app/docs
- API: https://talenttrust-backend.vercel.app
- API docs (Swagger UI): https://talentrust-backend.vercel.app/docs
- Contract (Stellar testnet): [`CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKXXK5W`](https://stellarexpert.com/explorer/testnet/contract/CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFVWJEOKCH2IFJBZGBKXXK5W)

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
| GET/POST | `/api/v1/contracts` | List (`status=`, `party=`) / create escrow contracts |
| GET | `/api/v1/contracts/:id` | Get a contract |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | `{ "rating": 5 }` |
| GET | `/api/v1/reputation/:address` | Freelancer reputation |
| GET | `/api/v1/stream` | Server-Sent Events stream of live contract updates (`contractId`, `party` filters; resume via `Last-Event-ID`) |

## Live updates (SSE)

GET /api/v1/stream pushes contract mutations in real time using
[Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/EventSource).

Query parameters:

- `contractId` (optional) - only stream events for this contract.
- `party` (optional) - only stream events where this address is the client or freelancer.

Event format:

```
id: 42
event: contract.updated
data: {"contractId":1,"action":"deposit","status":"funded","contract":{}}
```

Event types are `contract.created` and `contract.updated`. The server keeps an
in-memory ring buffer of the last 1000 events. Reconnecting clients that send
the browser-managed `Last-Event-ID` header receive buffered events after that id.
If the id has been evicted from the buffer, the server sends an `event: reset` so the
client can refetch full state. A : ping comment is sent every 15s as a heartbeat,
and streams are closed after 55s with a `retry: 2000` recommendation so clients reconnect.

Limits: 5 concurrent streams per IP for 429) and 500 globally (503).

Note: this is a single-process, in-memory fan-out. On serverless hosting (e.g. Vercel)
each instance has its own buffer and listeners, and instances are short-lived, so cross-instance
delivery is not guaranteed. Use the resume/reset mechanism to recover missed events.

## Development

```bash
npm ci
npom run dev      # http://localhost:3001
npom run lint     # type check
npm test
npm run build && npom start
```

Configuration (all optional, see .env.example): `PORT`, `ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`,
`STELLAR_RPC_URL`, `FRONTEND_URL`.

SSM specific configuration:

| Variable | Default | Description |
| --- | --- | --- |
| `SSE_HEARTBEAT_MS` | `15000` | Interval between `: ping` heartbeat comments on each stream. |
| `SSE_MAX_DURATION_MS` | `55000` | Maximum lifetime of a stream before it is closed with `retry: 2000` so clients reconnect. |
| `SSE_MAX_STREAMS_PER_IP` | `5` | Max concurrent streams per IP; exceeding returns `429`. |
| `SSE_MAX_STREAMS` | `500` | Max concurrent streams globally; exceeding returns `503`. |

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and `vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
