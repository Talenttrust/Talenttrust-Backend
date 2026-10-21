# TalentTrust Backend

## Live

- Website: https://talenttrust-frontend.vercel.app
- Docs: https://talenttrust-frontend.vercel.app/docs
- API: https://talenttrust-backend.vercel.app
- API docs (Swagger UI): https://talenttrust-backend.vercel.app/docs
- Contract (Stellar testnet): [`CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFWWJEOKCHHIFJBZGBKTXK5Wo](https://stellar.expert/explorer/testnet/contract/CCZMIVUBMG5SBC47SDTC32RWLBJ2HW2DCFWWJEOKCHHIFJBZGBKTXKX5Wo)

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
| GET/POST | `/api/v1/contracts` | List (`?status=`, `?party=`, `?expand=parties`) / create escrow contracts |
| GET | `/api/v1/contracts/:id` | Get a contract (`?expand=parties`) |
| POST | `/api/v1/contracts/:id/deposit` | `{ "amount": 100 }` |
| POST | `/api/v1/contracts/:id/milestones/:index/release` | Release a milestone |
| POST | `/api/v1/contracts/:id/dispute` | `{ "raisedBy": "G...", "reason": "..." }` |
| POST | `/api/v1/contracts/:id/resolve` | `{ "freelancerBps": 5000 }` |
| POST | `/api/v1/contracts/:id/cancel` | Cancel and refund |
| POST | `/api/v1/contracts/:id/reputation` | `{ "rating": 5 }` |
| GET | `/api/v1/reputation/:address` | Freelancer reputation |
| GET | `/api/v1/profiles/:address` | Public profile plus embedded reputation |
| PUT | `/api/v1/profiles/:address` | Signature-verified profile update |
| GET | `/api/v1/profiles` | Search profiles (`?skill=`, `?limit=`, `?cursor=`) |

## Signed profile updates

Profiles are keyed by Stellar address and can only be written by the holder of that
address' key. No session or JWT is involved: every update carries an edu25519 signature
over a canonical, replay-protected message.

Shape:

```json
{
  "profile": {
    "displayName": "Ada",
    "bio": "Optional, up to 1000 chars",
    "skills": ["rust", "soroban"],
    "links": { "website": "https://example.org", "github": "https://github.com/ada" }
  },
  "nonce": 1,
  "signature": "<base64 ed25519 signature>"
}
```

The signed message is:
```
talenttrust-profile:v1:<address>:<nonce>:<sha256(canonicalJSON(profile))>
```

where canonical JSON is recursively key-sorted with no whitespace. The helper
`profileSigningMessage(address, nonce, profile)` exported from `src/profiles.ts` so
wallets can reproduce it bit-for-bit.

Validation and errors:

- Address must be a `G`... str key -> `400 invalid_address`
- Display name 1..60, bio ≤ 1000, ≤ 20 skills (each ≤ 30, lowercase slug), links https only -> `400 validation_error`
- Bad signature -> `401 invalid_signature`
- Nonce not strictly greater than stored -> `409 stale_nonce`
- Unknown profile -> `404 profile_not_found`

Example with the Stellar SDK:

```ts
import { Keypair } from '@stellar/stellar-sdk';
import { profileSigningMessage } from './src/profiles';

const k = Keypair.random();
const profile = { displayName: 'Ada', skills: ['rust'] };
const nonce = 1;
const msg = profileSigningMessage(kp.publicKey(), nonce, profile);
const signature = kp.sign(Buffer.from(msg)).toString('base64');
```

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

Deployed on Vercel as a serverless function: `api/index.ts` exports the Express app and `vercel.json` rewrites every path to it. `src/index.ts` only calls `listen()` when run directly.

```bash
vercel deploy --prod
```

## License

MIT
