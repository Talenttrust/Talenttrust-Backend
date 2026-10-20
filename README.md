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
| POST/GET | `/api/v1/webhook-subscriptions` | Create or list signed webhook subscriptions |
| GET/PATCH/DELETE | `/api/v1/webhook-subscriptions/:id` | Manage a subscription without exposing its secret |
| POST | `/api/v1/webhook-subscriptions/:id/rotate-secret` | Rotate a subscription secret |
| GET | `/api/v1/webhook-subscriptions/:id/deliveries` | Bounded delivery history |

## Development

```bash
npm ci
npm run dev      # http://localhost:3001
npm run lint     # type check
npm test
npm run build && npm start
```

Configuration (all optional, see `.env.example`): `PORT`, `ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`,
`STELLAR_RPC_URL`, `WEBHOOK_ADMIN_TOKEN`, `FRONTEND_URL`.

Webhook management is disabled when `WEBHOOK_ADMIN_TOKEN` is unset. When configured, management
requests use `Authorization: Bearer <token>`. Create a subscription with `{ "url":
"https://example.com/events", "events": ["milestone.released"] }`; the generated `whsec_`
secret is returned only in that creation response and again when explicitly rotated. Delivery
payloads are signed as `sha256=HMAC_SHA256(secret, timestamp + "." + rawBody)` and include
`X-Timestamp`, `X-Event-Type`, and `X-Event-ID`. Delivery is asynchronous, retries transient
failures up to six attempts with exponential backoff and jitter, and retains bounded delivery
history. Public hosting rejects private, loopback, link-local, and reserved DNS destinations;
`http://localhost` is allowed only for local development. DNS can still change after validation,
so production deployments should use egress controls as defense in depth.

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
