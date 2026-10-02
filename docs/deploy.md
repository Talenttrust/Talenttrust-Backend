# Blue/Green Deploy Runbook

## Overview

Talenttrust Backend uses a **blue/green deployment strategy** to enable zero-downtime updates with automatic rollback on health check failure. This runbook covers the operator procedures for managing deployments.

### Topology

```
┌─────────────────────────────────────────────────────────────┐
│                   Load Balancer / DNS                        │
│                      (port 3000)                             │
└──────────────────┬──────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
   ┌────▼─────┐         ┌────▼─────┐
   │   Blue   │         │   Green  │
   │ (3001)   │         │ (3002)   │
   │ ACTIVE   │         │ STANDBY  │
   └──────────┘         └──────────┘

Router Health Check (3000): Directs traffic to active instance
Blue (3001):  Currently serving production traffic
Green (3002): Staged with new code, ready for promotion
```

## Quick Start

### Check Deployment Status
```bash
npm run deploy:status
```

**Output:**
```json
{
  "status": "success",
  "data": {
    "activeColor": "blue",
    "lastSwitch": 1685875200000,
    "blueHealth": { "healthy": true, "lastCheck": "2024-06-05T10:00:00Z" },
    "greenHealth": { "healthy": false, "lastCheck": "2024-06-05T10:05:00Z" }
  }
}
```

### Switch to Green (Promote)
```bash
npm run deploy:switch-green
```

**Behavior:**
1. Polls green instance's health endpoint (`GET /health/ready`)
2. Waits up to 30s for green to become healthy
3. Updates router to direct traffic to green (3002)
4. Green becomes active; blue becomes standby
5. Returns 202 Accepted if switch initiated, 200 OK if already green

**Output on success:**
```json
{
  "status": "success",
  "message": "Switched to green successfully."
}
```

**Output if green unhealthy:**
```json
{
  "error": {
    "code": "bad_gateway",
    "message": "Green instance is not healthy. Switch aborted."
  }
}
```

### Rollback to Blue
```bash
npm run deploy:rollback
```

**Behavior:**
1. Switches router back to blue (3001)
2. Blue becomes active; green becomes standby
3. No-op if already on blue

**Output:**
```json
{
  "status": "success",
  "message": "Rolled back to blue successfully.",
  "data": { "activeColor": "blue" }
}
```

---

## Detailed Procedures

### 1. Pre-Deployment Checklist

Before initiating a deployment, verify:

✅ **Green instance is ready**
```bash
curl -s http://localhost:3002/health/ready | jq .
```
Expected: `{ "healthy": true }`

✅ **Blue instance is healthy (current production)**
```bash
curl -s http://localhost:3001/health/ready | jq .
```
Expected: `{ "healthy": true }`

✅ **Router is accessible**
```bash
curl -s http://localhost:3000/health | jq .
```
Expected: `{ "status": "ok" }`

✅ **Environment variables are set**
```bash
echo $JWT_SECRET
echo $DATABASE_URL
```
All required secrets must be present.

### 2. Deployment Procedure

#### Step 1: Deploy Green Instance
```bash
# Start green instance with new code
NODE_ENV=production PORT=3002 npm start &

# Wait for green to become healthy (max 30s)
for i in {1..30}; do
  if curl -s http://localhost:3002/health/ready | grep -q '"healthy":true'; then
    echo "Green is ready after $i seconds"
    break
  fi
  sleep 1
done
```

#### Step 2: Promote Green to Active
```bash
npm run deploy:switch-green
```

**Monitor the switch:**
```bash
# Watch router logs
tail -f logs/router.log | grep "switch\|promotion"

# Verify new traffic goes to green
curl -s http://localhost:3000/health | jq .activeColor
# Should return: "green"
```

