# Metrics API Documentation

## Overview

This document provides a comprehensive reference for the metrics API endpoints in Talenttrust-Backend. The metrics endpoints expose Prometheus-formatted metrics for monitoring, alerting, and observability purposes.

**Target Audience:**
- DevOps engineers configuring Prometheus scraping
- Platform engineers building monitoring dashboards
- Backend developers integrating metrics collection
- SRE teams setting up alerts and SLOs

**Related Documentation:**
- [Observability Metrics Catalog](./observability.md) - Complete catalog of exported metrics, SLOs, and alert rules
- [Health Check API](./backend/health.md) - Service health and readiness endpoints

---

## Endpoints

### GET /metrics

**Purpose:** Exposes Prometheus-formatted application and runtime metrics for scraping by monitoring systems.

**Route Handler:** Registered via `MetricsService` in [`src/observability/metrics-service.ts`](../src/observability/metrics-service.ts)

**Authentication:** Protected by `metricsAuthMiddleware` from [`src/middleware/metricsAuth.ts`](../src/middleware/metricsAuth.ts)

---

#### Request

**HTTP Method:** `GET`

**URL:** `/metrics`

**Headers:**

| Header Name | Required | Description | Example |
|-------------|----------|-------------|---------|
| `Authorization` | Conditional | Bearer token for authentication. Required only when `METRICS_AUTH_TOKEN` environment variable is set. | `Bearer your-secret-token-here` |

**Query Parameters:** None

**Request Body:** None (GET request)

---

#### Response

##### Success Response (200 OK)

**Status Code:** `200 OK`

**Content-Type:** `text/plain; version=0.0.4; charset=utf-8`

**Response Format:** Prometheus text-based exposition format

**Response Body:** Plain text containing Prometheus metrics in the [Prometheus text exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format).

**Example Response:**

```text
# HELP http_requests_total Total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/health",status_code="200"} 1523
http_requests_total{method="GET",route="/api/v1/contracts",status_code="200"} 842
http_requests_total{method="POST",route="/api/v1/contracts",status_code="201"} 156
http_requests_total{method="GET",route="/api/v1/contracts/:id",status_code="404"} 12

# HELP http_request_duration_seconds Duration of HTTP requests in seconds.
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="0.005"} 1520
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="0.01"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="0.05"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="0.1"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="0.25"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="0.5"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="1"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="2.5"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="5"} 1523
http_request_duration_seconds_bucket{method="GET",route="/health",status_code="200",le="+Inf"} 1523
http_request_duration_seconds_sum{method="GET",route="/health",status_code="200"} 4.567
http_request_duration_seconds_count{method="GET",route="/health",status_code="200"} 1523

# HELP service_health_status Current service health status. up=2, degraded=1, down=0.
# TYPE service_health_status gauge
service_health_status{service="talenttrust-backend"} 2

# HELP webhook_deliveries_total Total webhook delivery attempts by outcome.
# TYPE webhook_deliveries_total counter
webhook_deliveries_total{outcome="success"} 4532
webhook_deliveries_total{outcome="failure"} 45
webhook_deliveries_total{outcome="dlq"} 12

# HELP webhook_dlq_depth Current number of entries in the webhook dead-letter queue.
# TYPE webhook_dlq_depth gauge
webhook_dlq_depth 3

# HELP webhook_rate_limit_tokens Current token count per provider in the rate-limiter bucket.
# TYPE webhook_rate_limit_tokens gauge
webhook_rate_limit_tokens{provider_id="stri****"} 95
webhook_rate_limit_tokens{provider_id="gith****"} 100

# HELP webhook_rate_limit_queue_depth Current queue depth (number of waiting deliveries) per provider in the rate-limiter.
# TYPE webhook_rate_limit_queue_depth gauge
webhook_rate_limit_queue_depth{provider_id="stri****"} 2
webhook_rate_limit_queue_depth{provider_id="gith****"} 0

# ... (additional Node.js runtime metrics omitted for brevity)
```

**Exported Metrics:**

The `/metrics` endpoint exports the following metric families:

