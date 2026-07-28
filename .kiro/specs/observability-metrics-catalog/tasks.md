# Implementation Tasks

## Task 1: Export CATALOG_METRIC_NAMES constant

**Description:** Add the canonical metric names constant to `src/observability/metrics-service.ts` to enable round-trip verification tests.

**Acceptance Criteria:**
- Export `CATALOG_METRIC_NAMES` constant as `readonly string[]`
- Include all 7 MetricsService-registered metrics
- Use TypeScript `as const` for immutability

**Files Changed:**
- `src/observability/metrics-service.ts`

**Dependencies:** None

---

## Task 2: Refactor webhookMetrics.ts to use isolated Registry

**Description:** Update `src/utils/webhookMetrics.ts` to register counters with an isolated Registry instead of the prom-client default registry, preventing test interference.

**Acceptance Criteria:**
- Create and export `webhookDlqRegistry` instance
- Pass `registers: [webhookDlqRegistry]` to both Counter constructors
- Export the registry for test access
- No breaking changes to public API (helper functions unchanged)

**Files Changed:**
- `src/utils/webhookMetrics.ts`

**Dependencies:** None

---

## Task 3: Create webhookMetrics.test.ts with DLQ counter tests

**Description:** Write comprehensive tests for `incrementDlqOperation` and `incrementDlqReplay` helper functions to achieve ≥95% coverage.

**Acceptance Criteria:**
- Test all 3 `incrementDlqOperation` label values (enqueue, drop_overflow, drop_poison)
- Test all 4 `incrementDlqReplay` label values (success, failed, idempotent_noop, error)
- Use `webhookDlqRegistry.clear()` between tests for isolation
- Verify counter values via `getMetricsAsJSON()`

**Files Created:**
- `src/utils/webhookMetrics.test.ts`

**Dependencies:** Task 2

---

## Task 4: Extend metricsAuth.test.ts with timingSafeEqual spy test

**Description:** Add test verifying that `crypto.timingSafeEqual` is only called when token buffer lengths match, confirming timing-attack mitigation.

**Acceptance Criteria:**
- Spy on `crypto.timingSafeEqual`
- Verify NOT called when configured and supplied token lengths differ
- Verify IS called when lengths match
- Restore spy after test

**Files Changed:**
- `src/middleware/metricsAuth.test.ts`

**Dependencies:** None

---

## Task 5: Extend metrics-service.test.ts with route boundary and health status tests

**Description:** Add tests for route label cardinality cap logic and health status gauge encoding to increase coverage to ≥95%.

**Acceptance Criteria:**
- Test routes below limit are tracked individually
- Test route at exact limit boundary produces "other" label
- Test unmatched requests produce "unmatched" label regardless of limit
- Test `recordHealthStatus('up')` sets gauge to 2
- Test `recordHealthStatus('degraded')` sets gauge to 1
- Test `recordHealthStatus('down')` sets gauge to 0

**Files Changed:**
- `src/observability/metrics-service.test.ts`

**Dependencies:** None

---

## Task 6: Create metrics-catalog.test.ts with round-trip and SLO tests

**Description:** Create comprehensive test file for round-trip verification (Requirement 9) and SLO evaluation functions (Requirement 8 criteria 7-9).

**Acceptance Criteria:**
- Test all metrics in `CATALOG_METRIC_NAMES` appear in `getMetrics()` output
- Test no undocumented metrics are registered (excluding default metrics)
- Test all documented label names are observable in `getMetricsAsJSON()`
- Test `evaluateObjectives` returns `breached: true` when success rate below target
- Test `evaluateObjectives` returns `breached: true` when p95 or p99 exceeds target
- Test `evaluateObjectives` returns `breached: false` when all metrics within SLO
- Test `readObservedMetrics` returns `null` when registry has no http metrics

**Files Created:**
- `src/observability/metrics-catalog.test.ts`

**Dependencies:** Task 1

---

## Task 7: Add per-file coverage thresholds to jest.config.js

**Description:** Update `jest.config.js` to enforce ≥95% coverage thresholds for the 4 target modules.

**Acceptance Criteria:**
- Add `coverageThreshold` entries for:
  - `./src/observability/metrics-service.ts`
  - `./src/observability/health-service.ts`
  - `./src/middleware/metricsAuth.ts`
  - `./src/utils/webhookMetrics.ts`
- Set lines, branches, functions, statements to 95 for each
- Keep global threshold at 0 (no breaking change)

**Files Changed:**
- `jest.config.js`

**Dependencies:** Tasks 3, 4, 5, 6 (tests must exist to meet threshold)

