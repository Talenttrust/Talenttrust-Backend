# feat: evaluate service objective SLOs against live Prometheus metrics

## Summary

`DefaultServiceObjectives` in `src/operations/service-objectives.ts` defined SLO targets (success rate, p95/p99 latency) per operation, but these were static declarations only — nothing in the running system compared observed metrics against them. SLOs existed on paper, so breaches went undetected.

This PR adds an **SLO evaluator** that reads live histograms/counters from the prom-client `Registry` used by `MetricsService` and reports per-objective compliance (meeting / breaching), giving alerting and dashboards a source of truth.

Closes #466

## Problem

- Each `ServiceObjective` had targets (`targetSuccessRatePercent`, `targetLatencyP95Ms`, `targetLatencyP99Ms`) but no runtime code consumed them.
- `isThresholdBreached()` existed but required manually supplied `currentErrorRate` / `currentAverageLatencyMs` — no automatic connection to the Prometheus registry.
- Without automated evaluation, SLO breaches could go undetected until a user-facing incident occurred.

## Solution

### 1. `src/operations/service-objectives.ts`

New types and functions:

- **`ObservedMetrics`** — observed `successRatePercent`, `latencyP95Ms`, `latencyP99Ms` (all nullable for empty/missing series).
- **`BreachSummary`** — per-dimension breach booleans (`successRate`, `latencyP95`, `latencyP99`).
- **`ObjectiveComplianceReport`** — structured report with `objectiveKey`, `objective`, `observed`, `breaches`, and aggregate `breached`.
- **`evaluateObjectives(register, objectives?)`** — async function that:
  - Reads `http_requests_total` counter for success rate (2xx / total × 100).
  - Reads `http_request_duration_seconds` histogram for p95/p99 latency via linear bucket interpolation.
  - Aggregates across all label combinations (method, route, status_code).
  - Maps each objective to its compliance status.
  - Never throws on missing/empty metric series — returns `null` observed values.
- **`readObservedMetrics(register)`** — lightweight read-only function the health/observability layer can call for a raw metrics snapshot without objective comparisons.
- Internal helpers: `extractSuccessRate`, `extractPercentile`, `buildReport`.
- `+Inf` bucket protection via `Number.isFinite()` guard.

### 2. `src/operations/service-objectives.test.ts`

25 tests covering:

- **Normal cases:** compliant when all metrics well within targets; breached when success rate drops below target; breached when p95/p99 latency exceeds target.
- **Edge cases:** exactly-at-threshold values (not breached per `>` / `<` semantics); zero samples (latency null, not breached); missing metric series entirely; only latency data with no request counter; single observation (too few for meaningful percentiles); multi-label aggregation across routes/methods.
- **`readObservedMetrics`:** returns `null` when no metrics recorded; returns partial data when some series exist; returns full data when all series have observations.
- **Report structure:** validates all required fields are present.
- **Custom objectives:** supports arbitrary objective registries.

### 3. `README.md`

New **SLO Runtime Evaluation** section documenting:
- How `evaluateObjectives()` and `readObservedMetrics()` work.
- Compliance report shape (table with all fields).
- Edge-case handling (missing series, zero observations, exactly-at-threshold).
- Usage example showing how the health/observability layer can consume reports.

## Design Decisions

| Decision | Rationale |
|---|---|
| **Accepts `Registry` directly** | The evaluator reads from the same prom-client `Registry` that `MetricsService` writes to — no new metrics store, no duplicate instrumentation. |
| **Aggregate across all labels** | All objectives currently target `OperationType.API_REQUEST`. Per-route or per-method filtering can be added later via a `routePattern` field on `ServiceObjective` without changing the evaluator's API. |
| **`null` for missing data, never throws** | The evaluator gracefully degrades when a metric series hasn't been created yet or has zero observations, preventing startup noise and false-positive breaches. |
| **Linear bucket interpolation** | Standard Prometheus histogram percentile calculation using cumulative bucket deltas. Returns `null` when fewer than 2 observations exist (percentiles are meaningless). |

## Security / Correctness Notes

- **No new public HTTP routes** — the evaluator is exposed as a read-only function (`readObservedMetrics`) for the health/observability layer to call internally.
- **Permission model unaffected** — the evaluator reads from an in-process `Registry`; no network access, no authentication, no new attack surface.
- **No new environment variables or secrets.**
- **Metric name constants** (`http_requests_total`, `http_request_duration_seconds`) are defined once and shared with `MetricsService` by convention; misalignment would result in `null` observations (graceful) rather than incorrect data.

## Testing

```
# Run SLO evaluator tests (25 tests, all pass)
npx jest src/operations/service-objectives.test.ts --no-coverage --verbose

# Lint passes with zero errors/warnings
npx eslint src/operations/service-objectives.ts src/operations/service-objectives.test.ts
```

## Migration / Compatibility

- **No call-site changes required.** `evaluateObjectives()` defaults to `DefaultServiceObjectives` when called without a second argument. Existing consumers of `ServiceObjective`, `AlertThreshold`, `isThresholdBreached()`, `DefaultServiceObjectives`, and `DefaultAlertThresholds` are source-compatible.
- **No environment variables or configuration changes needed.**

## Out of Scope

- Wiring `evaluateObjectives()` into the health endpoint or observability layer is left for a follow-up PR (per the issue scope: "do not wire a new public route in this issue").
- Per-route SLO filtering (via `routePattern` on `ServiceObjective`) is deferred.
- Prometheus alerting rule generation from breach reports is not included.

## Reference Docs

- SLO definitions: `src/operations/service-objectives.ts`
- SLO usage docs: `docs/backend/SLA_SLO.md`
- SLO evaluation docs: `README.md` (new **SLO Runtime Evaluation** section)

Closes #466
