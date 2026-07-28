# Reputation Scoring Algorithm

## Overview

The reputation system originally computed a simple arithmetic mean of all ratings, treating years-old reviews and recent ones equally without considering reviewer credibility or recency. This document describes the recency-weighted scoring algorithm that addresses temporal dynamics by applying exponential time-decay weights to ratings based on their age.

The simple arithmetic mean remains available in the `score` field for backward compatibility. The new weighted score is returned in the `weightedScore` field.

---

## Algorithm

The reputation scoring algorithm uses **exponential time decay** to weight ratings by their age. Recent ratings contribute more to the overall score than older ratings.

### Formula

For each rating `i`:

```
weight_i = exp(-λ * age_i_in_days)
```

The weighted score is:

```
weighted_score = Σ(rating_i * weight_i) / Σ(weight_i)
```

**Where:**

- `λ` (lambda) is the decay constant from `REPUTATION_DECAY_LAMBDA` environment variable
- `age_i_in_days` is the number of days between the rating's `createdAt` timestamp and the evaluation time (now)
- `rating_i` is the numeric rating value (1-5 scale)
- `weight_i` is the exponential decay weight for rating `i`

**Interpretation:**

A higher λ value causes older ratings to decay faster. The default λ = 0.005 means a rating loses approximately half its weight every 139 days.

---

## Decay Behavior

The following table shows how a rating's weight decreases over time using the default decay constant (λ = 0.005):

| Age (days) | Weight (λ=0.005) | Interpretation |
|------------|------------------|----------------|
| 0          | 1.000            | Brand new rating, full weight |
| 30         | 0.861            | ~86% weight after 1 month |
| 90         | 0.638            | ~64% weight after 3 months |
| 180        | 0.407            | ~41% weight after 6 months |
| 365        | 0.166            | ~17% weight after 1 year |
| 730        | 0.028            | ~3% weight after 2 years |

As ratings age, they asymptotically approach zero weight but never fully disappear, ensuring that historical reputation data is preserved while recent performance is prioritized.

---

## Configuration

The scoring algorithm is controlled by two environment variables defined in the Zod validation schema (`src/config/env.schema.ts`):

### REPUTATION_DECAY_LAMBDA

**Description:** Exponential decay constant (λ) for time-weighted reputation scores.

- **Type:** Positive float
- **Default:** `0.005`
- **Valid range:** Greater than 0 and less than or equal to 1
- **Effect:** Higher values cause older ratings to decay faster

**Example:**
```bash
REPUTATION_DECAY_LAMBDA=0.005
```

**Tuning guidance:**
- `λ = 0.001`: Slow decay — ratings retain ~90% weight after 100 days
- `λ = 0.005`: Default — ratings retain ~61% weight after 100 days (half-life ~139 days)
- `λ = 0.01`: Fast decay — ratings retain ~37% weight after 100 days (half-life ~69 days)

### REPUTATION_SCORE_ALGORITHM_VERSION

**Description:** Identifier for the scoring algorithm in use. Returned in API responses to enable version-aware clients.

- **Type:** String
- **Default:** `"exp-decay-v1"`

**Example:**
```bash
REPUTATION_SCORE_ALGORITHM_VERSION=exp-decay-v1
```

---

## API Changes

The `ReputationProfile` type has been extended with two new fields:

### New Fields

#### `weightedScore`

- **Type:** `number`
- **Range:** 0.0 - 5.0 (same as `score`)
- **Description:** Recency-weighted reputation score using exponential time decay

#### `scoreAlgorithm`

- **Type:** `string`
- **Description:** Identifier for the scoring algorithm used (e.g., `"exp-decay-v1"`)
- **Purpose:** Enables API clients to detect which algorithm version was used and handle scoring logic accordingly

### Existing Fields (Unchanged)

All existing fields in `ReputationProfile` remain unchanged:

- `freelancerId` — Target user's ID
- `score` — Arithmetic mean of all ratings (original algorithm)
- `jobsCompleted` — Number of completed jobs (legacy field)
- `totalRatings` — Total number of ratings received
- `reviews` — Array of individual review objects
- `lastUpdated` — ISO 8601 timestamp of last update

