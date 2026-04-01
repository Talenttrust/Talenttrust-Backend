# Architecture — TalentTrust Backend

## Module Layout

```
src/
├── index.ts          # Entry point — binds HTTP server to PORT
├── app.ts            # Express app factory (importable in tests)
└── routes/
    ├── health.ts     # GET /health
    └── contracts.ts  # GET /api/v1/contracts
```

## Design Decisions

### App factory pattern
`createApp()` in `app.ts` returns a configured Express instance without
starting the server. This lets tests import the app without binding a port,
keeping tests fast and side-effect-free.

### Route modules
Each route group lives in its own file under `src/routes/`. This makes it
straightforward to add middleware, validation, or sub-routers per domain
without touching unrelated code.

## Planned Integrations

- Stellar/Soroban SDK — on-chain contract interactions
- Database layer — contract metadata persistence
- Authentication middleware — JWT or Stellar keypair verification

## Security Notes

- All responses are JSON; no HTML rendering surface reduces XSS risk.
- Error handler strips stack traces from responses (information disclosure prevention).
- Dependency vulnerabilities are gated in CI via `npm audit --audit-level=high`.
- Helmet headers should be added before the service handles production traffic.
