# Requirements Document

## Introduction

The Talenttrust-Backend exports Prometheus metrics from four source modules:
`src/observability/metrics-service.ts`, `src/utils/webhookMetrics.ts`,
`src/webhookMetrics.ts`, and `src/observability/health-service.ts`. Operators
currently must read TypeScript source to discover which series are exported,
what labels each carries, what units apply, and how to authenticate the scrape
endpoint. This feature produces a human-readable, machine-verifiable
**Observability Metrics Catalog** that tables every exported series, documents
the `/metrics` scrape contract (including auth), cross-references the SLO
thresholds defined in `src/operations/service-objectives.ts`, and is validated
by a comprehensive test suite that achieves ≥ 95 % coverage of all impacted
modules.

---

## Glossary

- **Catalog**: The `docs/observability.md` document that is the primary output
  of this feature. It tables all exported Prometheus series with type, labels,
  unit, and SLO cross-references.
- **MetricsService**: The class defined in
  `src/observability/metrics-service.ts` that registers and exposes all
  application-level Prometheus series.
- **WebhookMetrics (utils)**: The module `src/utils/webhookMetrics.ts` that
  exports `webhookDlqOperationsTotal` and `webhookDlqReplaysTotal` counters.
- **WebhookMetrics (src)**: The module `src/webhookMetrics.ts` that exports
  `createWebhookMetrics()` producing `webhook_delivery_attempts_total`,
  `webhook_delivery_latency_seconds`, `webhook_delivery_retries_total`,
  `webhook_dlq_operations_total`, and `webhook_breaker_state`.
- **HealthService**: The class defined in
  `src/observability/health-service.ts` that evaluates runtime and dependency
  signals and drives the `service_health_status` gauge.
- **MetricsAuthMiddleware**: The Express middleware in
  `src/middleware/metricsAuth.ts` that enforces bearer-token protection on
  `GET /metrics`.
- **SLO**: Service Level Objective — a target for success-rate or latency
  defined in `src/operations/service-objectives.ts`.
- **Series**: A uniquely named Prometheus metric family, e.g.
  `http_requests_total{method,route,status_code}`.
- **Label**: A key-value dimension attached to a series sample.
- **Scrape**: A Prometheus pull-model collection cycle against `GET /metrics`.
- **prom-client**: The Node.js Prometheus client library used by this backend.
- **DLQ**: Dead-Letter Queue — the persistent store for undeliverable webhook
  events.
- **Provider_ID**: A redacted identifier (first 4 chars + `****`) used as a
  label value on rate-limit gauges to bound cardinality.
- **CATALOG_METRIC_NAMES**: An exported TypeScript constant that enumerates the
  canonical set of metric family names documented in the Catalog, used by the
  round-trip test suite (Requirement 9).

---

## Requirements

### Requirement 1: Series Catalog Table

**User Story:** As an operator, I want a complete table of every exported
Prometheus series with its type, labels, unit, and a plain-English description,
so that I can build dashboards and alerts without reading TypeScript source.

#### Acceptance Criteria

1. THE Catalog SHALL include one row per exported metric family for all series
   registered by MetricsService, `src/utils/webhookMetrics.ts`,
   `src/webhookMetrics.ts`, and the prom-client default-metrics prefix
   `talenttrust_backend_` (derived from the production `SERVICE_NAME` value).
   For histogram families the row SHALL include sub-rows for `_bucket`,
   `_count`, and `_sum` child series.
2. WHEN a series has one or more label dimensions, THE Catalog SHALL list every
   label name for that series and describe the finite set of values or the
   value-space constraint (e.g., HTTP method, route template, HTTP status code).
3. THE Catalog SHALL identify the Prometheus metric type (counter, gauge, or
   histogram) for each series.
4. THE Catalog SHALL specify the measurement unit (e.g., `seconds`, `bytes`,
   `total — dimensionless count`) for each series.