#### Step 3: Validate New Instance
```bash
# Check key endpoints on green
curl -s http://localhost:3002/api/v1/health | jq .
curl -s http://localhost:3002/api/v1/admin/deploy/status | jq .

# Monitor error rates for 2-5 minutes
tail -f logs/application.log | grep ERROR

# Check database connections
npm run db:status
```

#### Step 4: Drain Old Instance
After green has been active for 5+ minutes:

```bash
# Gracefully shutdown blue
npm run deploy:drain:blue

# Wait for in-flight requests to complete (max 30s)
sleep 30

# Verify blue is offline
curl -s http://localhost:3001/health 2>&1 | grep -q "Connection refused" && echo "Blue shutdown complete"
```

---

### 3. Health Gate Behavior

The `switch-green` command includes an **automatic health gate** that prevents switching to an unhealthy instance.

**Health Gate Flow:**
```
switch-green
    │
    ├─► Poll green:/health/ready
    │   (interval: 1s, timeout: 30s)
    │
    ├─► Healthy? ──[YES]──► Update router, return 202
    │                       │
    │                       └─► Monitor for 5min
    │                           Auto-rollback if errors spike
    │
    └─► Unhealthy? ──[YES]──► Abort switch, return 502
                               (Green not ready)
```

**Health Check Details:**
- **Endpoint:** `GET /health/ready`
- **Expected response:** `{ "healthy": true }`
- **Timeout:** 1 second per request
- **Poll interval:** 1 second
- **Total timeout:** 30 seconds

**Health criteria:**
- Database connectivity OK
- Required services responding
- No critical startup errors
- Memory usage within limits

---

### 4. Automatic Rollback Thresholds

If enabled, the deployment monitors error rates and automatically rolls back if:

- **Error rate spike:** >50% increase over baseline (5-minute window)
- **Database connection failures:** >5 consecutive errors
- **Critical service unavailable:** Health endpoint unreachable for >10s
- **Memory exhaustion:** Heap usage >90%

**To enable auto-rollback:**
```bash
export DEPLOY_AUTO_ROLLBACK=true
export DEPLOY_ERROR_THRESHOLD=50        # percent increase
export DEPLOY_MONITOR_DURATION=300000   # 5 minutes in ms

npm run deploy:switch-green
```

**Auto-rollback event:**
```bash
# Logs will show
[WARN] Deployment monitoring detected error spike (78% > 50%)
[WARN] Initiating automatic rollback...
[INFO] Rolled back to blue successfully
```

---

### 5. Interpreting `deploy:status` Output

```bash
npm run deploy:status
```

**Response:**
```json
{
  "status": "success",
  "data": {
    "activeColor": "blue",
    "lastSwitch": 1685875200000,
    "blueHealth": {
      "healthy": true,
      "lastCheck": "2024-06-05T10:00:00Z",
      "endpoint": "http://localhost:3001/health/ready"
    },
    "greenHealth": {
      "healthy": false,
      "lastCheck": "2024-06-05T10:05:00Z",
      "endpoint": "http://localhost:3002/health/ready",
      "error": "ECONNREFUSED"
    },
    "switchInProgress": false
  }
}
```

**Field Meanings:**

| Field | Meaning |
|-------|---------|
| `activeColor` | Current active instance: `blue` or `green` |
| `lastSwitch` | Timestamp of last successful switch (epoch ms) |
| `blueHealth.healthy` | Is blue instance healthy? |
| `greenHealth.healthy` | Is green instance healthy? |
| `switchInProgress` | Is a switch operation currently running? |
| `.error` | Error message if health check failed |

**Interpretation Guide:**

**Healthy deployment:**
```
activeColor: "blue"
blueHealth.healthy: true
greenHealth.healthy: true
switchInProgress: false
```
→ Safe to perform a switch

**Ready for rollback:**
```
activeColor: "green"
blueHealth.healthy: true
greenHealth.healthy: true
switchInProgress: false
```
→ Run `npm run deploy:rollback` to return to blue

