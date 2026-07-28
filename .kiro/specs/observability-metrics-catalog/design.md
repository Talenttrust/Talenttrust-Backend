# Technical Design Document

## Overview

This feature publishes a comprehensive **Observability Metrics Catalog** (`docs/observability.md`) that documents every Prometheus metric exported by Talenttrust-Backend, including:
- Complete metric series table with types, labels, units, and descriptions
- Histogram bucket boundaries
- `/metrics` scrape endpoint contract with authentication details
- Cardinality controls and label safety documentation
- SLO cross-references with ready-to-use Prometheus alert rules
- Health status gauge encodings and thresholds
- WebhookMetrics DLQ series with ownership attribution

The catalog is validated by a comprehensive test suite achieving ≥95% coverage across all impacted modules, with automated round-trip verification ensuring documentation stays synchronized with code.

---

## Architecture

### High-Level Component View

```
┌─────────────────────────────────────────────────────────────┐
│                  Talenttrust-Backend                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  src/observability/                                         │
│  ├── metrics-service.ts ────► CATALOG_METRIC_NAMES export  │
│  ├── metrics-service.test.ts ► Extended coverage           │
│  └── metrics-catalog.test.ts ► NEW: Round-trip tests       │
│                                                             │
│  src/utils/                                                 │
│  ├── webhookMetrics.ts ──────► Isolated Registry           │
│  └── webhookMetrics.test.ts ─► NEW: DLQ counter tests      │
│                                                             │
│  src/middleware/                                            │
│  └── metricsAuth.test.ts ────► Extended: timingSafeEqual   │
│                                                             │
│  docs/                                                      │
│  └── observability.md ───────► NEW: Full Catalog           │
│                                                             │
│  jest.config.js ─────────────► Per-file coverage thresholds│
└─────────────────────────────────────────────────────────────┘
```

### File Change Summary

| File | Change Type | Purpose |
|------|-------------|---------|
| `src/observability/metrics-service.ts` | **Extend** | Export `CATALOG_METRIC_NAMES` constant |
| `src/observability/metrics-service.test.ts` | **Extend** | Add route boundary tests, health status tests |
| `src/observability/metrics-catalog.test.ts` | **Create** | Round-trip verification, SLO evaluation tests |
| `src/utils/webhookMetrics.ts` | **Refactor** | Use isolated Registry instead of default |
| `src/utils/webhookMetrics.test.ts` | **Create** | Test `incrementDlqOperation` + `incrementDlqReplay` |
| `src/middleware/metricsAuth.test.ts` | **Extend** | Add `timingSafeEqual` spy verification |
| `docs/observability.md` | **Replace** | Full catalog replacing `docs/backend/observability.md` |
| `jest.config.js` | **Extend** | Add per-file coverage thresholds for 4 modules |

---

## Component Designs

### 1. CATALOG_METRIC_NAMES Constant

**Location:** `src/observability/metrics-service.ts`

**Purpose:** Canonical source-of-truth for documented metrics, enabling automated round-trip verification.

**Design:**

```typescript
/**
 * Canonical list of metric family names documented in docs/observability.md.
 * This constant enables round-trip verification: tests assert that the set of
 * metrics registered by MetricsService matches this list exactly.
 */
export const CATALOG_METRIC_NAMES: readonly string[] = [
  'http_requests_total',
  'http_request_duration_seconds',
  'service_health_status',
  'webhook_deliveries_total',
  'webhook_dlq_depth',
  'webhook_rate_limit_tokens',
  'webhook_rate_limit_queue_depth',
] as const;
```

**Rationale:**
- Exported constant is easier to test than parsing markdown
- TypeScript `as const` + `readonly` prevents accidental mutation
- Adding/removing a metric without updating this list causes test failure

---

### 2. src/utils/webhookMetrics.ts Registry Isolation

**Current Problem:** Uses prom-client default registry, causing duplicate metric registration errors in tests.

**Solution:** Create an isolated Registry and pass it to Counter constructors.

**Design:**

```typescript
import { Counter, Registry } from 'prom-client';

// Create isolated registry for webhook DLQ metrics
const webhookDlqRegistry = new Registry();

export const webhookDlqOperationsTotal = new Counter({
  name: 'webhook_dlq_operations_total',
  help: 'Total number of webhook DLQ core operations.',
  labelNames: ['operation'],
  registers: [webhookDlqRegistry],  // ← Explicit registry
});

export const webhookDlqReplaysTotal = new Counter({
  name: 'webhook_dlq_replays_total',
  help: 'Total tracking counts of webhook DLQ manual or batch replay jobs executed.',
  labelNames: ['outcome'],
  registers: [webhookDlqRegistry],  // ← Explicit registry
});

// Export registry for testing
export { webhookDlqRegistry };
```

