# Application configuration compatibility

`loadConfig(env = process.env)` in `src/appConfiguration.ts` supplies the existing
`AppConfig` contract to the allowed-assets configuration endpoint and consumers
of the gateway, circuit-breaker, health-probe, chaos, and webhook policy types.
It is distinct from the Zod-based environment loader in `src/config/`.

The function signature, exported interfaces, nested fields, defaults, inclusive
clamp ranges, list order, and duplicate list entries are preserved. Each call
returns fresh policy objects and arrays without modifying the supplied environment
or `process.env`. A failed load publishes no partial configuration. Retrying or
loading different environments requires no shared temporary environment mutation.

## Input and security rules

| Input | Behavior |
| --- | --- |
| Missing, empty, whitespace-only, non-numeric, or non-finite numeric values | Use the existing field default. |
| Finite out-of-range numbers | Clamp to the existing inclusive range. |
| Fractional port, attempt count, circuit-breaker count, or queue count | Use the existing field default; ports/counts must be integers. |
| Fractional probability, multiplier, jitter, or timing values | Retain existing numeric parsing and clamp behavior. |
| Explicit zero idempotency TTL or queue thresholds | Preserve zero; blank input does not disable TTL. |
| Feature flags | Trim and accept case-insensitive `true`/`false` and documented `1`/`0`. Blank/missing values keep the default. Other values throw a static error naming the variable, rather than silently disabling safeguards. |
| Allowed asset lists | Preserve uppercasing, trimming, ordering, and duplicates. Missing/blank values retain the default assets; an explicit comma-only list remains empty. |
| Upstream URL | Require a valid HTTP(S) URL and the existing private-host checks. Rejected input is never included in the error, including URL credentials, query tokens, or malformed bypass settings. |
| Private-host bypass | Read `NODE_ENV` and `SSRF_ALLOW_PRIVATE_HOSTS` from the same supplied environment. Only explicit `development`, `test`, or `staging` may opt in. Production, unknown, or missing modes cannot inherit a global bypass. |

Existing no-argument `loadConfig()`, one-argument `isSafeUrl(url)`, and environment
helper calls continue to use `process.env`. The SSRF and environment helpers now
accept an optional explicit environment for callers that need an isolated policy.
No caller must migrate, and no dependency or global test exclusion is changed.

Invalid configuration that formerly depended on global settings, disabled a
feature through a typo, or passed an unusable fractional count now follows the
rules above. Fix rejected boolean values using the named variable; fractional
ports/counts fall back safely. Intentional private-host development URLs must
include the opt-in and mode in the environment passed to `loadConfig`.

## Verification

`src/appConfiguration.test.ts` verifies the complete legacy shape, overrides,
boundaries, malformed input, sanitized failures, global-policy isolation, repeated
loads, and independent policy objects. Existing helper, SSRF, controller, route,
and previously excluded legacy loader tests are also exercised.

```sh
npm test -- --runInBand --runTestsByPath src/appConfiguration.test.ts src/config/appConfig.ssrf.test.ts src/utils/ssrf.test.ts src/config/env.test.ts src/controllers/config.controller.test.ts src/routes/config.routes.test.ts
npm test -- --runInBand --testPathIgnorePatterns=node_modules --runTestsByPath src/config/config.test.ts --testNamePattern=loadConfig
```