**Degraded state:**
```
activeColor: "blue"
blueHealth.healthy: true
greenHealth.healthy: false
```
→ Green needs attention; do NOT attempt switch

**In-flight switch:**
```
switchInProgress: true
```
→ Wait for completion; do NOT issue new commands

---

### 6. Drain and Shutdown Procedures

#### Graceful Drain (Blue Instance)
```bash
npm run deploy:drain:blue
```

**What happens:**
1. Blue stops accepting new connections
2. In-flight requests have up to 30 seconds to complete
3. Long-polling clients are notified to reconnect to green
4. Database connections are closed gracefully
5. Blue process exits

**Drain timeout:**
- Hard timeout: 30 seconds
- Graceful period: 25 seconds
- Force kill: 5 seconds

#### Forced Shutdown
```bash
npm run deploy:kill:blue   # Force kill blue immediately
```

**⚠️ Only use if graceful drain hangs.**

---

### 7. Rollback Procedures

#### Immediate Rollback
```bash
npm run deploy:rollback
```

**Use when:**
- New code has a critical bug
- Error rate is unacceptable
- Data corruption is detected
- Operator decision

**Time to complete:** 2-5 seconds

#### Automated Rollback
If auto-rollback is enabled and error thresholds are exceeded:
- Automatic switch back to blue
- Alert sent to operations team
- Post-mortem recommended

**To check if auto-rollback was triggered:**
```bash
grep "auto.rollback" logs/application.log
```

---

### 8. Troubleshooting

#### Problem: Green won't become healthy

**Symptoms:**
```
npm run deploy:switch-green
# Returns: "Green instance is not healthy. Switch aborted."
```

**Diagnosis:**
```bash
# Check green logs
tail -100 logs/green.log | grep ERROR

# Check green health endpoint directly
curl -v http://localhost:3002/health/ready

# Check database connectivity
curl http://localhost:3002/api/v1/health | jq .database

# Check environment variables on green
ssh green-instance-ip
echo $DATABASE_URL
echo $JWT_SECRET
```

**Resolution:**
1. Fix the issue on green instance
2. Restart green: `npm run deploy:restart:green`
3. Wait 30 seconds for health checks
4. Retry: `npm run deploy:switch-green`

#### Problem: Switch hangs at health gate

**Symptoms:**
```
npm run deploy:switch-green
# No response after 30 seconds
```

**Diagnosis:**
```bash
# Check if green is responding
curl -w "\n%{http_code}\n" http://localhost:3002/health/ready

# Check if port 3002 is open
netstat -tuln | grep 3002

# Check process
ps aux | grep "PORT=3002"
```

**Resolution:**
1. Kill the switch command: `Ctrl+C`
2. Verify green is still running
3. Check for network issues
4. Try again: `npm run deploy:switch-green`

#### Problem: Router not directing traffic correctly

**Symptoms:**
```
curl http://localhost:3001/api/v1/health 200 OK
curl http://localhost:3002/api/v1/health 200 OK
curl http://localhost:3000/api/v1/health 502 Bad Gateway
```

**Diagnosis:**
```bash
# Check router process
ps aux | grep "PORT=3000"

# Check router logs
tail -50 logs/router.log

# Verify active color
npm run deploy:status | jq .activeColor

# Test direct connection to active instance
ACTIVE=$(npm run deploy:status | jq -r .activeColor)
curl http://localhost:300${ACTIVE:0:1}/health
```

**Resolution:**
1. Restart router: `npm run deploy:restart:router`
2. Verify connection to active instance
3. Check firewall rules

---

### 9. Monitoring and Alerts

#### Key Metrics to Monitor

**During deployment:**
- Error rate (should stay <1%)
- p95 latency (should stay <500ms)
- Database connection pool usage
- Memory usage on both instances
- Request volume per instance

#### Recommended Alerts

