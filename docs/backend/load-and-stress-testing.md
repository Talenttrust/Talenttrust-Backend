# Load & Stress Test Suite

## Overview
Baseline performance tests for critical API endpoints validating against official SLO definitions.

## Tools
- **autocannon** — Node.js HTTP benchmarking library

## Endpoints Covered
| Endpoint | Method | Test Type |
|---|---|---|
| /health | GET | Load + Stress |
| /api/v1/contracts | GET | Load + Stress |

## Running Tests
```bash
# Unit tests only
npm run test:unit

# Load tests
npx jest src/tests/load --testPathIgnorePatterns=""

# Stress tests  
npx jest src/tests/stress --testPathIgnorePatterns=""
```

## Latency Envelopes & SLO Validation
All tests validate against canonical SLO definitions from `src/operations/service-objectives.ts`

### `/api/v1/contracts` Latency Envelope
| Metric | Target | Baseline Observed |
|---|---|---|
| Success Rate | ≥ 99.9% | 100.0% |
| P95 Latency | ≤ 200ms | 10ms |
| P99 Latency | ≤ 500ms | 12ms |
| Average Latency | ≤ 400ms | 6.6ms |
| Minimum RPS | ≥ 30 | 2800+ |
| Error Rate | 0% | 0% |

### `/health` Latency Envelope
| Metric | Target |
|---|---|
| Success Rate | ≥ 99.99% |
| P95 Latency | ≤ 50ms |
| Average Latency | ≤ 150ms |
| Error Rate | 0% |

## CI Safety
- Load tests run with 10 second duration (time-bounded)
- Maximum 30 second timeout per test
- All tests run against ephemeral localhost server

## Security Notes
- Tests target localhost only — never run against production
- No sensitive credentials in test payloads
- Stress tests simulate up to 100 concurrent connections