**Impact:**
- Test files can import and clear `webhookDlqRegistry` between tests
- No interference with MetricsService registry or other test suites
- Existing production code unaffected (metrics still registered, just with explicit registry)

---

### 3. Test Architecture

#### 3.1 src/observability/metrics-catalog.test.ts (NEW)

**Purpose:** Round-trip verification + extended SLO evaluation coverage

**Test Groups:**

1. **Round-trip verification (Requirement 9)**
   ```typescript
   describe('Documentation round-trip', () => {
     it('all metrics in CATALOG_METRIC_NAMES are registered', async () => {
       const service = new MetricsService('test', new Registry());
       const metricsText = await service.getMetrics();
       
       for (const name of CATALOG_METRIC_NAMES) {
         expect(metricsText).toContain(name);
       }
     });
     
     it('no undocumented metrics are registered', async () => {
       const service = new MetricsService('test', new Registry());
       const json = await register.getMetricsAsJSON();
       const registered = json.map(m => m.name);
       
       const undocumented = registered.filter(
         name => !CATALOG_METRIC_NAMES.includes(name) && 
                 !name.startsWith('talenttrust_backend_')  // allow default metrics
       );
       
       expect(undocumented).toEqual([]);
     });
   });
   ```

2. **SLO evaluation tests (Requirement 8 criteria 7-9)**
   ```typescript
   describe('evaluateObjectives', () => {
     it('returns breached=true when success rate below target', async () => {
       // Record 95% success rate (below 99.9% target)
       // Assert report.breached === true
     });
     
     it('returns breached=false when all metrics within SLO', async () => {
       // Record 99.95% success, p95=40ms, p99=80ms
       // Assert report.breached === false
     });
   });
   
   describe('readObservedMetrics', () => {
     it('returns null when no metrics recorded', async () => {
       const result = await readObservedMetrics(new Registry());
       expect(result).toBeNull();
     });
   });
   ```

3. **Label name verification (Requirement 9 criterion 2)**
   ```typescript
   it('all documented label names are observable', async () => {
     const service = new MetricsService('test', register);
     recordHttpRequest(service, { method: 'GET', routePath: '/test', statusCode: 200 });
     
     const json = await register.getMetricsAsJSON();
     const httpCounter = json.find(m => m.name === 'http_requests_total');
     const labels = httpCounter.values[0].labels;
     
     expect(labels).toHaveProperty('method');
     expect(labels).toHaveProperty('route');
     expect(labels).toHaveProperty('status_code');
   });
   ```

#### 3.2 src/utils/webhookMetrics.test.ts (NEW)

**Purpose:** Test DLQ helper functions (Requirement 8 criterion 10)

**Test Structure:**

```typescript
import { 
  incrementDlqOperation, 
  incrementDlqReplay,
  webhookDlqRegistry 
} from './webhookMetrics';

describe('webhookMetrics DLQ counters', () => {
  beforeEach(() => {
    webhookDlqRegistry.clear();  // Isolate tests
  });
  
  describe('incrementDlqOperation', () => {
    it('increments enqueue counter', async () => {
      incrementDlqOperation('enqueue');
      const metrics = await webhookDlqRegistry.getMetricsAsJSON();
      const counter = metrics.find(m => m.name === 'webhook_dlq_operations_total');
      const value = counter.values.find(v => v.labels.operation === 'enqueue');
      expect(value.value).toBe(1);
    });
    
    it('increments drop_overflow counter', async () => { /* ... */ });
    it('increments drop_poison counter', async () => { /* ... */ });
  });
  
  describe('incrementDlqReplay', () => {
    it('increments success counter', async () => { /* ... */ });
    it('increments failed counter', async () => { /* ... */ });
    it('increments idempotent_noop counter', async () => { /* ... */ });
    it('increments error counter', async () => { /* ... */ });
  });
});
```

#### 3.3 src/middleware/metricsAuth.test.ts Extension

**New Test (Requirement 8 criterion 5):**

```typescript
import * as crypto from 'crypto';

describe('constant-time comparison', () => {
  it('calls timingSafeEqual only when buffer lengths match', async () => {
    const spy = jest.spyOn(crypto, 'timingSafeEqual');
    process.env.METRICS_AUTH_TOKEN = 'token12';
    
    // Length mismatch - should NOT call timingSafeEqual
    await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer short');
    
    expect(spy).not.toHaveBeenCalled();
    
    spy.mockClear();
    
    // Length match - should call timingSafeEqual
    await request(buildApp())
      .get('/metrics')
      .set('Authorization', 'Bearer token99');  // same length as token12
    
    expect(spy).toHaveBeenCalledTimes(1);
    
    spy.mockRestore();
  });
});
```

