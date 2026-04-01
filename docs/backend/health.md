# Health Endpoint

GET /health

Returns structured diagnostics for the TalentTrust backend and its dependencies.

## Response

| HTTP Status | Meaning                                         |
| ----------- | ----------------------------------------------- |
| 200         | All probes passed — service is healthy          |
| 503         | One or more probes failed — service is degraded |

### Body (non-production)

```json
{
  "status": "ok",
  "service": "talenttrust-backend",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptimeSeconds": 42,
  "probes": [
    { "name": "env", "ok": true, "latencyMs": 0 },
    { "name": "stellar-rpc", "ok": true, "latencyMs": 120 }
  ]
}
```

In **production** the `detail` field is omitted from all probes to prevent
internal topology leakage.

## Probes

| Name          | What it checks                                                 |
| ------------- | -------------------------------------------------------------- |
| `env`         | All vars listed in `REQUIRED_ENV_VARS` (comma-separated) exist |
| `stellar-rpc` | `STELLAR_RPC_URL` is reachable and returns HTTP < 500          |

## Environment Variables

| Variable            | Required | Description                                     |
| ------------------- | -------- | ----------------------------------------------- |
| `STELLAR_RPC_URL`   | No       | Soroban/Horizon RPC base URL                    |
| `REQUIRED_ENV_VARS` | No       | Comma-separated list of env var names to assert |

## Security

- `Cache-Control: no-store` is set on every response.
- Probe `detail` strings are stripped in `NODE_ENV=production`.
- No secret values are ever included in the response.

````

---

### README.md (updated)

Add a **Health Endpoint** section to the existing `README.md` under the Scripts table:

```markdown
## Health Endpoint

`GET /health` returns structured diagnostics for the service and its dependencies.

| Field | Description |
|-------|-------------|
| `status` | `"ok"` (HTTP 200) or `"degraded"` (HTTP 503) |
| `service` | Always `"talenttrust-backend"` |
| `timestamp` | ISO-8601 time of the check |
| `uptimeSeconds` | Process uptime in seconds |
| `probes` | Array of dependency probe results |

See [docs/backend/health.md](docs/backend/health.md) for full documentation.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `STELLAR_RPC_URL` | Soroban/Horizon RPC base URL to probe |
| `REQUIRED_ENV_VARS` | Comma-separated list of env var names to assert exist |

````
