# Configuration

This document describes environment-variable configuration for the TalentTrust
backend. It currently focuses on the queue retry policy overrides.

## Retry policy overrides

Per-job-type retry/backoff behaviour can be overridden via environment
variables of the form:

```
RETRY_POLICY_{JOB_TYPE}_{PROPERTY}=value
```

`{JOB_TYPE}` is the upper-cased job-type name with hyphens replaced by
underscores, for example `EMAIL_NOTIFICATION`, `CONTRACT_PROCESSING`,
`REPUTATION_UPDATE`, `REPUTATION_RECOMPUTE`, `BLOCKCHAIN_SYNC`.

### Supported properties and bounds

All overrides are validated and clamped to safe bounds so that no environment
value can produce an unbounded backoff explosion. Out-of-range values are
clamped (not rejected) and a warning is emitted via the structured logger.

| Property     | Type    | Accepted range                                  | Notes |
| ------------ | ------- | ----------------------------------------------- | ----- |
| `ATTEMPTS`   | integer | `(0, MAX_RETRY_ATTEMPTS]` (max `10`)            | Coordinates with overall retry bounds. |
| `DELAY`      | integer | `[MIN_BACKOFF_DELAY, MAX_BACKOFF_DELAY]` (`1`–`300000` ms) | Base backoff delay in milliseconds. |
| `MULTIPLIER` | float   | `[MIN_BACKOFF_MULTIPLIER, MAX_BACKOFF_MULTIPLIER]` (`1`–`10`) | Only meaningful for `exponential` backoff. |
| `JITTER`     | float   | `[0, 1]`                                         | Values outside the range are ignored. |

### Validation rules

- Non-numeric, `NaN`, or non-positive values are ignored (the built-in default
  is kept).
- Values outside the accepted range are clamped to the nearest bound and a
  warning is logged.
- A `multiplier` is only meaningful for `exponential` backoff. If a resolved
  override declares a `fixed` backoff that still carries a `multiplier`, the
  multiplier is dropped so the resulting policy is internally consistent.
- Overrides are merged over the built-in `DEFAULT_RETRY_POLICIES`; the override
  precedence is preserved.

### Example

```dotenv
# Use a multiplier of 3 (valid, passes through)
RETRY_POLICY_EMAIL_NOTIFICATION_MULTIPLIER=3

# Requesting 100 is clamped to 10 (MAX_BACKOFF_MULTIPLIER) with a warning
RETRY_POLICY_BLOCKCHAIN_SYNC_MULTIPLIER=100

# Base delay in milliseconds (clamped to 300000 max)
RETRY_POLICY_CONTRACT_PROCESSING_DELAY=2000
```


## Histogram bucket boundaries

The `http_request_duration_seconds` Prometheus histogram uses configurable
bucket boundaries to record HTTP request latency. By default the boundaries
are chosen to cover the SLO thresholds defined in
`src/operations/service-objectives.ts`.

### Environment variable

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `METRICS_HISTOGRAM_BUCKETS` | `0.005,0.01,0.05,0.1,0.25,0.5,1,2.5,5` | Comma-separated list of bucket upper bounds **in seconds**. |

### Validation rules

The supplied value must satisfy all of the following conditions or the
service will fall back to the built-in defaults and log a warning:

- Non-empty list.
- Every element is a finite, positive number.
- Elements are in **strictly increasing** order.

### Example

```dotenv
# Fine-grained low-latency service
METRICS_HISTOGRAM_BUCKETS=0.001,0.005,0.01,0.025,0.05,0.1,0.25,0.5,1

# High-latency batch API
METRICS_HISTOGRAM_BUCKETS=0.1,0.5,1,2,5,10,30
```

### SLO coverage

The default buckets cover all SLO thresholds out of the box:

| SLO objective | Threshold | Default bucket |
| ------------- | --------- | -------------- |
| healthCheck p95 | 50 ms (0.05 s) | `0.05` exact boundary |
| healthCheck p99 | 100 ms (0.1 s) | `0.1` exact boundary |
| contractsApi p95 | 200 ms (0.2 s) | interpolated between `0.1` and `0.25` |
| contractsApi p99 | 500 ms (0.5 s) | `0.5` exact boundary |

When supplying custom buckets, ensure that your SLO thresholds are either
exact bucket boundaries or can be linearly interpolated within your bucket
ranges. Buckets that are too coarse will reduce percentile precision.

### Runtime fallback

If `METRICS_HISTOGRAM_BUCKETS` is absent, empty, or fails validation, the
service silently uses the built-in defaults. A `console.warn` message is
emitted at startup listing the validation failure reason so operators can
diagnose misconfiguration without causing a service outage.
