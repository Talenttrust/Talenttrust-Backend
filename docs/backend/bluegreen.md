# Blue-Green Deployment Guide

## Architecture

- **Blue**: Stable (port 3001)
- **Green**: New version (port 3002)
- **Router**: Load balancer (port 3000), proxies to ACTIVE_COLOR based on state.
- State: .deployment-state.json (local, gitignored)

## Security Notes

- Health checks (/health/live, /health/ready) before switch.
- No secrets in state; env vars for ports.
- Proxy logs requests, errors 502 on backend fail.
- Threat: Port scan (mitigate by firewall), state tampering (local only).

## Usage

1. Start blue: `npm run blue`
2. Deploy green: Start green instance, `npm run deploy:switch-green`
3. Test traffic via router: curl http://localhost:3000/api/v1/contracts
4. Rollback: `npm run deploy:rollback`
5. Status: `npm run deploy:status`

## Tests

95%+ coverage on router/deploy. Run `npm test`.

Edge cases: Unhealthy green (no switch), rollback from green.