#### 3.4 src/observability/metrics-service.test.ts Extensions

**New Tests:**

1. **Route limit boundary tests (Requirement 8 criterion 3)**
   ```typescript
   it('tracks routes individually below the limit', async () => {
     const service = new MetricsService('test', register, { httpRouteLabelLimit: 100 });
     // Record 99 unique routes
     // Assert all 99 appear as distinct labels
   });
   
   it('collapses to "other" when limit reached', async () => {
     const service = new MetricsService('test', register, { httpRouteLabelLimit: 2 });
     recordHttpRequest(service, { routePath: '/route1' });
     recordHttpRequest(service, { routePath: '/route2' });
     recordHttpRequest(service, { routePath: '/route3' });  // ← should be "other"
     
     const labels = await routeLabels(register);
     expect(labels).toContain('other');
     expect(labels).not.toContain('/route3');
   });
   ```

2. **Health status gauge tests (Requirement 8 criterion 6)**
   ```typescript
   it('recordHealthStatus sets gauge to 2 for up', async () => {
     service.recordHealthStatus('up');
     const json = await register.getMetricsAsJSON();
     const gauge = json.find(m => m.name === 'service_health_status');
     expect(gauge.values[0].value).toBe(2);
   });
   
   it('recordHealthStatus sets gauge to 1 for degraded', async () => {
     service.recordHealthStatus('degraded');
     const json = await register.getMetricsAsJSON();
     const gauge = json.find(m => m.name === 'service_health_status');
     expect(gauge.values[0].value).toBe(1);
   });
   
   it('recordHealthStatus sets gauge to 0 for down', async () => {
     service.recordHealthStatus('down');
     const json = await register.getMetricsAsJSON();
     const gauge = json.find(m => m.name === 'service_health_status');
     expect(gauge.values[0].value).toBe(0);
   });
   ```

---

### 4. docs/observability.md Structure

**Purpose:** The catalog document fulfilling Requirements 1-7.

**Section Outline:**

```markdown
# Observability Metrics Catalog

## Introduction
- Purpose of this document
- Audience (operators, SREs, platform engineers)
- How to use this catalog

## Metrics Scrape Endpoint (Requirement 3)
### Endpoint Contract
- URL: GET /metrics
- Port: PORT env var (default 3001)
- Content-Type: text/plain; version=0.0.4; charset=utf-8

### Authentication (Requirement 3)
- METRICS_AUTH_TOKEN configuration
- Bearer token requirement
- Constant-time comparison details
- 401 response format
- Security recommendations

### Example Prometheus Scrape Config (Requirement 3)
```yaml
scrape_configs:
  - job_name: talenttrust-backend
    ...
