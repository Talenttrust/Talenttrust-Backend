# feat(auth): per-account login lockout (#631)

## Problem

The IP-based rate limiter (`src/middleware/rateLimiter.ts`) keeps a single
account safe from a botnet on one address, but cannot stop a distributed
credential-stuffing run hammering **one** account from **many** IPs.
`AuthService.login` previously tracked no per-identity failure state, so an
attacker could try thousands of passwords against one victim with no
per-account slow-down.

## Solution

Introduces a per-account progressive lockout tracker
(`src/auth/accountLockout.ts`) and wires it into `POST /auth/login`:

- Track **consecutive failures** keyed by a SHA-256 hash of the normalized
  email (case- and whitespace-agnostic; `normalizeEmail` from
  `src/repositories/userRepository.ts`)
- Lock the account for 15 min after 5 consecutive failures within a 15 min
  decay window
- Pad response time **exponentially** (250 ms → 4 s) up to a 5 s cap, so
  failure latency scales with attacker cost
- Emit `AUTH_LOCKOUT_TRIGGERED` / `AUTH_LOCKOUT_RELEASED` audit events
  with IP + correlation context for incident review
- Periodic sweep `GC` reaps expired records so a credential-spray attacker
  cannot OOM the process

### Security properties

- **Constant-time scrypt path** — `authService.login` always runs (no
  bypass for locked accounts) to prevent account enumeration via timing
- **Uniform padding across the lockout boundary** — `assess(email)` is
  snapshotted pre-scrypt; its `preDelayMs` is applied to both success and
  failure paths. A legit user who fat-fingers their password *N* times
  and then enters it correctly pays `computeDelay(N)` on success (a
  deliberate security/UX tradeoff documented inline)
- **Post-scrypt re-assess** — `live = assess(email)` after scrypt closes
  the race where the lockout deadline lapses during the scrypt wait, so a
  user with the correct password arriving 1 ms before lockout-expiry is
  admitted (not unjustly 401'd)
- **Burst-resistant** — failures during an already-locked window are
  no-ops, the lockout deadline is fixed at trigger time (not extended),
  trigger audit fires **exactly once** per streak (`=== maxFailures`
  guard), `recordSuccess` is idempotent under concurrent deletion
- **No raw PII in storage** — tracking keys are SHA-256 of the normalized
  identity; raw emails never appear in heap snapshots
- **Audit sink failure isolation** — an unauditable trigger/release
  writes to stderr but does not break the auth flow

## Files

### New
- `src/auth/accountLockout.ts` — `AccountLockoutTracker` class +
  `loadAccountLockoutConfig` env loader + exported singleton
  `accountLockout`
- `src/auth/accountLockout.test.ts` — unit tests covering the state
  machine, decay sliding window, sweep GC, audit-sink resilience, email
  normalization, disabled mode, and the curve/edge cases

### Modified
- `src/audit/schemas.ts`, `src/audit/service.ts`, `src/audit/types.ts` —
  register new audit actions `AUTH_LOCKOUT_TRIGGERED` and
  `AUTH_LOCKOUT_RELEASED`
- `src/routes/auth.routes.ts` — wire `accountLockout` into `/login`:
  pre-scrypt snapshot, post-scrypt re-assess, uniform padding across
  success/failure/locked-reject paths
- `src/routes/auth.routes.test.ts` — updated to mock the lockout module

## Configuration (env-driven)

| Var | Default | Purpose |
|-----|---------|---------|
| `AUTH_LOCKOUT_ENABLED` | `true` | Master switch — disable to no-op the tracker |
| `AUTH_LOCKOUT_MAX_FAILURES` | `5` | Consecutive-failure threshold |
| `AUTH_LOCKOUT_DECAY_WINDOW_MS` | `900000` | Sliding decay window (15 min) |
| `AUTH_LOCKOUT_LOCKOUT_DURATION_MS` | `900000` | Lockout duration (15 min) |
| `AUTH_LOCKOUT_BASE_DELAY_MS` | `250` | First-failure response delay |
| `AUTH_LOCKOUT_DELAY_MULTIPLIER` | `2` | Multiplier per consecutive failure (capped at 16) |
| `AUTH_LOCKOUT_MAX_DELAY_MS` | `5000` | Hard cap on response padding |

Invalid values fall back to defaults with a stderr warning rather than
crashing the process.

## Testing

- Unit tests in `src/auth/accountLockout.test.ts` covering:
  - default config & `computeDelay` curve (0 → 0; 1 → 250; 2 → 500; …
    capped at `maxDelayMs`)
  - `assess` read-only semantics including post-decay and post-lockout
    views
  - `recordFailure` strict-equality trigger guarantee (one audit per
    streak, even under interleaved requests)
  - `recordSuccess` release audit (fires for any previously-locked
    streak, including when the lockout has already elapsed)
  - decay sliding-window semantics
  - email identity normalization (case + whitespace collide)
  - sweep GC removes records when `lockedUntil` expires or the decay
    window lapses
  - audit sink resilience (throws are caught, not propagated)
- Validate with `npx jest --runInBand src/auth/accountLockout.test.ts
  src/routes/auth.routes.test.ts`

## Deferred (follow-up PRs)

- Route-level tests asserting the new `/login` contract end-to-end
  (high-failure success padding, scrypt-succeeds-while-locked,
  post-scrypt re-assess fast-path)
- Fix the sweep-timer `setInterval` handle leak in the test fixture
  (cosmetic under `--detectOpenHandles`)

Closes #631
