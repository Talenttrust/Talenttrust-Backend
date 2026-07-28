# Session Timeout Warning

## Summary
- Adds a reusable session-timeout controller that warns at T-60s with a "Stay logged in" CTA.
- Auto-logs out at T=0 and redirects to `/signin`.
- Provides a small DOM modal adapter for browser shells that need to render the warning dialog.

## Threat Model
This mitigates stale authenticated browser sessions remaining visibly usable after the token deadline. Without the warning and forced client-side logout, an attacker with access to an unattended or stolen browser session could keep interacting with cached authenticated UI state until server-side calls begin failing, increasing the chance of confusing state, delayed user awareness, and accidental exposure of sensitive in-memory data. The server still rejects expired tokens; this change adds client-side defence in depth.

## Validation
- Added negative coverage for already-expired sessions returning a typed `invalid-expiry` result before redirecting.
- Added timer coverage for the T-60s warning, the T=0 `/signin` redirect, and the "Stay logged in" refresh path.

## Performance
The controller schedules two browser timers per active session and performs constant-time arithmetic when they fire. This is not on a backend hot path and does not require a microbenchmark.

Closes #<issue-number>