```yaml
alerts:
  - name: deployment_switch_failed
    condition: switch_failure > 0
    severity: critical
    
  - name: auto_rollback_triggered
    condition: auto_rollback_event == true
    severity: critical
    
  - name: health_gate_timeout
    condition: health_check_timeout > 30s
    severity: high
    
  - name: error_rate_spike
    condition: error_rate > baseline * 1.5
    severity: high
```

---

### 10. Rollback Decision Tree

```
Production error detected
        │
        ├─► Severity: CRITICAL (data loss, security)
        │   └─► IMMEDIATE ROLLBACK
        │       npm run deploy:rollback
        │
        ├─► Severity: HIGH (service down, major bug)
        │   └─► Check auto-rollback status
        │       if not auto-rolled back:
        │         npm run deploy:rollback
        │
        ├─► Severity: MEDIUM (degraded performance)
        │   └─► Monitor for 5 minutes
        │       if worsens:
        │         npm run deploy:rollback
        │       else:
        │         investigate and fix forward
        │
        └─► Severity: LOW (non-user impacting)
            └─► Investigate without rollback
                Fix in next deployment
```

---

## Reference

### Environment Variables

```bash
# Deployment Configuration
DEPLOY_AUTO_ROLLBACK=true              # Enable automatic rollback
DEPLOY_ERROR_THRESHOLD=50              # Error rate increase threshold (%)
DEPLOY_MONITOR_DURATION=300000         # Monitoring window (ms)
DEPLOY_HEALTH_TIMEOUT=30000            # Health gate timeout (ms)
DEPLOY_HEALTH_POLL_INTERVAL=1000       # Poll interval (ms)

# Instance Configuration
BLUE_PORT=3001                         # Blue instance port
GREEN_PORT=3002                        # Green instance port
ROUTER_PORT=3000                       # Router port
```

### CLI Commands

```bash
npm run deploy:status                  # Check current deployment state
npm run deploy:switch-green            # Promote green to active
npm run deploy:rollback                # Return to blue (previous)
npm run deploy:drain:blue              # Gracefully shutdown blue
npm run deploy:kill:blue               # Force kill blue
npm run deploy:restart:green           # Restart green instance
npm run deploy:restart:router          # Restart router
npm run db:status                      # Check database connectivity
```

### Related Documentation

- **Health Checks:** See `docs/health.md` for readiness and liveness probe behavior
- **Graceful Shutdown:** See `docs/shutdown.md` for drain timing and connection cleanup
- **Admin Auth:** See `docs/api-keys.md` for authenticated deploy endpoint access
- **Monitoring:** See `docs/observability.md` for metrics and alerting
- **Troubleshooting:** See `docs/troubleshooting.md` for common issues

---

## Security Notes

### Authentication
Deploy endpoints (`/api/v1/admin/deploy/*`) require admin authentication:
- **JWT:** `Authorization: Bearer <admin-token>`
- **API Key:** `X-API-Key: <admin-api-key>` with `deploy:*` scope

### No Hard-Coded Credentials
- Blue/green ports are environment-based
- Database URLs and secrets in `.env` only
- Router configuration injected at startup

### Audit Logging
All deploy operations are logged:
```
[AUDIT] actor=admin-user@example.com action=deploy:switch-green resource=deploy.blue->green
[AUDIT] actor=admin-user@example.com action=deploy:rollback resource=deploy.green->blue
```

---

## Appendix: Example Deployment Flow

```bash
#!/bin/bash
# Complete safe deployment workflow

set -e

echo "=== Pre-Deployment Checks ==="
curl -s http://localhost:3001/health/ready | jq .
curl -s http://localhost:3002/health/ready | jq .

echo "=== Current Status ==="
npm run deploy:status

echo "=== Starting Green with New Code ==="
export NODE_ENV=production
export PORT=3002
npm start &
GREEN_PID=$!

echo "=== Waiting for Green to be Ready ==="
sleep 5

echo "=== Switching to Green ==="
npm run deploy:switch-green

echo "=== Validating Green (5 minute window) ==="
sleep 30
tail logs/application.log | grep -c ERROR || echo "No errors detected"

echo "=== Draining Blue ==="
npm run deploy:drain:blue

echo "=== Deployment Complete ==="
npm run deploy:status | jq .

echo "✓ Deployment successful"
```

