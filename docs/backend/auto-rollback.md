# Automatic Post-Switch Rollback

After a blue → green switch the new deployment is observed for a *soak window*.
If the HTTP error rate breaches a configured threshold during that window, the
deployer rolls back to the previous color automatically instead of waiting for
an operator to notice the regression via `deploy:status`.

This complements the existing [blue-green deployment](./bluegreen.md) flow.

## How it works

1. `npm run deploy:switch-green` promotes green and then starts the soak loop.
2. The loop samples the `http_requests_total` Prometheus counter at a fixed
   interval. The error rate is computed as the **delta** between the baseline
   snapshot (taken at the switch) and the current snapshot, so only traffic
   served *after* the switch is judged — not the process's lifetime average.
3. On each sample:
   - Samples with fewer than `ROLLBACK_MIN_REQUESTS` observed requests are
     ignored as statistical noise.
   - If `5xx / total` exceeds `ROLLBACK_ERROR_RATE_THRESHOLD`, `rollback()` is
     invoked immediately and the loop exits.
4. If the window completes without a breach, the deployment is retained.

Every decision is emitted as a structured `deploy_decision` log line
(`decision: soak_start | observe | rollback | rolled_back | retain | skip`)
so the reasoning is auditable.

## Running it standalone

The soak monitor can also be run against the current deployment on its own:

```bash
npm run deploy:auto-rollback
```

It prints a JSON result and exits non-zero if a rollback was triggered, which
makes it convenient to gate a CI/CD pipeline step.

## Configuration

All values are read from the environment, validated, and bounded. A value that
is *present but invalid* (non-numeric, or out of range) fails fast with a
descriptive, secret-free error.

| Variable | Default | Bounds | Description |
|---|---|---|---|
| `AUTO_ROLLBACK_ENABLED` | `true` | `true`/`false` | Master switch. When `false` the soak is skipped and the deployment is retained. |
| `ROLLBACK_ERROR_RATE_THRESHOLD` | `0.05` | `0..1` | 5xx fraction that triggers a rollback when exceeded. |
| `ROLLBACK_SOAK_WINDOW_MS` | `30000` | `1000..600000` | Total time to observe the new deployment. |
| `ROLLBACK_SAMPLE_INTERVAL_MS` | `5000` | `100..60000` | Spacing between samples (capped to the window). |
| `ROLLBACK_MIN_REQUESTS` | `20` | `>= 0` | Minimum requests observed before a breach is actionable. |

## Safety and security notes

- **Idempotent rollback.** The monitor delegates to `rollback()`, which is a
  no-op once the deployment is already on blue. A repeated or concurrent
  invocation cannot double-revert, and the final state is always reflected by
  `deploy:status`.
- **Never rolls back a deployment it didn't promote.** If green is not the
  active color the monitor exits early (`reason: "not-green"`).
- **No secrets logged.** Decision logs carry only error-rate metrics and
  configuration values — never tokens, ports' credentials, or PII. The shared
  logger additionally redacts known sensitive keys.
- **Bounded loops.** The soak window and sample interval are clamped so a
  misconfigured environment cannot pin the process in an unbounded loop or
  poll the registry every millisecond.
- **Noise resistance.** `ROLLBACK_MIN_REQUESTS` prevents a couple of unlucky
  early errors from reverting a healthy deployment.

## Threat scenarios considered

- A regression in green causes a spike in 5xx responses → auto-rolled back.
- Very low traffic during the window → no rollback on insufficient data.
- Misconfigured thresholds/windows → rejected or clamped at load time.
- Duplicate/concurrent rollback attempts → idempotent, single transition.