| Metric Name | Type | Description | Source Module |
|-------------|------|-------------|---------------|
| `http_requests_total` | Counter | Total number of HTTP requests | `metrics-service.ts` |
| `http_request_duration_seconds` | Histogram | Duration of HTTP requests in seconds | `metrics-service.ts` |
| `service_health_status` | Gauge | Current service health status (2=up, 1=degraded, 0=down) | `metrics-service.ts` |
| `webhook_deliveries_total` | Counter | Total webhook delivery attempts by outcome | `metrics-service.ts` |
| `webhook_dlq_depth` | Gauge | Current number of entries in the webhook DLQ | `metrics-service.ts` |
| `webhook_rate_limit_tokens` | Gauge | Current token count per provider in the rate-limiter | `metrics-service.ts` |
| `webhook_rate_limit_queue_depth` | Gauge | Current queue depth per provider in the rate-limiter | `metrics-service.ts` |
| `webhook_dlq_operations_total` | Counter | Total webhook DLQ operations | `utils/webhookMetrics.ts` |
| `webhook_dlq_replays_total` | Counter | Total webhook DLQ replay attempts | `utils/webhookMetrics.ts` |
| `webhook_delivery_attempts_total` | Counter | Total webhook delivery attempts | `webhookMetrics.ts` |
| `webhook_delivery_latency_seconds` | Histogram | Webhook delivery latency in seconds | `webhookMetrics.ts` |
| `webhook_delivery_retries_total` | Counter | Total webhook delivery retries | `webhookMetrics.ts` |
| `webhook_breaker_state` | Gauge | Circuit breaker state per provider (0=CLOSED, 1=OPEN, 2=HALF_OPEN) | `webhookMetrics.ts` |
| `talenttrust_backend_*` | Various | Node.js runtime metrics (heap, CPU, GC, etc.) | `prom-client` |

For detailed information about each metric including labels, cardinality controls, and usage examples, see [Observability Metrics Catalog](./observability.md).

---

##### Error Responses

###### 401 Unauthorized

**Status Code:** `401 Unauthorized`

**Condition:** Returned when authentication is required (`METRICS_AUTH_TOKEN` is set) and:
- The `Authorization` header is missing
- The `Authorization` header does not start with `Bearer `
- The supplied token does not match the configured `METRICS_AUTH_TOKEN`

**Content-Type:** `application/json`

**Response Body:**

```json
{
  "error": "Unauthorized"
}
```

**Security Notes:**
- The response body never leaks the configured token value
- Token comparison uses `crypto.timingSafeEqual()` to prevent timing attacks
- Both missing tokens and incorrect tokens return the same generic error message

---

###### 404 Not Found

**Status Code:** `404 Not Found`

**Condition:** Returned when the `METRICS_ENABLED` environment variable is set to `false`, `0`, `no`, or `off`.

**Content-Type:** Depends on the global 404 handler configuration

**Response Body:** Standard 404 error response from the application

**Note:** This behavior allows completely disabling metrics export in environments where it's not needed.

---

## Authentication

### Overview

The `/metrics` endpoint supports optional Bearer token authentication to prevent unauthorized access to application metrics.

### Configuration

Authentication is controlled by the `METRICS_AUTH_TOKEN` environment variable:

| Environment Variable | Description | Required | Default |
|---------------------|-------------|----------|---------|
| `METRICS_AUTH_TOKEN` | Bearer token for metrics endpoint authentication | No | None (unauthenticated access allowed) |

### Authentication Modes

#### Unauthenticated Mode

**When:** `METRICS_AUTH_TOKEN` is not set or is an empty string

**Behavior:** The `/metrics` endpoint allows **unauthenticated access**. No `Authorization` header is required.

**Use Case:** Development and test environments where metrics don't contain sensitive information

**Security Warning:** ⚠️ Unauthenticated access is **NOT recommended** for staging or production environments. Metrics can expose:
- Request patterns and traffic volume
- Error rates and failure modes
- Resource utilization patterns
- Webhook provider information (partially redacted)

---

#### Authenticated Mode

**When:** `METRICS_AUTH_TOKEN` is set to a non-empty string

**Behavior:** The `/metrics` endpoint **requires authentication**. Every request must include a valid `Authorization` header.

**Required Header:**

```
Authorization: Bearer <your-secret-token>
```

**Token Format:** The token must:
- Match the configured `METRICS_AUTH_TOKEN` value **exactly** (case-sensitive, byte-for-byte)
- Be preceded by the `Bearer ` prefix in the `Authorization` header (note the space after "Bearer")
- Use the exact scheme `Bearer` (case-sensitive: `bearer`, `BEARER`, etc. will be rejected)

---

### Authentication Examples

#### Successful Authentication

**Request:**