5. THE Catalog SHALL include the `help` string from the prom-client registration
   as the authoritative description for each series. Paraphrasing is permitted
   only when the original help string is a verbatim copy — the meaning, subject,
   and label semantics of the original MUST be fully preserved.
6. WHEN a series is owned by a specific source module, THE Catalog SHALL
   attribute the series to its source file so operators can trace back to the
   registration site.
7. THE Catalog SHALL document the numeric gauge encoding for
   `service_health_status` (`up = 2`, `degraded = 1`, `down = 0`) and for
   `webhook_breaker_state` (`CLOSED = 0`, `OPEN = 1`, `HALF_OPEN = 2`) in the
   per-row description column.

### Requirement 2: Histogram Bucket Documentation

**User Story:** As an operator configuring alerting rules, I want to know the
exact bucket boundaries for every histogram, so that I can write accurate
quantile expressions and understand the resolution of percentile estimates.

#### Acceptance Criteria

1. THE Catalog SHALL list all bucket upper bounds (`le` values) for each
   histogram series in ascending order:
   - `http_request_duration_seconds`: `0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1,
     2.5, 5, +Inf`
   - `webhook_delivery_latency_seconds`: `0.1, 0.5, 1, 2, 5, 10, +Inf`
2. WHEN the bucket boundaries include the implicit `+Inf` sentinel, THE Catalog
   SHALL document it as the last entry in the bucket list.
3. THE Catalog SHALL note, for each histogram, that quantile estimates are
   interpolated linearly across the declared buckets and that resolution
   degrades beyond the largest finite bucket boundary.

### Requirement 3: `/metrics` Scrape Contract

**User Story:** As a platform engineer setting up Prometheus, I want the
scrape endpoint contract documented in one place — URL, content type, auth
method, and example scrape configuration — so that I can configure the scraper
without trial and error.

#### Acceptance Criteria

1. THE Catalog SHALL document the scrape endpoint as `GET /metrics` on the port
   defined by the `PORT` environment variable (default `3001`).
2. THE Catalog SHALL document the response content type as
   `text/plain; version=0.0.4; charset=utf-8` (Prometheus text exposition
   format).
3. IF `METRICS_AUTH_TOKEN` is set to a non-empty string, THEN THE Catalog SHALL
   document that every scrape request MUST include an
   `Authorization: Bearer <token>` header whose value matches the configured
   token exactly.
4. IF `METRICS_AUTH_TOKEN` is absent or empty, THEN THE Catalog SHALL document
   that the endpoint is unauthenticated. The Catalog SHALL state: "Unauthenticated
   access is only appropriate in isolated development or test environments. Set
   `METRICS_AUTH_TOKEN` in all staging and production deployments."
5. IF the `Authorization` header is missing, does not start with `Bearer `, or
   the supplied token does not match the configured token, THEN THE Catalog
   SHALL document that MetricsAuthMiddleware returns HTTP `401 Unauthorized`
   with JSON body `{"error":"Unauthorized"}`.
6. THE Catalog SHALL document the following facts about the constant-time
   comparison: (a) both the configured token and the supplied token are
   converted to `Buffer` instances; (b) `timingSafeEqual` is called only when
   both buffers have equal byte length — mismatched lengths result in an
   immediate `false` without calling `timingSafeEqual`; (c) this prevents
   timing-based token-length enumeration attacks.
7. THE Catalog SHALL include a `scrape_configs` YAML block containing at minimum
   the fields `job_name`, `static_configs` with `targets`, and
   `authorization` with `type: Bearer` and `credentials`.
8. IF `METRICS_ENABLED` is set to the string `"false"`, THEN THE Catalog SHALL
   document that `GET /metrics` returns HTTP `404 Not Found`.

### Requirement 4: Cardinality and Label Safety

**User Story:** As an SRE, I want to understand the cardinality controls built
into the metrics system so that I can anticipate memory usage and prevent label
explosion in long-running deployments.

#### Acceptance Criteria