```

### METRICS_ENABLED Flag (Requirement 3)
- Behavior when set to "false"

## Cardinality Controls (Requirement 4)
### HTTP_METRICS_ROUTE_LABEL_LIMIT
- Default value (100)
- Accepted range (1-10,000)
- Behavior at limit (new routes → "other")
- Unmatched request handling

### Provider ID Redaction
- Format: <first-4-chars>****
- Applied to: webhook_rate_limit_tokens, webhook_rate_limit_queue_depth

### Label Value Sources
- Four permitted sources enumeration
- What is NOT used as labels

## Exported Metrics Catalog (Requirements 1, 2, 7)

### Table Format
| Metric Name | Type | Labels | Unit | Description | Source Module | Histogram Buckets |
|-------------|------|--------|------|-------------|---------------|-------------------|
| ... | ... | ... | ... | ... | ... | ... |

**Metrics to include:**
- http_requests_total
- http_request_duration_seconds (with bucket list)
- service_health_status (with encoding: up=2, degraded=1, down=0)
- webhook_deliveries_total
- webhook_dlq_depth
- webhook_rate_limit_tokens
- webhook_rate_limit_queue_depth
- webhook_dlq_operations_total (from utils/webhookMetrics.ts)
- webhook_dlq_replays_total (from utils/webhookMetrics.ts)
- webhook_delivery_attempts_total (from src/webhookMetrics.ts)
- webhook_delivery_latency_seconds (from src/webhookMetrics.ts, with bucket list)
- webhook_delivery_retries_total (from src/webhookMetrics.ts)
- webhook_breaker_state (from src/webhookMetrics.ts, with encoding: CLOSED=0, OPEN=1, HALF_OPEN=2)
- talenttrust_backend_* (prom-client default metrics)

### Histogram Bucket Documentation (Requirement 2)
For each histogram:
- List all bucket upper bounds in ascending order
- Include +Inf
- Note: quantile estimates interpolated linearly; resolution degrades beyond largest finite bucket

### WebhookMetrics DLQ Series Details (Requirement 7)
#### Ownership Table
| Series | Incremented By | Set By |
|--------|----------------|--------|
| webhook_dlq_operations_total | utils/webhookMetrics.ts | - |
| webhook_dlq_replays_total | utils/webhookMetrics.ts | - |
| webhook_deliveries_total | - | metrics-service.ts |
| webhook_dlq_depth | - | metrics-service.ts |

#### Label Value Semantics
- operation label values: enqueue, drop_overflow, drop_poison (meanings)
- outcome label values: success, failed, idempotent_noop, error (meanings)

## Service Level Objectives (Requirement 5)

### healthCheck Operation
**SLO Targets:**
- Success Rate: 99.99%
- p95 Latency: 50ms
- p99 Latency: 100ms

**Metrics Series:**
- Success rate: `http_requests_total`
- Latency: `http_request_duration_seconds`

**Alert Thresholds:**
- Max Error Rate: 0.1%
- Max Average Latency: 150ms
- Evaluation Window: 300s (5 minutes)

**Prometheus Alert Rule:**
```yaml
groups:
  - name: healthCheck_slo
    rules:
      - alert: HealthCheckSLOBreach
        expr: (rate(http_requests_total{...}[5m]) ...)
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Health check SLO breached"
```

### contractsApi Operation
**SLO Targets:**
- Success Rate: 99.9%
- p95 Latency: 200ms
- p99 Latency: 500ms

**Metrics Series:**
- Success rate: `http_requests_total`
- Latency: `http_request_duration_seconds`

**Alert Thresholds:**
- Max Error Rate: 1.0%
- Max Average Latency: 400ms
- Evaluation Window: 300s (5 minutes)

**Prometheus Alert Rule:**
```yaml
groups:
  - name: contractsApi_slo
    rules:
      - alert: ContractsApiSLOBreach
        expr: ...
```

## Health Status Gauge (Requirement 6)

### Numeric Encoding
- `service_health_status = 2` → up
- `service_health_status = 1` → degraded
- `service_health_status = 0` → down

### Runtime Signal Thresholds
**Event Loop Lag:**
- `eventLoopLagMs >= 250` → degraded
- `eventLoopLagMs >= 1000` → down

**Heap Used Ratio:**
- `heapUsedRatio >= 0.85` → degraded
- `heapUsedRatio >= 0.95` → down

### Status Merge Logic
- HealthService evaluates all signals and dependency checkers
- Worst status wins: down > degraded > up
- Dependency checker exception → down

### Prometheus Alert Rule
```yaml
groups:
  - name: service_health
    rules:
      - alert: ServiceHealthDegraded
        expr: service_health_status{service="talenttrust-backend"} < 2
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Service health degraded or down"
```

## Appendix: Coverage Report
- Link to CI coverage artifacts
- Per-module coverage thresholds (≥95%)
```

---

### 5. jest.config.js Coverage Thresholds

**Addition to jest.config.js:**

```javascript
coverageThreshold: {
  global: {
    lines: 0,
    statements: 0,
    functions: 0,
    branches: 0,
  },
  './src/observability/metrics-service.ts': {
    lines: 95,
    branches: 95,
    functions: 95,
    statements: 95,
  },
  './src/observability/health-service.ts': {
    lines: 95,
    branches: 95,
    functions: 95,
    statements: 95,
  },
  './src/middleware/metricsAuth.ts': {
    lines: 95,
    branches: 95,
    functions: 95,
    statements: 95,
  },
  './src/utils/webhookMetrics.ts': {
    lines: 95,
    branches: 95,
    functions: 95,
    statements: 95,
  },
},
```

**Rationale:**
- Global threshold remains 0 (no breaking change for unrelated modules)
- Per-file thresholds enforce Requirement 8 criterion 1
- CI will fail if coverage drops below 95% for any of the 4 modules

---

## Data Flow Diagrams

### Metrics Registration and Scrape Flow

