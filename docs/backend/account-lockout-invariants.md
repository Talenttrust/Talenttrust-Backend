# Account lockout invariants

`AccountLockoutTracker` keeps failure streaks keyed by normalized account identity
in process-local memory. Different IP addresses do not create separate streaks
for the same account. The tracker is neither durable nor shared across workers;
distributed deployments need a shared state implementation to enforce one global
policy. Sweeping removes stale records but does not impose a hard capacity limit.

## Fixed deadlines and retries

Once the failure threshold is reached, the lock deadline takes precedence over
failure decay. Assessment, rejected failures and sweeping cannot shorten or
extend that deadline, even when the decay window is shorter than the lock duration.
Repeated failures during a lock leave the count and deadline unchanged and do not
emit another trigger event. At the exact deadline the lock is expired and the next
failure starts a fresh streak. An unlocked streak decays only when the elapsed
time is strictly greater than the decay window, including clocks starting at zero.

Failure transitions are synchronous within one process. Login handlers must
reassess after asynchronous credential verification before calling
`recordSuccess`. That method and `reset` are trusted administrative operations:
they clear state, including active locks, and must not be exposed directly to
unauthenticated callers. Existing route integration performs the live reassessment.

## Policy replacement migration

Policies are copied, validated and frozen before publication. Replace the whole
policy rather than assigning individual fields:

```ts
tracker.config = { ...tracker.config, maxFailures: 3 };
```

Direct field mutation is now rejected by the readonly type and frozen object.
Mutating the object originally passed to the constructor has no effect. Invalid
constructor values or replacements throw `RangeError` naming only the setting;
an invalid replacement leaves the previous policy and records intact. Changing
the duration does not rewrite existing lock deadlines. Lowering the threshold
locks an existing unlocked streak on its next failure.

| Setting | Allowed values |
| --- | --- |
| `enabled` | Boolean |
| `maxFailures` | Integer from 1 through `Number.MAX_SAFE_INTEGER` |
| `decayWindowMs`, `lockoutDurationMs` | Integer from 1 through 2,147,483,647 |
| `baseDelayMs`, `maxDelayMs` | Integer from 0 through 2,147,483,647 |
| `delayMultiplier` | Integer from 1 through 16 |

Environment settings accept complete decimal integers with surrounding whitespace.
Fractions, hexadecimal/exponent notation, unsafe integers and out-of-range values
fall back to the documented defaults. Zero response delays remain supported;
zero decay/lock durations do not. Boolean settings accept `true`/`1`/`yes` and
`false`/`0`/`no`, ignoring case and surrounding whitespace. Invalid settings emit
a warning containing the fixed setting name and fallback, never the supplied value.

## Audit failures

Trigger and release audit writes are best effort. A throwing audit sink cannot
undo a lock transition or expose its arbitrary error payload in tracker diagnostics.
The returned transition is captured before invoking the sink. Sweeping expired
records does not emit release events; this tracker does not guarantee durable or
complete audit delivery. Existing method signatures and response shapes are retained.