1. THE Catalog SHALL document the `HTTP_METRICS_ROUTE_LABEL_LIMIT` environment
   variable (default `100`, accepted range 1–10,000) as a hard cap on the
   number of distinct route template values that MetricsService will admit into
   the `route` label of `http_requests_total` and
   `http_request_duration_seconds`.
2. WHEN the count of tracked route labels equals the limit AND a new, previously
   unseen route template arrives, THE Catalog SHALL document that the new route
   is recorded under the label value `"other"` and the tracked-route count does
   not increase past the cap.
3. THE Catalog SHALL document that requests that match no Express route handler
   (i.e., `req.route` is undefined) are recorded under the label value
   `"unmatched"`, regardless of the current tracked route count.
4. THE Catalog SHALL document that `provider_id` label values on
   `webhook_rate_limit_tokens` and `webhook_rate_limit_queue_depth` are
   formatted as `<first-4-chars>****` (exactly 4 characters from the raw ID
   followed by the literal string `****`), making each label value a fixed-
   length, fixed-format string that bounds per-provider cardinality to the
   number of distinct provider-ID prefixes.
5. THE Catalog SHALL document that all label values on every exported series
   originate exclusively from one of these four permitted sources: (a) an
   HTTP method string (e.g., `GET`, `POST`); (b) a matched Express route
   template (e.g., `/api/v1/contracts/:id`); (c) an HTTP status code string
   (e.g., `"200"`); (d) a member of a finite enumeration defined in source
   (e.g., `outcome`, `operation`, `provider`, `reason`). No request payload
   data, query parameters, path segments containing user input, or unbounded
   runtime strings are used as label values.

### Requirement 5: SLO Cross-Reference

**User Story:** As an operator writing alert rules, I want to see the SLO
thresholds from `service-objectives.ts` alongside the relevant series, so that
I can write threshold expressions without hunting through TypeScript.

#### Acceptance Criteria

1. THE Catalog SHALL include a dedicated SLO cross-reference section that lists
   every named objective defined in `DefaultServiceObjectives` — `healthCheck`
   and `contractsApi` — with their numeric literal values sourced from
   `service-objectives.ts`:
   - `healthCheck`: `targetSuccessRatePercent: 99.99`, `targetLatencyP95Ms: 50`,
     `targetLatencyP99Ms: 100`
   - `contractsApi`: `targetSuccessRatePercent: 99.9`, `targetLatencyP95Ms: 200`,
     `targetLatencyP99Ms: 500`
2. THE Catalog SHALL cross-reference each SLO objective with the Prometheus
   series it is evaluated against. The series names SHALL appear within the same
   section entry as the objective values: `http_requests_total` for success rate
   and `http_request_duration_seconds` for latency.
3. THE Catalog SHALL list every named threshold defined in
   `DefaultAlertThresholds` — `healthCheck` and `contractsApi` — with their
   numeric literal values sourced from `service-objectives.ts`:
   - `healthCheck`: `maxErrorRatePercent: 0.1`, `maxAverageLatencyMs: 150`,
     `evaluationWindowSeconds: 300`
   - `contractsApi`: `maxErrorRatePercent: 1.0`, `maxAverageLatencyMs: 400`,
     `evaluationWindowSeconds: 300`
4. THE Catalog SHALL include at least one Prometheus alert rule YAML block per
   SLO objective. Each block MUST contain the fields `alert`, `expr`, `for`,
   `labels`, and `annotations` so that it is paste-ready into an Alertmanager
   `rules` file without modification.
5. WHEN an SLO objective and its corresponding alert threshold share the same
   operation key (e.g., `healthCheck`), THE Catalog SHALL co-locate the
   objective values, alert threshold values, and the alert rule YAML block
   within the same subsection or table row so that operators can read all three
   together without navigating away.

### Requirement 6: Health-Status Gauge Values

**User Story:** As an operator, I want the mapping between the numeric gauge
values and service health states documented, so that I can write threshold-based
alert expressions correctly.

#### Acceptance Criteria

1. THE Catalog SHALL document the `service_health_status` gauge encoding:
   `2 = up`, `1 = degraded`, `0 = down`.
