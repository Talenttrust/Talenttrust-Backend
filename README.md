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

Method handling follows the router registry in `src/routes.ts`:

- An unsupported method on a known path returns `405` with an `Allow` header and
  `{ "error": "method_not_allowed", "message": "...", "allowed": [...] }`.
- `OPTIONS` on a known path returns `204` with `Allow` (CORS preflight responses
  keep their CORS headers).
- `HEAD` is supported for every `GET` route.
- Unknown paths still return `404` with `{ "error": "not_found", ... }`.

The same registry generates the `endpoints` list served by `GET /` and the
`405` response documented for every OpenAPI operation.

## Development

```bash
npm ci
npm run dev      # http://localhost:3001
npm run lint     # type check
npm test
npm run build && npm start
```

Configuration (all optional, see `.env.example`): `PORT`, `ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`,
`STELLAR_RPC_URL`, `FRONTEND_URL`.

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
