# Runtime Configuration Toggles

## Overview

This change introduces validated runtime feature flags for controlled rollout of backend capabilities that may carry operational or security risk.

- `FEATURE_CONTRACTS_API_ENABLED`
  - Default: `true`
  - Purpose: preserves the current contracts API behavior while allowing operations teams to dark-disable the route during incidents or phased rollouts.
- `FEATURE_RUNTIME_CONFIG_ENDPOINT_ENABLED`
  - Default: `false`
  - Purpose: keeps diagnostics dark by default and exposes only a public-safe snapshot of feature state when explicitly enabled.

## Design Notes

- Configuration is parsed once during process startup.
- Unsupported boolean values fail the process at boot instead of falling back silently.
- Route guards return `404` for disabled features to reduce discoverability of dark-launched endpoints.
- The runtime config diagnostics route intentionally excludes raw environment variables and network configuration details.

## Security Assumptions And Threat Scenarios

- Misconfigured flags are treated as deployment failures, not recoverable warnings.
- Public diagnostics are limited to boolean feature state, which avoids leaking secrets or deployment topology.
- `/health` remains available even when risky routes are disabled so load balancers and orchestrators continue to function.
- Returning `404` for disabled routes reduces unnecessary information disclosure compared with richer admin-style error responses.

## Test Coverage

The implementation adds both unit and integration coverage:

- Unit tests validate accepted boolean values, invalid values, default behavior, and port validation.
- Integration tests verify that:
  - `/health` remains available regardless of feature state
  - `/api/v1/contracts` serves normally when enabled
  - `/api/v1/contracts` returns `404` when disabled
  - `/api/v1/runtime-config` is dark by default
  - `/api/v1/runtime-config` returns only the public-safe feature snapshot when enabled

Coverage thresholds are enforced at 95% globally for lines, statements, functions, and branches, excluding the process entrypoint in `src/index.ts`.
