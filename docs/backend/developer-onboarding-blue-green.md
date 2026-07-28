# Backend Developer Onboarding and Blue-Green Setup

This guide helps new contributors get the TalentTrust backend running locally and understand the blue/green development scripts used by the deployment workflow.

## Prerequisites

- Node.js 20 for parity with CI.
- npm.
- Redis for queue-backed flows and CI-equivalent tests.
- A local `.env` copied from `.env.example`.

```bash
npm ci
cp .env.example .env
```

If you are only working on docs or isolated unit tests, you may not need every external service. Route, queue, and deployment changes should be tested with Redis available because CI starts Redis for the Jest coverage job.

## Core Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the API with `ts-node-dev` using the default environment. |
| `npm run blue` | Run a blue instance with `APP_COLOR=blue` on port `3001`. |
| `npm run green` | Run a green instance with `APP_COLOR=green` on port `3002`. |
| `npm run router` | Run the router mode on port `3000`. |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run lint` | Run ESLint over `src`. |
| `npm run test:ci` | Run Jest in CI mode with coverage. |
| `npm run audit:ci` | Fail on high or critical npm advisories. |
| `npm run test:docs` | Validate the OpenAPI document. |

## Standard Local Loop

For a normal backend change:

```bash
npm ci
npm run lint
npm run test:ci
npm run build
npm run test:docs
```

For security-sensitive changes, also run:

```bash
npm run audit:ci
```

## Blue-Green Local Flow

The package scripts expose a simple local blue/green topology:

```bash
npm run blue
npm run green
npm run router
```

Use separate terminals for each process. The blue instance listens on `3001`, the green instance listens on `3002`, and the router listens on `3000`. This lets you validate routing, health checks, and cutover behavior without changing production infrastructure.

The deployment helper scripts are:

```bash
npm run deploy:status
npm run deploy:switch-green
npm run deploy:rollback
npm run deploy:auto-rollback
```

Use them only when you are specifically working on deployment behavior. For ordinary API work, keep the simpler `npm run dev` flow.

## Suggested Verification Matrix

When touching routing or deployment code, include these checks in the pull request notes:

- Blue instance starts and serves the expected health response.
- Green instance starts and serves the expected health response.
- Router mode starts on port `3000` and routes to the active color.
- `deploy:status` reports the expected active color.
- Rollback behavior is described or tested when the change affects cutover logic.

When touching API or service code, include:

- Relevant Jest tests and coverage result.
- Any new environment variables and defaults.
- Failure-path behavior for dependency errors.

## CI Expectations

The GitHub Actions pipeline requires:

- Lint with TypeScript-aware ESLint.
- Jest coverage via `npm run test:ci` with Redis available.
- TypeScript build via `npm run build`.
- `npm audit` high/critical policy gate.
- OpenAPI validation via `npm run test:docs`.

Keep the pull request description aligned with these gates. If a command is not relevant to a docs-only change, say so explicitly.

## Branch and Pull Request Notes

Use focused branch names, for example:

```text
docs/backend-345-blue-green-guide
fix/events-123-idempotency-replay
test/security-87-admin-rbac
```

Before requesting review, confirm the PR references its issue, explains verification, and does not include secrets, `.env` files, local databases, generated artifacts, or unrelated formatting changes.