# Milestones Subsystem Operations Runbook

This document is the operator- and on-call-facing runbook for the TalentTrust
**milestones** subsystem. Milestones are not a standalone resource — they are a
first-class field on the Contract API surface. This runbook covers configuration,
common failure modes, alert symptom triage, and recovery procedures.

> **Audience:** Operators, DevOps, SRE, on-call engineers.
>
> **Related docs:**
> - [docs/milestones.md](./milestones.md) — API contract: shapes, endpoints, error codes
> - [docs/contracts-lifecycle.md](./contracts-lifecycle.md) — contract lifecycle and status transitions
> - [docs/runbook-auth.md](./runbook-auth.md) — JWT / RBAC authentication used by all contract routes
> - [docs/observability.md](./observability.md) — metrics and alerting overview
> - [docs/health.md](./health.md) — readiness / liveness probes

---

## Table of Contents

1. [Subsystem Architecture](#1-subsystem-architecture)
2. [Configuration](#2-configuration)
3. [API Endpoints](#3-api-endpoints)
4. [Failure Modes](#4-failure-modes)
5. [Alerting & Monitoring](#5-alerting--monitoring)
6. [Recovery Procedures](#6-recovery-procedures)
7. [Known Limitations](#7-known-limitations)
8. [Related Documentation](#8-related-documentation)

---

## 1. Subsystem Architecture

### 1.1 Components

```
  Client (JWT Bearer)
           │
           ▼
  ┌────────────────────────────────────────────────────────┐
  │  src/routes/contracts.routes.ts                        │
  │  Mounted at /api/v1/contracts (src/app.ts)             │
  │  requireAuth → requirePermission → validate → handler  │
  └────────────────────────┬───────────────────────────────┘
                           │
           ┌───────────────┼────────────────┐
           ▼               ▼                ▼
  Zod DTO schemas   Bounds policy     ContractsService
  (contract.dto.ts) (bounds.ts)       (contracts.service.ts)
           │               │                │
           └───────────────┼────────────────┘
                           ▼
                 ContractRepository
                 (SQLite / in-memory)
                 — contract row only;
                   milestones are NOT persisted
```

| Module | Path | Role |
|--------|------|------|
| Routes | `src/routes/contracts.routes.ts` | Mounts contract + bounds endpoints; wires auth and validation |
| Controller | `src/controllers/contracts.controller.ts` | Maps transport DTOs; translates `ContractBoundsError` → HTTP 422 |
| Service | `src/services/contracts.service.ts` | Business rules: bounds validation, budget overrun check (create), OCC updates |
| Bounds policy | `src/contracts/bounds.ts` | Hard-coded caps: milestone count and stroop amount |
| Create/update DTOs | `src/modules/contracts/dto/contract.dto.ts` | Zod schemas for milestone field shape |
| Boundary mappers | `src/modules/contracts/dto/contracts-boundary.dto.ts` | Request ↔ service DTO mapping (copies milestones) |
| Update middleware | `src/modules/contracts/validation.middleware.ts` | OCC `version` pre-check + schema parse for PATCH |
| Idempotency | `src/middleware/contractIdempotency.ts` | Required `Idempotency-Key` on create |
| Repository | `src/repositories/contractRepository.ts` | Persists contract rows (no milestone column) |
| App mount | `src/app.ts` | `app.use('/api/v1/contracts', contractsModuleRouter)` |

### 1.2 Request flow (create with milestones)

```
POST /api/v1/contracts
  → requireAuth + requirePermission('contracts', 'create')
  → contractCreateIdempotencyMiddleware()   # Idempotency-Key required
  → validateSchema(createContractSchema)    # Zod field shape + defaults
  → ContractsController.createContract
       → toCreateContractDto (copy milestones)
       → ContractsService.createContract
            1. validateContractBounds(budget, milestones)   # count + absolute cap
            2. sum(milestone.amount) ≤ budget               # per-contract overrun
            3. repository.create({ title, clientId, … })    # milestones NOT written
            4. sorobanService.prepareEscrow (best-effort)
       → 201 with ContractResponseDto (no milestones in response)
```

### 1.3 Request flow (update with milestones)

```
PATCH /api/v1/contracts/:id
  → validateContractId
  → requireAuth + requirePermission('contracts', 'update', getContractOwnerId)
  → validateUpdateContract                  # version required; Zod parse
  → ContractsController.updateContract
       → ContractsService.updateContract
            1. if budget or milestones present → validateContractBounds
            2. map title/status/budget/freelancerId into updateFields
               (milestones are validated then discarded — not written)
            3. repository.updateWithVersion (OCC)
```

---

## 2. Configuration

### 2.1 Policy bounds (code constants — not env-tunable)

Defined in `src/contracts/bounds.ts`. There is **no runtime toggle**; changing
limits requires a code review and deploy.

| Constant | Value | Description |
|----------|-------|-------------|
| `MAX_MILESTONES_PER_CONTRACT` | `20` | Maximum milestones accepted per create/update payload |
| `MAX_CONTRACT_AMOUNT_STROOPS` | `100_000_000_000_000` | Absolute cap for budget and total milestone amounts (10,000,000 XLM) |
| `MAX_CONTRACT_TERMS_LENGTH` | `5000` | Free-text terms length (related contract field) |

Public discovery object (`CONTRACT_BOUNDS`):

| Field | Value |
|-------|-------|
| `maxMilestonesPerContract` | `20` |
| `maxContractAmountStroops` | `100000000000000` |

Exposed via `GET /api/v1/contracts/bounds` (`ContractsController.getBounds` returns
`CONTRACT_BOUNDS` directly).

### 2.2 Milestone field constraints (Zod)

From `src/modules/contracts/dto/contract.dto.ts`:

| Field | Create | Update | Constraints |
|-------|--------|--------|-------------|
| `title` | required | required | 1–100 characters |
| `description` | optional (default `''`) | required (1–500) | max 500 characters |
| `amount` | required | required | positive number ≤ `MAX_CONTRACT_AMOUNT_STROOPS` |
| `deadline` | optional | optional | ISO-8601 datetime, max 64 chars |
| `completed` | optional (default `false`) | default `false` | boolean |

**Count ceiling is intentionally not in Zod.** Milestone *count* is enforced only
in `validateContractBounds` so clients receive `422 contract_bounds_error` rather
than an earlier `400 validation_error` (see comments in `contract.dto.ts`).

### 2.3 Environment dependencies (shared with contracts)

Milestones inherit contract-route dependencies; there are no milestone-specific env vars.

| Variable | Required | Purpose for this subsystem |
|----------|----------|----------------------------|
| `JWT_SECRET` | Yes | Signs/verifies JWTs used by `requireAuth` |
| `DB_PATH` | No | SQLite path for contract persistence (`:memory:` in tests) |

Invalid auth/config surfaces as process startup failure or 401s on all contract routes
(see [runbook-auth.md](./runbook-auth.md)).

---

## 3. API Endpoints

All routes require a valid JWT (`requireAuth`) and the listed RBAC permission.
Mounted under `/api/v1/contracts` (`src/routes/contracts.routes.ts`).

| Method | Path | Permission | Milestone relevance |
|--------|------|------------|---------------------|
| `POST` | `/` | `contracts:create` | Accepts optional `milestones[]`; validates bounds + budget sum |
| `PATCH` | `/:id` | `contracts:update` (ownOnly for client/freelancer) | Accepts optional `milestones[]`; re-validates bounds when present |
| `GET` | `/:id` | `contracts:read` (ownOnly) | Returns contract; response DTO has **no** milestones field |
| `GET` | `/bounds` | `contracts:read` | Returns policy caps used by milestone validation |
| `GET` | `/` | `contracts:list` | List contracts (no milestone payload) |
| `GET` | `/stats` | `contracts:list` | Aggregate stats (budget totals, not milestone-specific) |
| `DELETE` | `/:id` | `contracts:delete` (admin) | Deletes contract row |

Create additionally requires `Idempotency-Key` (`src/middleware/contractIdempotency.ts`).

Detailed request/response examples: [docs/milestones.md](./milestones.md).

---

## 4. Failure Modes

### 1. Milestone count exceeds policy cap

- **Symptom:** `422` with `error.code = contract_bounds_error` and message like
  `Milestone count 21 exceeds maximum of 20`.
- **Cause:** Payload includes more than `MAX_MILESTONES_PER_CONTRACT` (20) items.
- **Detection:** Application logs for `ContractBoundsError`; elevated 422 rate on
  `POST/PATCH /api/v1/contracts`.
- **Recovery:** Client must reduce the milestones array to ≤ 20. Caps are not
  env-tunable — a product/code change is required to raise the limit.

### 2. Total milestone amount exceeds absolute stroop cap

- **Symptom:** `422 contract_bounds_error` —
  `Total milestone amount exceeds maximum contract amount of 100000000000000 stroops`.
- **Cause:** Sum of `milestone.amount` values exceeds `MAX_CONTRACT_AMOUNT_STROOPS`
  (or non-finite accumulation). Enforced in `validateContractBounds`.
- **Recovery:** Reduce individual milestone amounts or remove milestones until the
  sum is within the absolute cap.

### 3. Total milestone amount exceeds contract budget (create only)

- **Symptom:** `422 contract_bounds_error` —
  `Total milestone amount exceeds maximum contract amount (milestones total N exceeds budget of M)`.
- **Cause:** On **create**, `ContractsService.createContract` additionally requires
  `sum(milestones.amount) ≤ budget`. This check does **not** run on update.
- **Recovery:** Lower milestone amounts or raise `budget` so the sum fits.

### 4. Zod field validation failure

- **Symptom:** `400 validation_error` with `details[]` paths under
  `body.milestones.<index>.<field>`.
- **Cause:** Invalid title/description length, non-positive amount, bad datetime,
  wrong types, or (on the strict update path) unrecognized fields depending on schema mode.
- **Recovery:** Fix the offending fields per [§2.2](#22-milestone-field-constraints-zod).
  Inspect `error.details[].path` and `message`.

### 5. Missing or conflicting Idempotency-Key (create)

- **Symptom:** `400 bad_request` (missing key) or `409 conflict` (same key, different body).
- **Cause:** Create path requires `Idempotency-Key`; reuse with a different body is rejected.
- **Recovery:** Send a new UUID key for a genuinely new create, or replay the exact
  same body to get the cached response (`Idempotency-Replayed: true`).

### 6. Optimistic concurrency conflict (update)

- **Symptom:** `409 ERR_CONFLICT` / version conflict; or `400 ERR_MISSING_VERSION` /
  `ERR_INVALID_VERSION`.
- **Cause:** PATCH without `version`, stale `version`, or non-integer version.
  Milestone patches share the same OCC gate as other contract fields.
- **Recovery:** `GET /api/v1/contracts/:id`, take current `version`, retry PATCH.

### 7. Authorization / ownership denial

- **Symptom:** `401 unauthorized` or `403` (permission denied).
- **Cause:** Missing/invalid JWT, or role lacking `contracts:create|update|read`.
  Client/freelancer updates are ownOnly via `getContractOwnerId` (DB `clientId`).
- **Recovery:** Verify token role and that the caller owns the contract (or is admin).
  See [runbook-auth.md](./runbook-auth.md).

### 8. Soroban prepareEscrow failure after create

- **Symptom:** Contract is created (`201`) but logs show
  `[ContractsService] Soroban prepareEscrow failed for contract <id>`.
- **Cause:** Off-chain create succeeded; on-chain escrow preparation failed.
  Failure is caught and logged — it does **not** roll back the contract row.
- **Recovery:** Inspect Soroban/RPC health and retry escrow preparation out-of-band.
  Milestone payload was never stored on the contract row regardless.

### 9. Clients expect milestones in GET responses

- **Symptom:** Integrators report missing `milestones` on `GET /api/v1/contracts/:id`
  after a successful create/update that included milestones.
- **Cause:** By design today, `ContractResponseDto` and the repository schema have
  **no milestones field**; validation is API-layer only (griefing / resource caps).
- **Recovery:** Treat this as a known limitation ([§7](#7-known-limitations)). Do not
  escalate as data loss in persistence — persistence never stored them. Coordinate a
  product/engineering change if durable milestone storage is required.

---

## 5. Alerting & Monitoring

There are **no milestone-specific Prometheus metrics**. Operators should watch the
shared contracts / HTTP / auth signals.

### Suggested signals

| Signal | How to observe | Why it matters |
|--------|----------------|----------------|
| Elevated `422` on `/api/v1/contracts` | Access / app logs; gateway status codes | Bounds rejections (count or amount) |
| Elevated `400 validation_error` with `milestones` in path | Structured error logs | Client schema misuse |
| Elevated `409` on create | Idempotency middleware | Key reuse or client retry bugs |
| Elevated `409` on PATCH | OCC conflicts | Concurrent writers / stale clients |
| `Soroban prepareEscrow failed` warn logs | Application stdout / log aggregator | On-chain prep degraded after create |
| Auth `401`/`403` spikes | Auth middleware logs | Token or RBAC misconfiguration |

### Suggested alert thresholds (starting points)

| Condition | Severity | Notes |
|-----------|----------|-------|
| 422 rate on `/api/v1/contracts` > baseline × 3 for 15m | Warning | Often client bugs or a sudden policy mismatch after deploy |
| Sustained Soroban prepareEscrow warnings | Warning | Escrow path unhealthy; contracts still created |
| 5xx rate on contracts routes | Critical | Unexpected failures past bounds handling |

### Manual verification queries

```bash
# Discover current policy caps (requires valid JWT with contracts:read)
curl -sS -H "Authorization: Bearer <token>" \
  http://localhost:3001/api/v1/contracts/bounds | jq .

# Reproduce a count-cap rejection (expect 422)
curl -sS -X POST http://localhost:3001/api/v1/contracts \
  -H "Authorization: Bearer <token>" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{"title":"Bounds probe","description":"Operator check of milestone cap","clientId":"<uuid>","budget":1000,"milestones":[]}'
# (build milestones array length 21 in a script for a real probe)
```

Integration coverage for these behaviours lives in
`src/controllers/milestones.integration.test.ts` and
`src/services/contracts.service.test.ts` / `src/contracts/bounds.test.ts`.

---

## 6. Recovery Procedures

### Procedure 1: Diagnose a 422 contract_bounds_error

1. Read `error.message` from the response body — it distinguishes count vs amount vs budget overrun.
2. Confirm live caps with `GET /api/v1/contracts/bounds`.
3. If count > 20 → ask the client to shrink the array.
4. If absolute stroop cap → reduce amounts.
5. If create-time budget overrun → align `budget` and milestone sums.
6. If the product needs higher caps → open a change against `src/contracts/bounds.ts`
   (not an env change) and redeploy.

### Procedure 2: Diagnose missing milestones after a “successful” write

1. Confirm the request returned `201`/`200` and that validation passed.
2. `GET /api/v1/contracts/:id` and inspect the payload — `milestones` will be absent
   (`toContractResponseDto` does not include them).
3. Check SQLite / repository schema — there is no milestones column on `contracts`.
4. Communicate the known limitation; do not attempt DB restore for milestone rows
   that were never written.
5. If durable storage is required, escalate to engineering (schema + service + DTO change).

### Procedure 3: Unblock stuck create retries (idempotency)

1. If client receives `409 conflict` on create, compare request body to the original keyed request.
2. Same body → expect cached success replay; different body → issue a **new** `Idempotency-Key`.
3. Missing key → add `Idempotency-Key: <uuid>`.

### Procedure 4: Resolve PATCH conflicts when updating milestones

1. `GET /api/v1/contracts/:id` → capture `version`.
2. Retry `PATCH` with that `version` and the intended `milestones` (and other fields).
3. Remember: even on success, milestones are not persisted today — only other mapped
   fields (`title`, `status`, `budget`→`amount`, `freelancerId`) are written.

### Procedure 5: Soroban prepareEscrow warnings after create

1. Locate the warn log for the contract id.
2. Verify Soroban RPC / network configuration and escrow service health.
3. Confirm the off-chain contract row exists via `GET /api/v1/contracts/:id`.
4. Retry escrow preparation using the existing contract id and budget (operational
   playbook for Soroban; milestones were only used for API-layer validation).

### Procedure 6: Auth failures blocking all milestone operations

1. Follow [runbook-auth.md](./runbook-auth.md) for JWT / RBAC recovery.
2. Verify the caller’s role against the contracts permission matrix in
   [docs/milestones.md](./milestones.md#authentication--permissions).
3. For ownOnly updates, confirm `req.user.sub` matches the contract `clientId`
   (or use an admin token).

---

## 7. Known Limitations

Documented accurately against the current source (verify before changing ops assumptions):

1. **No durable milestone storage.** `ContractRepository.create` / `updateWithVersion`
   persist contract metadata only. Milestones are validated then discarded.
2. **No milestones in API responses.** `ContractResponseDto` omits milestones.
3. **Create vs update asymmetry.** Budget overrun (`sum(amounts) ≤ budget`) is enforced
   on create only. Update re-runs `validateContractBounds` (count + absolute cap) when
   `budget` or `milestones` are present, using `budget ?? 0` if budget is omitted.
4. **Hard-coded caps.** Limits live in `src/contracts/bounds.ts` with no env override
   (intentional — avoids misconfiguration risk per source comments).
5. **Related notification enum only.** `KeyEscrowEvent.MILESTONE_APPROVED` exists in
   `src/types/notification.types.ts` for notification plumbing; it is not wired as a
   milestones CRUD path in this backend module.

---

## 8. Related Documentation

- [Milestones API Contract](./milestones.md)
- [Contracts Lifecycle](./contracts-lifecycle.md)
- [Auth Operations Runbook](./runbook-auth.md)
- [API Keys Operations Runbook](./runbook-api-keys.md)
- [Webhooks Operations Runbook](./runbook-webhooks.md)
- [Observability](./observability.md)
- [Health](./health.md)
- [Environment Variables](./backend/environment-variables.md)

### Source cross-reference checklist

| Topic | Source of truth |
|-------|-----------------|
| Caps | `src/contracts/bounds.ts` |
| Create/update business rules | `src/services/contracts.service.ts` |
| HTTP 422 mapping | `src/controllers/contracts.controller.ts` |
| Routes / auth | `src/routes/contracts.routes.ts` |
| Zod shapes | `src/modules/contracts/dto/contract.dto.ts` |
| Persistence | `src/repositories/contractRepository.ts` |
| Integration tests | `src/controllers/milestones.integration.test.ts` |