2. THE Catalog SHALL document the two runtime signals that drive health status
   transitions: (a) event-loop lag in milliseconds; (b) heap-used ratio
   (heapUsed / heapTotal).
3. THE Catalog SHALL document the default threshold inequalities from
   `defaultThresholds` as alert-ready expressions:
   - `eventLoopLagMs >= 250` → `degraded`
   - `eventLoopLagMs >= 1000` → `down`
   - `heapUsedRatio >= 0.85` → `degraded`
   - `heapUsedRatio >= 0.95` → `down`
   The boundary value itself triggers the transition (≥, not >).
4. THE Catalog SHALL document that HealthService evaluates both signals and all
   registered dependency checkers, then applies a worst-status merge where
   `down > degraded > up`. A dependency-checker exception is treated as `down`.
5. THE Catalog SHALL include a Prometheus alert rule with `expr:
   service_health_status < 2`, `for: 1m`, and a `labels` selector that targets
   the service by the `service` label, so operators can copy it directly into
   an Alertmanager rules file.

### Requirement 7: WebhookMetrics DLQ Series

**User Story:** As an operator monitoring webhook reliability, I want the DLQ
counters and their label values fully documented, so that I can build SLO alerts
on delivery outcomes without guessing label names.

#### Acceptance Criteria

1. THE Catalog SHALL document `webhook_dlq_operations_total` (counter, unit:
   `total — dimensionless count`) with its `operation` label and enumerate all
   valid values: `enqueue` (event accepted into the DLQ), `drop_overflow`
   (event rejected because the DLQ is at capacity), `drop_poison` (event
   permanently discarded after exceeding the maximum retry limit).
2. THE Catalog SHALL document `webhook_dlq_replays_total` (counter, unit:
   `total — dimensionless count`) with its `outcome` label and enumerate all
   valid values: `success` (replayed event delivered successfully), `failed`
   (replay attempt returned a non-2xx response), `idempotent_noop` (event
   skipped because it was already delivered), `error` (replay attempt threw an
   unexpected exception).
3. THE Catalog SHALL document `webhook_deliveries_total` (counter, unit:
   `total — dimensionless count`, registered by MetricsService) with its
   `outcome` label and enumerate all valid values: `success`, `failure`, `dlq`.
4. THE Catalog SHALL document `webhook_dlq_depth` (gauge, unit: `entries`,
   registered by MetricsService) as a label-free gauge whose value is a
   non-negative integer representing the absolute current count of entries
   in the DLQ (not a delta).
5. THE Catalog SHALL include a per-series ownership table with one non-blank
   cell per series showing: `webhook_dlq_operations_total` → incremented by
   `src/utils/webhookMetrics.ts`; `webhook_dlq_replays_total` → incremented by
   `src/utils/webhookMetrics.ts`; `webhook_deliveries_total` → incremented by
   `src/observability/metrics-service.ts`; `webhook_dlq_depth` → set by
   `src/observability/metrics-service.ts`.
6. THE Catalog SHALL document the semantic meaning of each label value for the
   two counters in `src/utils/webhookMetrics.ts` so that operators know the
   operational significance of each outcome when writing SLO alert expressions.

### Requirement 8: Test Suite Coverage

**User Story:** As a developer maintaining the metrics stack, I want a
comprehensive automated test suite for all impacted modules so that regressions
are caught before they reach production.

#### Acceptance Criteria

1. THE Test_Suite SHALL achieve ≥ 95 % line and branch coverage across
   `src/observability/metrics-service.ts`, `src/observability/health-service.ts`,
   `src/middleware/metricsAuth.ts`, and `src/utils/webhookMetrics.ts`.
2. WHEN MetricsService is constructed, THE Test_Suite SHALL verify that the
   text output of `getMetrics()` contains all of the following metric family
   names: `http_requests_total`, `http_request_duration_seconds`,
   `service_health_status`, `webhook_deliveries_total`, `webhook_dlq_depth`,
   `webhook_rate_limit_tokens`, `webhook_rate_limit_queue_depth`.