```http
GET /metrics HTTP/1.1
Host: api.example.com
Authorization: Bearer super-secret-token-12345
```

**Response:**

```http
HTTP/1.1 200 OK
Content-Type: text/plain; version=0.0.4; charset=utf-8

# HELP http_requests_total Total number of HTTP requests.
# TYPE http_requests_total counter
...
```

---

#### Missing Authorization Header

**Request:**

```http
GET /metrics HTTP/1.1
Host: api.example.com
```

**Response:**

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Unauthorized"
}
```

---

#### Incorrect Token

**Request:**

```http
GET /metrics HTTP/1.1
Host: api.example.com
Authorization: Bearer wrong-token
```

**Response:**

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Unauthorized"
}
```

---

#### Wrong Authentication Scheme

**Request:**

```http
GET /metrics HTTP/1.1
Host: api.example.com
Authorization: Basic dXNlcjpwYXNzd29yZA==
```

**Response:**

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Unauthorized"
}
```

---

#### Case-Sensitive Scheme

**Request:**

```http
GET /metrics HTTP/1.1
Host: api.example.com
Authorization: bearer super-secret-token-12345
```

**Response:**

```http
HTTP/1.1 401 Unauthorized
Content-Type: application/json

{
  "error": "Unauthorized"
}
```

**Note:** The scheme must be exactly `Bearer` (capital B, lowercase rest). `bearer`, `BEARER`, or other case variations will be rejected.

---

### Security Features

The metrics authentication middleware ([`src/middleware/metricsAuth.ts`](../src/middleware/metricsAuth.ts)) implements the following security measures:

#### Constant-Time Comparison

**Implementation:** Uses `crypto.timingSafeEqual()` to compare tokens

**Protection Against:** Timing side-channel attacks where an attacker measures response times to deduce token characteristics

**How It Works:**
1. Both the configured token and supplied token are converted to `Buffer` instances
2. Length comparison is performed first (fast path for mismatched lengths)
3. If lengths match, `timingSafeEqual()` performs byte-by-byte comparison in constant time
4. This prevents attackers from using timing analysis to guess the token

**Example Attack Prevented:**
```javascript
// ❌ VULNERABLE: early return leaks information
if (provided[0] !== configured[0]) return false;
if (provided[1] !== configured[1]) return false;
// ... attacker can measure when each byte is wrong

// ✅ SECURE: constant-time comparison
timingSafeEqual(configuredBuf, providedBuf);
```

---

#### No Token Leakage

**Protection:** The configured token value is never logged or included in error responses

**Verified By:** Test case "does not leak the configured token value in the response body" in [`src/middleware/metricsAuth.test.ts`](../src/middleware/metricsAuth.test.ts)

**Example:**
```javascript
// ❌ VULNERABLE
res.status(401).json({ error: `Token mismatch: expected ${configured}` });

// ✅ SECURE
res.status(401).json({ error: "Unauthorized" });
```

---

#### Generic Error Messages

**Protection:** All authentication failures return the same generic `{"error":"Unauthorized"}` response

**Rationale:** Prevents information disclosure about:
- Whether the token exists
- Token length
- Token format
- Specific failure reason

**Example:** These all return the same error:
- No `Authorization` header
- Wrong authentication scheme (`Basic` instead of `Bearer`)
- Incorrect token value
- Empty token value

---

## Integration Examples

### Prometheus Scrape Configuration

**Basic Configuration (Unauthenticated):**

```yaml
scrape_configs:
  - job_name: 'talenttrust-backend'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['localhost:3001']
    scrape_interval: 15s
    scrape_timeout: 10s
```

---

**Authenticated Configuration:**

```yaml
scrape_configs:
  - job_name: 'talenttrust-backend'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['talenttrust-backend:3001']
    authorization:
      type: Bearer
      credentials: 'super-secret-token-12345'
    scrape_interval: 15s
    scrape_timeout: 10s
```

**Using Environment Variable Templating:**

```yaml
scrape_configs:
  - job_name: 'talenttrust-backend'
    metrics_path: '/metrics'
    static_configs:
      - targets: ['${BACKEND_HOST}:${BACKEND_PORT}']
    authorization:
      type: Bearer
      credentials: '${METRICS_AUTH_TOKEN}'
    scrape_interval: 15s
```

---

### cURL Examples

**Unauthenticated Request:**

```bash
curl http://localhost:3001/metrics
```

---

**Authenticated Request:**

```bash
curl -H "Authorization: Bearer super-secret-token-12345" \
     http://localhost:3001/metrics