---

## Task 8: Write docs/observability.md catalog document

**Description:** Create the comprehensive Observability Metrics Catalog documenting all 9 requirements.

**Acceptance Criteria:**
- Include all sections from design.md outline
- Document scrape endpoint contract (URL, auth, content-type, YAML config)
- Document all cardinality controls (route limit, provider redaction, label sources)
- Create complete metrics table with: name, type, labels, unit, description, source, buckets
- Include metrics from MetricsService, utils/webhookMetrics.ts, src/webhookMetrics.ts, and prom-client defaults
- Document histogram bucket boundaries for both histograms
- Include ownership table for 4 DLQ-related series
- Document label value semantics for operation and outcome labels
- Create SLO sections for healthCheck and contractsApi with:
  - SLO target values (success rate, p95, p99)
  - Metrics series used
  - Alert threshold values
  - Copy-pasteable Prometheus alert rule YAML
- Document health status gauge encoding (up=2, degraded=1, down=0)
- Document health threshold inequalities
- Include health status alert rule YAML

**Files Created:**
- `docs/observability.md`

**Dependencies:** None (documentation task, can run in parallel)

---

## Task 9: Run test suite and verify ≥95% coverage

**Description:** Execute `npm run test:ci` to verify all tests pass and coverage thresholds are met.

**Acceptance Criteria:**
- `npm run test:ci` exits with code 0
- Coverage report shows ≥95% for all 4 target modules
- All existing tests continue to pass
- No test failures or errors

**Files Changed:** None (verification task)

**Dependencies:** Tasks 1, 2, 3, 4, 5, 6, 7

---

## Task 10: Run lint and verify no errors

**Description:** Execute `npm run lint` to ensure code style compliance.

**Acceptance Criteria:**
- `npm run lint` exits with code 0
- No ESLint errors or warnings
- All TypeScript files pass linting rules

**Files Changed:** None (verification task)

**Dependencies:** Tasks 1, 2, 3, 4, 5, 6, 8

---

## Task 11: Run build and verify TypeScript compilation

**Description:** Execute `npm run build` to ensure TypeScript compiles without errors.

**Acceptance Criteria:**
- `npm run build` exits with code 0
- No TypeScript compilation errors
- `dist/` directory contains compiled JavaScript

**Files Changed:** None (verification task)

**Dependencies:** Tasks 1, 2, 3, 4, 5, 6, 8

---

## Task 12: Create git branch and commit changes

**Description:** Create a feature branch and commit all changes with a descriptive commit message.

**Acceptance Criteria:**
- Branch name: `docs/observability-metrics-catalog`
- Commit message: `docs(observability): add exported metrics catalog and scrape contract`
- All changed files staged and committed
- Commit includes both code and documentation changes

**Files Changed:** None (git operation)

**Dependencies:** Tasks 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11

---

## Task Dependency Graph

```
Task 1: CATALOG_METRIC_NAMES
   │
   └──► Task 6: metrics-catalog.test.ts

Task 2: webhookMetrics isolated Registry
   │
   └──► Task 3: webhookMetrics.test.ts

Task 4: metricsAuth.test.ts extension  ─┐
Task 5: metrics-service.test.ts extension ├──► Task 7: jest.config.js thresholds
Task 6: metrics-catalog.test.ts ────────┘         │
                                                   │
Task 8: docs/observability.md ───────────────────┤
                                                   │
                                                   └──► Task 9: test:ci
                                                        Task 10: lint
                                                        Task 11: build
                                                           │
                                                           └──► Task 12: git commit
```

---

## Execution Strategy

### Phase 1: Core Implementation (Tasks 1-3)
- Export constant
- Refactor webhookMetrics
- Create webhookMetrics tests

### Phase 2: Test Extensions (Tasks 4-6)
- Extend metricsAuth tests
- Extend metrics-service tests
- Create catalog tests

### Phase 3: Configuration and Documentation (Tasks 7-8)
- Update jest config
- Write catalog document

### Phase 4: Verification and Commit (Tasks 9-12)
- Run tests
- Run lint
- Run build
- Commit to git branch

---

## Success Criteria

All 12 tasks completed successfully when:
- ✅ `npm run test:ci` passes
- ✅ `npm run lint` passes
- ✅ `npm run build` passes
- ✅ Coverage ≥95% for 4 target modules
- ✅ `docs/observability.md` exists and is comprehensive
- ✅ Changes committed to git branch
- ✅ CI pipeline would pass (all 4 gates: lint, test, build, security)