---

## Promotion / Rollback Lifecycle

The `promoter` module (`src/deployment/promoter.ts`) orchestrates environment
promotions (dev → staging → production) with validation, blue-green switching,
audit logging, and persisted history.

### Promotion Flow

```
PromotionRequest
   │
   ▼
┌─────────────────────────────┐
│ validatePromotionPath       │  ← dev→staging or staging→production only
│   └─ valid? ─── NO ──► 400  │
└───────────┬─────────────────┘
            │ YES
            ▼
┌─────────────────────────────┐
│ loadEnvironmentConfig       │  ← transient NODE_ENV swap for target
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│ validateDeploymentReadiness │  ← port/URL/CORS/Stellar validation
│   └─ valid? ─── NO ──► 400  │
└───────────┬─────────────────┘
            │ YES
            ▼
┌─────────────────────────────┐
│ performHealthCheck          │  ← GET /health/ready (non-fatal)
└───────────┬─────────────────┘
            │
            ▼
┌─────────────────────────────┐
│ switchToGreen (deploy.ts)   │  ← blue-green state machine
│   └─ throws? ─── YES ──►   │
│       record FAILURE + audit│
└───────────┬─────────────────┘
            │ OK
            ▼
┌─────────────────────────────┐
│ recordPromotion (SUCCESS)   │  ← INSERT into deployment_history
│ auditService.log (INFO)     │
└─────────────────────────────┘
```

### Rollback Flow

```
RollbackRequest
   │
   ▼
┌─────────────────────────────┐
│ targetVersion present?      │  ← required
│ environment ≠ development?  │
│   └─ NO ──► 400             │
└───────────┬─────────────────┘
            │ YES
            ▼
┌─────────────────────────────┐
│ rollback (deploy.ts)        │  ← reverts to previous colour
│   └─ throws? ─── YES ──►   │
│       record FAILURE + audit│
└───────────┬─────────────────┘
            │ OK
            ▼
┌─────────────────────────────┐
│ recordRollback (SUCCESS)    │  ← INSERT into deployment_history
│ auditService.log (WARNING)  │
└─────────────────────────────┘
```

### History

`getPromotionHistory(environment)` queries `deployment_history` for all rows
where the environment appears as source or target, ordered by timestamp
descending. Each record includes:

| Field        | Source                  |
|--------------|-------------------------|
| `from`       | `environment_from`      |
| `to`         | `environment_to`        |
| `version`    | `target_version`        |
| `initiatedBy`| `initiated_by`          |
| `timestamp`  | ISO-8601 in UTC         |

### Audit Events

| Event                    | Severity  | When                         |
|--------------------------|-----------|------------------------------|
| `DEPLOYMENT_PROMOTED`    | `INFO`    | Successful promotion         |
| `DEPLOYMENT_PROMOTED`    | `CRITICAL`| Failed promotion             |
| `DEPLOYMENT_ROLLED_BACK` | `WARNING` | Successful rollback          |
| `DEPLOYMENT_ROLLED_BACK` | `CRITICAL`| Failed rollback              |

### Valid Promotion Paths

| From           | To             |
|----------------|----------------|
| `development`  | `staging`      |
| `staging`      | `production`   |
| `production`   | *(none)*       |
| `test`         | *(none)*       |

Any other path produces a `ValidationResult` with `valid: false` and a
descriptive error message. Direct `development → production` promotions emit
a warning but are currently rejected by the path validator.

---

**Last Updated:** 2026-07-25  
**Version:** 2.0  
**Audience:** Operators, DevOps, On-call Engineers
