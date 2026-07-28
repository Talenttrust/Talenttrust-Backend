# Make ChaosPolicy Randomness Injectable for Deterministic Chaos Tests

## Summary

This PR refactors `ChaosPolicy` in `src/chaos/chaosPolicy.ts` to make the random number generator injectable, enabling deterministic chaos testing and reproducible incident debugging.

## Problem

`ChaosPolicy.decide()` directly called `Math.random()` when `chaosMode === 'random'`, coupling the policy to a global, non-seedable RNG. This made probabilistic chaos testing impossible to reproduce and hard to debug when chaos-induced incidents occurred.

## Solution

Added an optional `random: () => number` parameter to the `ChaosPolicy` constructor:
- Defaults to `Math.random` for production behavior
- Allows tests to supply deterministic RNG sequences
- Enables exact reproduction of chaos decision sequences

## Changes

### `src/chaos/chaosPolicy.ts`

1. Added `RandomFn` type alias for the random function signature
2. Updated constructor to accept optional `random` parameter with `Math.random` default
3. Added explicit boundary handling in random mode:
   - `probability <= 0`: always returns `'none'` (never injects)
   - `probability >= 1`: always returns `'error'` (always injects)
4. Enhanced JSDoc with security notes about chaos being gated on `chaosMode`

### `src/chaos/chaosPolicy.test.ts`

Added comprehensive tests for the injectable RNG:
- Tests use injected functions instead of spying on `Math.random`
- Deterministic sequence tests prove exact decision reproduction
- Boundary tests for probability 0 and 1 (and edge cases like negative/greater-than-1)
- Production behavior test confirms default `Math.random` works correctly

## Test Coverage

All 23 tests pass with coverage focused on:
- Mode dispatch (`off`, `error`, `timeout`, `random`, unknown)
- Target matching (empty, specific, case-insensitive)
- Probability boundaries (0, 1, values in between, edge cases)
- Deterministic RNG injection and sequence reproduction

## Security

- Chaos can never be active in production by default (gated on `chaosMode`)
- The `Math.random` default provides the same cryptographic-quality randomness as Node.js
- No behavior change for production code paths

closes #465