### Example Response

```json
{
  "status": "success",
  "data": {
    "freelancerId": "user-123",
    "score": 4.2,
    "jobsCompleted": 0,
    "totalRatings": 10,
    "reviews": [
      {
        "reviewerId": "reviewer-456",
        "rating": 5,
        "comment": "Excellent work!",
        "createdAt": "2024-01-10T00:00:00.000Z"
      }
    ],
    "lastUpdated": "2024-01-10T00:00:00.000Z",
    "weightedScore": 4.35,
    "scoreAlgorithm": "exp-decay-v1"
  }
}
```

---

## Score Stability

The weighted score is **deterministic** for identical input at the same point in time:

- For a fixed set of ratings and a fixed evaluation time, the function always returns the same result
- The function is pure — it has no side effects and does not call `Date.now()` internally
- The evaluation time (`now`) is passed as a parameter for testability with fixed clocks

**Important:** The score will naturally change over time as the evaluation timestamp advances, even if no new ratings are added. This is the intended behavior of the time-decay algorithm — older ratings gradually lose weight as time passes.

---

## Edge Cases

The algorithm handles the following edge cases correctly:

### Zero Ratings

**Input:** Empty ratings array  
**Output:** `weightedScore = 0`  
**Rationale:** No data available to compute a score.

### Single Rating

**Input:** One rating, regardless of age  
**Output:** `weightedScore = rating_value`  
**Rationale:** With a single rating, both the numerator (`rating * weight`) and denominator (`weight`) contain only one term. The weight cancels out in the division, so the result equals the rating value regardless of age.

### All-Old Ratings

**Input:** All ratings are several years old  
**Output:** A valid weighted mean within the rating range [1, 5]  
**Rationale:** Old ratings approach zero weight asymptotically, but the weighted mean formula guarantees the result stays within the input rating range as long as all weights are non-negative (which is always true with exponential decay).

### Clock Skew (Future Timestamps)

**Input:** A rating with `createdAt` in the future relative to the evaluation time  
**Output:** The rating is treated as having age = 0 (weight = 1)  
**Rationale:** The algorithm clamps negative ages to 0 to defensively handle clock skew, network time sync issues, or database timestamp anomalies. This prevents negative weights or `NaN` results.

### Mixed Recency

**Input:** Ratings spanning a wide range of ages (e.g., some from today, some from years ago)  
**Output:** A weighted mean biased toward the more recent ratings  
**Rationale:** This is the core behavior of the algorithm. Recent ratings have higher weights, pulling the weighted mean toward their values.

---

## Implementation Details

### Function Signature

```typescript
export function computeWeightedReputationScore(
  ratings: Array<{ rating: number; createdAt: string }>,
  now: Date,
  lambda: number
): number
```

### Location

- **Module:** `src/services/reputation.service.ts`
- **Export:** Named export (module-level function)

### Integration

The `ReputationService.getProfile` method computes both the arithmetic mean (`score`) and the weighted score (`weightedScore`) and returns them together in the `ReputationProfile` response.

```typescript
// Get validated config for reputation scoring parameters
const config = validateEnv(process.env);

// Compute weighted score using recency-aware algorithm
const weightedScore = computeWeightedReputationScore(
  entries,
  new Date(),
  config.REPUTATION_DECAY_LAMBDA
);
```

---

## Testing

The algorithm is covered by 20 comprehensive tests in `src/services/reputation.service.test.ts`:

### Pure Function Tests

- Empty ratings returns 0
- Single rating returns that rating's value (at age = 0 and at old age)
- Two equal ratings with different ages return the common value
- Directional bias tests (newer high/low ratings bias score accordingly)
- Range invariant tests (score always within [min, max] of input ratings)
- Higher lambda decays faster
- Deterministic (identical inputs produce identical outputs)
- Clock skew handling (future timestamps do not throw)

### Integration Tests

- `getProfile` returns `weightedScore` and `scoreAlgorithm` fields
- `getProfile` preserves all existing fields
- `weightedScore = 0` for zero ratings
- Mixed recency scenario: weighted score biased toward recent ratings

