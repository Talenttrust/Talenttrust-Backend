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

Storage defaults to in-memory demo data, with no database required. On serverless hosting this
is per-instance and resets on redeploy. Self-hosted deployments can opt into SQLite persistence.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Service info and endpoint list (JSON) |
| GET | `/health` | Health check including `storage: "memory"` or `"sqlite"` |
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

Configuration (all optional, see `.env.example`): `PORT`, `ESCROW_CONTRACT_ID`, `STELLAR_NETWORK`,
`STELLAR_RPC_URL`, `FRONTEND_URL`, plus the storage settings below.

### Storage configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `STORAGE_DRIVER` | `memory` | `memory` or `sqlite`; other values fail startup |
| `SQLITE_PATH` | `./data/talenttrust.db` | SQLite file; parent directories are created automatically |
| `SEED_DEMO_DATA` | enabled | Set exactly `false` to disable demo engagements; otherwise seed only an empty store |

Use Node 20 to install dependencies and regenerate `package-lock.json` (also used in CI).
`better-sqlite3` is pinned to 12.9.0, which publishes Node 20 binaries for Windows/Linux x64;
it installs a native binary; unsupported platforms need a working native build toolchain.

```bash
npm ci
npm run build
STORAGE_DRIVER=sqlite SQLITE_PATH=./data/talenttrust.db SEED_DEMO_DATA=false PORT=3001 npm start
# In a second terminal:
curl -s -XPOST localhost:3001/api/v1/contracts -H 'content-type: application/json' \
  -d '{"client":"GA","freelancer":"GB","milestones":[100]}'
curl -s -XPOST localhost:3001/api/v1/contracts/1/deposit -H 'content-type: application/json' -d '{"amount":100}'
# Stop and restart with the same environment/file, then:
curl -s localhost:3001/api/v1/contracts
curl -s localhost:3001/health
```

SQLite is for self-hosted deployments on a persistent local disk. Vercel's filesystem is read-only
except for ephemeral `/tmp`; SQLite there does not provide durable or shared storage. Keep the
memory default on Vercel. Multiple processes using the same local SQLite file share IDs and data;
separate files/hosts do not. Back up the database using SQLite-aware tooling (including WAL data).

`src/repo/types.ts` defines the async adapter contract. `EscrowService` owns validation and the
state machine; `EscrowStore` remains an import alias, with async operations. Every mutation,
including seeding and reputation issuance, runs in a transaction. Nested calls join the parent;
a nested failure aborts the whole transaction. Await all operations inside a transaction and keep
callbacks short (no network I/O). SQLite uses explicit transactions across awaits, queued access
per connection and a five-second asynchronous retry for other writers. Reads return detached values.
Updates compare `updatedAt` and reject stale versions with HTTP 409 `write_conflict`.

Migrations in `src/repo/migrations.ts` run atomically on open, recording versions in `schema_version`;
reopening applies only missing migrations. Add future migrations at the end of the list.
Tests cover both adapters, rollback, concurrent requests and SQLite reopen persistence.
`createApp(service)` accepts an unseeded service for tests. Default apps expose an initialization
promise at `app.locals.ready` and an async `app.locals.close()` that releases the database after
in-flight operations. The standalone server drains requests on SIGINT/SIGTERM before closing.

The only intentional HTTP response change is `/health.storage`: `in-memory` becomes `memory`,
and SQLite reports `sqlite`. Existing endpoint inputs and successful response shapes are preserved.
Asynchronous storage failures return the existing sanitized HTTP 500 error envelope.

## Deployment

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and
`vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
