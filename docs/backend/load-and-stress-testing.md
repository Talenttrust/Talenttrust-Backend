# Load & Stress Test Suite

## Overview
Baseline performance tests for critical API endpoints.

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
npm run test:load

# Stress tests  
npm run test:stress

# All with coverage
npm run test:all
```

## Baseline Thresholds
| Endpoint | Max Avg Latency | Min RPS | Max Error Rate |
|---|---|---|---|
| /health | 100ms | 50 | 0% |
| /api/v1/contracts | 200ms | 30 | 0% |

## Security Notes
- Tests target localhost only — never run against production
- No sensitive credentials in test payloads
- Stress tests simulate up to 100 concurrent connections
