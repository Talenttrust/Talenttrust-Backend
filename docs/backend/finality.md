# Blockchain Finality Depth

## Problem

Consumers could observe a contract event (e.g. a `MILESTONE_RELEASED`
release) as soon as it appeared on-chain, **before** it had accumulated
enough confirmations to be considered settled. If the chain reorged in
that window, the same consumer would later observe contradictory state
(a release that never happened, or a different event at the same
position).

## Solution

1. **Per-network finality depth** — each network has a configured
   confirmation depth (`FINALITY_DEPTHS`, e.g. `stellar=1,soroban=3`).
   Unknown networks fall back to a conservative `defaultDepth`
   (`FINALITY_DEFAULT_DEPTH`, default 6) — fail-closed, never exposed
   early.
2. **Provisional marking (internal)** — events ingested with a
   `network` + `ledger` are evaluated against the current chain head.
   Below the depth they are stored with `finalityStatus: 'provisional'`
   and are **hidden from public reads**. They remain in the store for
   auditability and observability.
3. **Promotion (one-way)** — a promotion sweep re-evaluates provisional
   events against the latest head and flips them to `finalized` once
   they reach the depth. Promotion is one-way (`provisional ->
   finalized`); a finalized event is never demoted, so a deep reorg
   cannot flip previously published state.

## Where it lives

| Piece | Location |
|---|---|
| Pure policy + evaluation | `src/finality/policy.ts` |
| Async evaluator (provider, fail-closed) | `src/finality/finalityEvaluator.ts` |
| Chain-head provider (Soroban RPC) | `src/finality/providers.ts` |
| Config (`FINALITY_*`) | `src/config/env.schema.ts` |
| Finality marking + public-read filter | `src/repository/eventAuditRepository.ts` |
| Admin observability endpoint | `GET /api/v1/admin/events/provisional` (`src/routes/admin.routes.ts`) |
| Promotion trigger on sync | `src/queue/processors/blockchain-processor.ts` |

## Semantics

`confirmations = headLedger - ledger + 1`. An event is finalized when
`confirmations >= depth`:

- `depth = 1`: finalized as soon as the event ledger is the head.
- `depth = 3`: needs the head to be `ledger + 2`.
- `depth = 0` (zero-confirmation, development): finalized as observed,
  no head required.

### Edge cases

| Case | Behaviour |
|---|---|
| Zero confirmations in development | `network=0` + `FINALITY_ALLOW_ZERO_CONFIRMATION` (default outside production) → finalized immediately, no RPC call. |
| Exact finality boundary | `confirmations == depth` → finalized. One short → provisional. |
| Reorg before finality | Head regresses → event stays provisional until confirmations are re-earned. A conflicting replay at the same `contractId:eventId:sequence` is rejected by the existing idempotency/payload-integrity check. |
| Provider lag | `headLedger < ledger` → provisional (`provider_lag`). |
| Unknown network policy | No `FINALITY_DEPTHS` entry → conservative `defaultDepth` + structured warn record. |
| Off-chain event (no `ledger`) | Finalized immediately — no finality risk. |
| Provider unavailable | Fail-closed: event marked provisional (`provider_unavailable`), promotion sweep skipped; next sync retries. |

## Operational notes

- **Retries are explicit and safe.** The blockchain-sync job triggers
  the promotion sweep after every successful sync. The sweep is
  idempotent (one-way flips only), so queue retries and job replays are
  harmless. A failed sweep propagates the error so the queue retries the
  job.
- **Side effects are bounded.** One head fetch per promotion sweep per
  network (not one per event). Zero-confirmation and off-chain events
  never touch the RPC provider.
- **Visibility without leakage.** Provisional events are observable by
  operators only through the admin-only endpoint
  (`GET /api/v1/admin/events/provisional`, requires the `admin` role).
  Payloads and internal deduplication keys are deliberately excluded
  from that endpoint — unconfirmed payloads never leave the admin
  surface.

## Security notes

- **Fail closed.** Any uncertainty (unknown network, missing head,
  provider error, on-chain event without a `network`) results in
  `provisional` — never an early expose.
- **Input validation.** An event carrying a present-but-invalid `ledger`
  or `network` is rejected at validation time
  (`src/contracts/validation.ts`) rather than silently downgraded to
  off-chain, which would otherwise expose it as finalized.
- **One-way promotion.** Finalized events are never demoted, so
  consumers never observe state that later contradicts itself.
- **Structured logging only.** All finality records go through
  `src/logger.ts` (JSON, sanitised). Provider errors are logged as
  `message` strings — no stack traces, no internal paths, no PII in
  message strings (contract IDs appear only as structured fields).

## API compatibility

- Existing event ingestion and history endpoints are unchanged; the
  history read simply returns only finalized events.
- New optional `network`/`ledger` fields may be attached to ingested
  events. Absent fields mean off-chain (finalized immediately).
- New admin-only endpoint is additive.

## Out of scope

Optimistic finality for payouts (spending funds before confirmation) is
explicitly out of scope. This change gates *visibility* of on-chain
state, not the ability to submit transactions.