### Vacuousness Checks

Tests 5 and 6 (directional bias tests) have been confirmed non-vacuous:
- When the weighted mean formula is replaced with the arithmetic mean, the tests fail (the simple mean returns exactly 3.0, failing the strict inequality)
- When the weighted formula is restored, the tests pass

---

## Security and Stability Notes

- `computeWeightedReputationScore` is a **pure function** with no side effects
- No `Date.now()` calls internally — evaluation time is passed as a parameter
- Result is guaranteed within the input rating range `[min(ratings), max(ratings)]`
- Future `createdAt` values are handled defensively (age clamped to 0)
- λ is validated as a positive float at startup; zero or negative λ values are rejected by the Zod schema

---

## Additional Findings

No existing bugs or missing `createdAt` fields were found during reconnaissance. The repository's `findByTargetId` method already includes `createdAt` in the result set, mapped by the `toReputationEntry` function.

---

## Future Enhancements

- **Reviewer credibility weighting**: Adjust rating weights based on the reviewer's own reputation score
- **Bayesian averaging**: Incorporate prior beliefs to handle users with few ratings
- **Dispute mechanism**: Allow users to contest fraudulent or retaliatory ratings
- **Configurable decay models**: Support alternative decay functions (linear, logarithmic, step-wise)
- **Time-windowed scoring**: Compute scores over rolling time windows (e.g., last 90 days only)

---

## Bulk Recompute Flow

The `REPUTATION_RECOMPUTE` background job recomputes scores for **every subject** that has at least one rating in the database.

### Entry point

`src/queue/processors/reputation-recompute-processor.ts` — `processReputationRecompute(payload, repo)`

The function accepts an injected `ReputationRepository` instance so it can be tested without a live database.

### Paginated subject enumeration

Instead of loading all subject IDs into memory, the processor streams them in pages using an async generator:

```
freelancerIdPages(repo, pageSize)
  └─ calls repo.getDistinctTargetIdPage(limit, offset) repeatedly
       until an empty page is returned
```

`getDistinctTargetIdPage` issues:

```sql
SELECT DISTINCT target_id
FROM reputation_entries
ORDER BY target_id
LIMIT ? OFFSET ?
```

The deterministic `ORDER BY target_id` guarantees stable pages across multiple calls during the same run.

### Per-subject processing

For each subject ID on a page:

1. Call `ReputationService.getProfile(targetId)` — this aggregates all entries from the DB, computes the arithmetic mean (`score`) and the recency-weighted mean (`weightedScore`).
2. If `forceRecompute` is `false` and `profile.lastUpdated` is within the last 24 hours, the subject is skipped (stale-while-revalidate optimisation).
3. The returned profile is persisted to the in-memory `reputationStore` via `reputationStore.set(profile)`.
4. `reputationCheckpointStore.updateProgress(checkpointJobId, targetId)` records the last successfully processed subject.

A failure on any single subject is **caught, logged, and skipped** — it does not abort the batch. This preserves the per-subject error isolation guarantee.

### Checkpointing

| Action | When |
|---|---|
| `createCheckpoint` | Once per job run (or reuses the active checkpoint when `resumeFromCheckpoint: true`) |
| `updateProgress` | After each successfully processed subject |
| `markCompleted` | After the last page is drained (including the empty-store case) |

If a run is interrupted before `markCompleted`, the checkpoint remains in `running` state. A subsequent run with `resumeFromCheckpoint: true` will pick up that checkpoint and continue from where it left off.

### Payload options

| Field | Default | Description |
|---|---|---|
| `batchSize` | `100` | Page size for `getDistinctTargetIdPage` |
| `forceRecompute` | `false` | When `true`, skip the 24-hour recency guard |
| `resumeFromCheckpoint` | `true` | When `true`, resume from an existing active checkpoint |

### Edge cases

- **Empty store** — the generator yields nothing; the job returns `totalProcessed: 0` without error.
- **All subjects fresh** — with `forceRecompute: false`, all subjects are skipped; `totalProcessed: 0`, job succeeds.
- **Single failing subject** — isolated; the rest of the batch continues.