```
┌─────────────────┐
│  Application    │
│  Startup        │
└────────┬────────┘
         │
         ├──► MetricsService(register)
         │    ├── http_requests_total
         │    ├── http_request_duration_seconds
         │    ├── service_health_status
         │    ├── webhook_deliveries_total
         │    ├── webhook_dlq_depth
         │    ├── webhook_rate_limit_tokens
         │    └── webhook_rate_limit_queue_depth
         │
         ├──► webhookDlqOperationsTotal (isolated registry)
         ├──► webhookDlqReplaysTotal (isolated registry)
         │
         └──► prom-client collectDefaultMetrics()
              └── talenttrust_backend_* series

┌─────────────────┐
│  Prometheus     │
│  Scraper        │
└────────┬────────┘
         │
         ▼
    GET /metrics
         │
         ▼
  metricsAuthMiddleware
    ├── No token configured → allow
    ├── Valid token → allow
    └── Invalid/missing → 401
         │
         ▼
  register.metrics()
         │
         ▼
  text/plain exposition format
```

### Round-Trip Verification Flow

```
┌──────────────────────────┐
│  CATALOG_METRIC_NAMES    │
│  (source of truth)       │
└────────────┬─────────────┘
             │
             ├──► Test Suite
             │    │
             │    ├──► Construct MetricsService
             │    ├──► Call getMetrics()
             │    ├──► Parse output
             │    └──► Assert registered === documented
             │
             └──► docs/observability.md
                  (human-readable catalog)
```

---

## Testing Strategy

### Coverage Target Breakdown

| Module | Lines | Branches | Functions | Statements |
|--------|-------|----------|-----------|------------|
| metrics-service.ts | ≥95% | ≥95% | ≥95% | ≥95% |
| health-service.ts | ≥95% | ≥95% | ≥95% | ≥95% |
| metricsAuth.ts | ≥95% | ≥95% | ≥95% | ≥95% |
| utils/webhookMetrics.ts | ≥95% | ≥95% | ≥95% | ≥95% |

### Test Isolation Strategy

1. **MetricsService tests**: Use dedicated `Registry` instance per test
2. **WebhookMetrics tests**: Use exported `webhookDlqRegistry`, clear between tests
3. **HealthService tests**: Use mock `RuntimeSignalProviders` (no real perf_hooks)
4. **MetricsAuth tests**: Use express + supertest with env var isolation

### Continuous Integration

**CI Pipeline (`.github/workflows/ci.yml`):**
1. Lint: `npm run lint` — must pass
2. Test: `npm run test:ci` — coverage report uploaded
3. Build: `npm run build` — TypeScript compilation
4. Security: `npm run audit:ci` — vulnerability scan

**Verification Steps:**
- All existing tests continue to pass
- New tests achieve ≥95% coverage for 4 target modules
- ESLint passes with no warnings
- TypeScript compilation succeeds
- No HIGH/CRITICAL npm vulnerabilities

---

## Security Considerations

### Metrics Endpoint Protection

**Threat:** Unauthorized access to operational metrics revealing system internals

**Mitigation:**
- Bearer token authentication via `METRICS_AUTH_TOKEN`
- Constant-time comparison prevents timing attacks
- Documentation recommends token protection in production

### Cardinality Explosion

**Threat:** Unbounded label values causing memory exhaustion

**Mitigations:**
- Route label cap (`HTTP_METRICS_ROUTE_LABEL_LIMIT`)
- Provider ID redaction (fixed format)
- No user input in labels
- Documented in catalog (Requirement 4)

### Documentation Drift

**Threat:** Catalog becomes outdated, operators build incorrect dashboards

**Mitigation:**
- Round-trip tests enforce synchronization
- CI fails if metric added/removed without catalog update

---

## Implementation Notes

### Backward Compatibility

- All existing tests must continue to pass
- No breaking changes to public APIs
- `docs/backend/observability.md` can be deprecated (redirect to `docs/observability.md`)

### Performance Impact

- No runtime performance impact (documentation only)
- Test suite adds ~5-10 seconds to CI (comprehensive coverage)

### Rollout Plan

1. Merge PR with design + implementation
2. Operators use `docs/observability.md` to build dashboards
3. Reference catalog in runbooks and onboarding docs
4. Deprecate `docs/backend/observability.md` (or make it redirect)

---

## Acceptance Criteria Mapping

| Requirement | Design Component |
|-------------|------------------|
| Req 1: Series Catalog Table | `docs/observability.md` metrics table |
| Req 2: Histogram Buckets | Bucket lists in metrics table |
| Req 3: Scrape Contract | Scrape endpoint section with YAML |
| Req 4: Cardinality Controls | Cardinality section + route limit docs |
| Req 5: SLO Cross-Reference | SLO section with alert rules |
| Req 6: Health Status Gauge | Health status section with encoding |
| Req 7: WebhookMetrics DLQ | Ownership table + label semantics |
| Req 8: Test Coverage | Test files + jest.config.js thresholds |
| Req 9: Round-Trip | `CATALOG_METRIC_NAMES` + test |

---

## Open Questions

None — design is complete and ready for implementation.
