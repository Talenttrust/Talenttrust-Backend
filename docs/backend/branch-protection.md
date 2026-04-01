# Branch Protection — TalentTrust Backend

## Overview

The `main` branch is protected. All changes must arrive via a pull request and
pass every required CI status check before merging.

## Required Status Checks

Configure these in **Settings → Branches → Branch protection rules** for `main`:

| Check name | Job in `ci.yml` | What it validates |
|---|---|---|
| `Lint` | `lint` | ESLint passes with zero errors |
| `Test` | `test` | All Jest tests pass; ≥95% line/function/statement coverage |
| `Build` | `build` | TypeScript compiles without errors |
| `Security Audit` | `security` | No HIGH or CRITICAL npm vulnerabilities |

## Recommended Settings

```
✅ Require a pull request before merging
  ✅ Require approvals: 1
  ✅ Dismiss stale pull request approvals when new commits are pushed
✅ Require status checks to pass before merging
  ✅ Require branches to be up to date before merging
  Required checks: Lint, Test, Build, Security Audit
✅ Require conversation resolution before merging
✅ Do not allow bypassing the above settings
```

## Threat Model

| Threat | Mitigation |
|---|---|
| Malicious dependency introduced | `npm audit --audit-level=high` blocks HIGH/CRITICAL CVEs |
| Broken TypeScript merged | `tsc --strict` compilation gate |
| Untested code paths merged | 95% coverage threshold enforced in `test:ci` |
| Lint regressions | ESLint gate with TypeScript-aware rules |
| Force-push to main | Branch protection disables force-push |

## Bypassing (break-glass)

Repository admins can bypass protection in genuine emergencies. Any bypass
must be documented in the PR description and followed up with a post-incident
review within 48 hours.