3. THE Test_Suite SHALL verify the route label bounding logic in three distinct
   scenarios: (a) routes below the limit are each tracked individually with
   their template as the label value; (b) when the limit is reached, the next
   new unseen route produces the label value `"other"`; (c) requests with no
   matching Express route produce the label value `"unmatched"`.
4. THE Test_Suite SHALL verify all four bearer-token scenarios for
   MetricsAuthMiddleware in separate test cases: (a) `METRICS_AUTH_TOKEN` not
   set — middleware calls `next()` without checking the header; (b)
   `METRICS_AUTH_TOKEN` set and a matching `Authorization: Bearer <token>`
   header supplied — middleware calls `next()`; (c) `METRICS_AUTH_TOKEN` set
   and the `Authorization` header is absent — middleware returns HTTP `401`;
   (d) `METRICS_AUTH_TOKEN` set and the `Authorization: Bearer` header contains
   a non-matching token — middleware returns HTTP `401`.
5. THE Test_Suite SHALL verify that `timingSafeEqual` is called only when both
   buffer lengths are equal, and is NOT called when the configured and supplied
   token lengths differ (verified by spy/mock on `crypto.timingSafeEqual`).
6. THE Test_Suite SHALL verify the `service_health_status` gauge transitions
   through `up (2) → degraded (1) → down (0)` by injecting the following
   provider values and asserting the recorded gauge value: event-loop lag of
   `249 ms` → `2`; event-loop lag of `250 ms` → `1`; event-loop lag of
   `1000 ms` → `0`; heap ratio of `0.84` → `2`; heap ratio of `0.85` → `1`;
   heap ratio of `0.95` → `0`.
7. THE Test_Suite SHALL verify that `evaluateObjectives` returns a report with
   `breached: true` when observed success rate is below
   `objective.targetSuccessRatePercent` OR observed p95 latency exceeds
   `objective.targetLatencyP95Ms` OR observed p99 latency exceeds
   `objective.targetLatencyP99Ms`.
8. THE Test_Suite SHALL verify that `evaluateObjectives` returns a report with
   `breached: false` when all observed values are within their respective SLO
   targets.
9. THE Test_Suite SHALL verify that `readObservedMetrics` returns `null` when
   the registry contains no `http_requests_total` or
   `http_request_duration_seconds` data (both extractors return `null`).
10. THE Test_Suite SHALL verify that calling `incrementDlqOperation('enqueue')`,
    `incrementDlqOperation('drop_overflow')`, and
    `incrementDlqOperation('drop_poison')` each increment
    `webhook_dlq_operations_total` with the matching `operation` label; and that
    calling `incrementDlqReplay('success')`, `incrementDlqReplay('failed')`,
    `incrementDlqReplay('idempotent_noop')`, and `incrementDlqReplay('error')`
    each increment `webhook_dlq_replays_total` with the matching `outcome` label.

### Requirement 9: Documentation Accuracy Round-Trip

**User Story:** As a documentation maintainer, I want a mechanism to verify
that the Catalog stays in sync with the source registrations, so that the
documentation does not silently drift from the code.

#### Acceptance Criteria

1. THE project SHALL export a TypeScript constant `CATALOG_METRIC_NAMES` (an
   array of strings) that enumerates the canonical set of metric family names
   documented in the Catalog. THE Test_Suite SHALL assert that the set of metric
   names appearing in `getMetrics()` output from a freshly constructed
   MetricsService (with a fresh prom-client Registry, default-metrics disabled)
   equals the set declared in `CATALOG_METRIC_NAMES`. A difference in either
   direction SHALL cause the test to fail, ensuring that adding or removing a
   series without updating both the constant and the Catalog is caught
   automatically.
2. THE Test_Suite SHALL verify that every label name declared in the Catalog for
   each series is observable as a key in the `labels` map of the corresponding
   metric entry returned by `register.getMetricsAsJSON()` after at least one
   observation is recorded for that series.