```

---

**Using Environment Variable:**

```bash
export METRICS_AUTH_TOKEN="super-secret-token-12345"

curl -H "Authorization: Bearer $METRICS_AUTH_TOKEN" \
     http://localhost:3001/metrics
```

---

### Node.js HTTP Client Example

```javascript
const https = require('https');

const options = {
  hostname: 'api.example.com',
  port: 3001,
  path: '/metrics',
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${process.env.METRICS_AUTH_TOKEN}`
  }
};

const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    if (res.statusCode === 200) {
      console.log('Metrics:', data);
    } else {
      console.error('Error:', res.statusCode, data);
    }
  });
});

req.on('error', (error) => {
  console.error('Request failed:', error);
});

req.end();
```

---

### Python Example

```python
import os
import requests

METRICS_URL = "http://localhost:3001/metrics"
AUTH_TOKEN = os.environ.get("METRICS_AUTH_TOKEN")

headers = {}
if AUTH_TOKEN:
    headers["Authorization"] = f"Bearer {AUTH_TOKEN}"

response = requests.get(METRICS_URL, headers=headers)

if response.status_code == 200:
    print(response.text)
else:
    print(f"Error {response.status_code}: {response.text}")
```

---

## Configuration Reference

### Environment Variables

| Variable | Type | Required | Default | Description |
|----------|------|----------|---------|-------------|
| `METRICS_AUTH_TOKEN` | string | No | None | Bearer token for `/metrics` endpoint authentication. When set, all requests must include matching token. |
| `METRICS_ENABLED` | boolean | No | `true` | Enable or disable metrics endpoint. Accepted values: `true`, `1`, `yes`, `on` (enabled); `false`, `0`, `no`, `off` (disabled). |
| `HTTP_METRICS_ROUTE_LABEL_LIMIT` | integer | No | `100` | Maximum number of distinct route labels tracked in HTTP metrics. Range: 1-10000. |
| `SERVICE_NAME` | string | No | `talenttrust-backend` | Service name used as prefix for default Node.js runtime metrics. |
| `PORT` | integer | No | `3001` | HTTP server port where `/metrics` endpoint is exposed. |

---

### Configuration Examples

**Development Environment (.env):**

```bash
# Disable authentication for local development
# METRICS_AUTH_TOKEN not set

# Use default settings
METRICS_ENABLED=true
HTTP_METRICS_ROUTE_LABEL_LIMIT=100
SERVICE_NAME=talenttrust-backend
PORT=3001
```

---

**Production Environment (.env):**

```bash
# Require authentication in production
METRICS_AUTH_TOKEN=generate-secure-random-token-here

# Enable metrics with production limits
METRICS_ENABLED=true
HTTP_METRICS_ROUTE_LABEL_LIMIT=250
SERVICE_NAME=talenttrust-backend
PORT=3001
```

---

**Staging Environment (Metrics Disabled):**

```bash
# Disable metrics completely in staging
METRICS_ENABLED=false
```

---

## Error Codes Reference

### HTTP Status Codes

| Status Code | Meaning | Condition | Response Body |
|-------------|---------|-----------|---------------|
| `200 OK` | Success | Metrics retrieved successfully | Prometheus text format metrics |
| `401 Unauthorized` | Authentication failed | Missing, invalid, or incorrect authentication token | `{"error":"Unauthorized"}` |
| `404 Not Found` | Endpoint disabled | `METRICS_ENABLED` is set to `false` | Standard 404 response |
| `500 Internal Server Error` | Server error | Unexpected error during metrics collection | Standard error response |

---

### Error Scenarios

#### Authentication Errors (401)

| Scenario | Request | Response |
|----------|---------|----------|
| No Authorization header | `GET /metrics` | `401 Unauthorized` |
| Empty Bearer token | `Authorization: Bearer ` | `401 Unauthorized` |
| Wrong token | `Authorization: Bearer wrong` | `401 Unauthorized` |
| Wrong scheme | `Authorization: Basic ...` | `401 Unauthorized` |
| Case mismatch | `Authorization: bearer ...` | `401 Unauthorized` |
| Extra whitespace | `Authorization: Bearer  token` | `401 Unauthorized` |

**All scenarios return the same response:**

```json
{
  "error": "Unauthorized"
}
```

---

#### Endpoint Disabled (404)

**Condition:** `METRICS_ENABLED=false`

**Request:**

```http
GET /metrics HTTP/1.1
Host: api.example.com
```

**Response:**

```http
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": "Not Found",
  "message": "The requested resource does not exist"
}
```

**Note:** The exact 404 response format depends on the application's global 404 handler configuration.

---

## Performance Considerations

### Response Size

The `/metrics` endpoint response size varies based on:
- Number of registered metrics (application + runtime)
- Metric cardinality (number of unique label combinations)
- Histogram bucket count
- Time-series data accumulated since startup

**Typical Response Size:**
- **Minimal:** ~2 KB (fresh start, low traffic)
- **Typical:** ~10-50 KB (production workload)
- **High Cardinality:** ~100-500 KB (many unique routes/providers)

**Optimization Tips:**
- Set `HTTP_METRICS_ROUTE_LABEL_LIMIT` to bound route cardinality
- Use Prometheus `metric_relabel_configs` to drop unnecessary labels
- Configure appropriate scrape intervals (15s recommended)

---

### Latency

**Typical Latency:** < 50ms

**Factors Affecting Latency:**
- Number of registered metrics
- Registry size (label cardinality)
- Node.js event loop pressure
- Garbage collection pauses

**SLO:** The `/metrics` endpoint is excluded from HTTP request metrics to avoid self-observation overhead.

---

### Cardinality Controls

To prevent unbounded memory growth from high-cardinality metrics, the application implements several controls:

#### Route Label Bounding

**Control:** `HTTP_METRICS_ROUTE_LABEL_LIMIT` environment variable

**Default:** 100 unique route templates

**Behavior:**
- Route templates are tracked up to the limit
- Additional routes are aggregated into `"other"` label
- Unmatched requests use `"unmatched"` label

**Example:**
```
http_requests_total{route="/api/v1/contracts/:id"} 150
http_requests_total{route="/api/v1/users/:id"} 80
http_requests_total{route="other"} 25  # Routes beyond limit
http_requests_total{route="unmatched"} 12  # No route match
```

See [Cardinality Controls](./observability.md#cardinality-controls) for complete details.

---

#### Provider ID Redaction

**Affected Metrics:**
- `webhook_rate_limit_tokens{provider_id}`
- `webhook_rate_limit_queue_depth{provider_id}`

**Format:** First 4 characters + `****`

**Example:**
- `stripe-webhook-prod-12345` → `stri****`
- `github-app-webhook` → `gith****`

This bounds provider cardinality to the number of distinct prefixes.

---

## Testing

### Manual Testing

**Test Unauthenticated Access:**

```bash
# Should succeed if METRICS_AUTH_TOKEN is not set
curl -v http://localhost:3001/metrics
```

---

**Test Authenticated Access:**

```bash
# Set token
export METRICS_AUTH_TOKEN="test-token-12345"

# Should succeed with correct token
curl -v -H "Authorization: Bearer test-token-12345" \
     http://localhost:3001/metrics

# Should fail with wrong token (401)
curl -v -H "Authorization: Bearer wrong-token" \
     http://localhost:3001/metrics

# Should fail with no token (401)
curl -v http://localhost:3001/metrics
```

---

**Test Disabled Endpoint:**

```bash
# Set METRICS_ENABLED=false in .env or environment
export METRICS_ENABLED=false

# Should return 404
curl -v http://localhost:3001/metrics
```

---

### Automated Testing

The metrics endpoint is covered by comprehensive automated tests:

**Test Files:**
- [`src/middleware/metricsAuth.test.ts`](../src/middleware/metricsAuth.test.ts) - Authentication middleware tests
- [`src/observability/metrics-service.test.ts`](../src/observability/metrics-service.test.ts) - Metrics service tests
- [`src/observability/metrics-catalog.test.ts`](../src/observability/metrics-catalog.test.ts) - Metrics catalog validation tests

**Test Coverage:**
- Authentication success scenarios
- Authentication failure scenarios (missing header, wrong token, wrong scheme)
- Token leakage prevention
- Timing attack mitigation
- Metric registration and export
- Cardinality controls
- Label value safety

**Run Tests:**

```bash
# Run all metrics-related tests
npm test -- metrics

# Run with coverage report
npm test -- --coverage metrics
```

**Minimum Coverage Requirement:** 95% line and branch coverage

---

## Troubleshooting

### Common Issues

#### 401 Unauthorized Error

**Symptom:** Prometheus scraping fails with 401 errors

**Possible Causes:**
1. `METRICS_AUTH_TOKEN` is set but Prometheus configuration doesn't include credentials
2. Token mismatch between environment variable and Prometheus config
3. Extra whitespace in token value
4. Case mismatch in `Bearer` scheme

**Solution:**
```yaml
# Ensure Prometheus config includes authorization
authorization:
  type: Bearer
  credentials: 'your-token-here'  # Must match METRICS_AUTH_TOKEN exactly
```

---

#### 404 Not Found Error

**Symptom:** `/metrics` returns 404

**Possible Causes:**
1. `METRICS_ENABLED` is set to `false`
2. Wrong endpoint URL
3. Application not fully initialized

**Solution:**
```bash
# Check environment variable
echo $METRICS_ENABLED

# Ensure it's not set to false/0/no/off
export METRICS_ENABLED=true
```

---

#### Empty Metrics Response

**Symptom:** `/metrics` returns 200 but no application metrics

**Possible Causes:**
1. No HTTP requests have been made yet (metrics are incremented on use)
2. Metrics service not properly initialized
3. Wrong metrics registry being exported

**Solution:**
```bash
# Make some HTTP requests to generate metrics
curl http://localhost:3001/health

# Then check metrics
curl http://localhost:3001/metrics | grep http_requests_total
```

---

#### High Memory Usage

**Symptom:** Application memory grows over time, possibly due to metrics

**Possible Causes:**
1. Unbounded route label cardinality (many unique route values)
2. Too many provider IDs in webhook metrics
3. Long-running process accumulating histogram observations

**Solution:**
```bash
# Set route label limit
export HTTP_METRICS_ROUTE_LABEL_LIMIT=100

# Restart application
npm run start
```

---

#### Prometheus Cannot Scrape

**Symptom:** Prometheus shows target as "DOWN"

**Possible Causes:**
1. Network connectivity issues
2. Firewall blocking port 3001
3. Application not running
4. Authentication errors

**Debugging Steps:**

```bash
# 1. Verify application is running
curl http://localhost:3001/health

# 2. Verify metrics endpoint is accessible
curl http://localhost:3001/metrics

# 3. Check Prometheus logs for error details
kubectl logs prometheus-pod-name

# 4. Verify network connectivity from Prometheus to application
kubectl exec -it prometheus-pod-name -- wget -O- http://talenttrust-backend:3001/metrics
```

---

## Additional Resources

### Related Documentation

- **[Observability Metrics Catalog](./observability.md)** - Complete list of exported metrics, label semantics, SLOs, and alert rules
- **[Health Check API](./backend/health.md)** - Service health and readiness endpoints for load balancers
- **[Error Handling](./backend/error-handling.md)** - Application error codes and handling strategies
- **[Security](./backend/security.md)** - Security best practices and authentication patterns

### External Resources

- [Prometheus Documentation](https://prometheus.io/docs/)
- [Prometheus Text Exposition Format](https://prometheus.io/docs/instrumenting/exposition_formats/#text-based-format)
- [Prometheus Best Practices](https://prometheus.io/docs/practices/)
- [prom-client Library](https://github.com/siimon/prom-client) - Node.js Prometheus client library

### Source Code References

- **Metrics Service:** [`src/observability/metrics-service.ts`](../src/observability/metrics-service.ts)
- **Authentication Middleware:** [`src/middleware/metricsAuth.ts`](../src/middleware/metricsAuth.ts)
- **Webhook Metrics:** [`src/webhookMetrics.ts`](../src/webhookMetrics.ts)
- **DLQ Metrics:** [`src/utils/webhookMetrics.ts`](../src/utils/webhookMetrics.ts)
- **Health Service:** [`src/observability/health-service.ts`](../src/observability/health-service.ts)

---

## Changelog

### Version 1.0.0 (Initial Release)

- Documented GET /metrics endpoint contract
- Added authentication requirements and examples
- Documented all HTTP status codes and error scenarios
- Included Prometheus scrape configuration examples
- Added integration examples (cURL, Node.js, Python)
- Documented environment variables and configuration
- Added troubleshooting guide
- Cross-referenced with observability.md for metric details

---

**Document Version:** 1.0.0  
**Last Updated:** 2026-07-24  
**Issue Reference:** [#694](https://github.com/Talenttrust/Talenttrust-Backend/issues/694)
