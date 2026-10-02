---
type: Feature
title: "Add a webhook callback on contracts events"
labels: type:feature, area:contracts, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on contracts events

### Description
Consumers must poll for contracts changes. This issue adds an outbound webhook callback on notable contracts events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on contracts events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/contracts-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(contracts): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large contracts results"
labels: type:feature, area:contracts, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress contracts responses

### Description
Large contracts responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for contracts responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/contracts-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(contracts): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for contracts error-response bodies"
labels: type:test, area:contracts, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot contracts errors

### Description
contracts error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the contracts error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/contracts-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(contracts): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate contracts error handling into shared middleware"
labels: type:refactor, area:contracts, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize contracts errors

### Description
contracts handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route contracts errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/contracts-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(contracts): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for contracts"
labels: type:docs, area:contracts, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document contracts retention

### Description
contracts's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/contracts-retention.md` covering what contracts stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/contracts-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(contracts): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a webhook callback on milestones events"
labels: type:feature, area:milestones, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on milestones events

### Description
Consumers must poll for milestones changes. This issue adds an outbound webhook callback on notable milestones events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on milestones events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/milestones-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(milestones): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large milestones results"
labels: type:feature, area:milestones, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress milestones responses

### Description
Large milestones responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for milestones responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/milestones-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(milestones): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for milestones error-response bodies"
labels: type:test, area:milestones, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot milestones errors

### Description
milestones error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the milestones error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/milestones-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(milestones): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate milestones error handling into shared middleware"
labels: type:refactor, area:milestones, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize milestones errors

### Description
milestones handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route milestones errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/milestones-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(milestones): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for milestones"
labels: type:docs, area:milestones, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document milestones retention

### Description
milestones's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/milestones-retention.md` covering what milestones stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/milestones-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(milestones): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a webhook callback on reputation events"
labels: type:feature, area:reputation, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on reputation events

### Description
Consumers must poll for reputation changes. This issue adds an outbound webhook callback on notable reputation events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on reputation events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/reputation-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(reputation): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large reputation results"
labels: type:feature, area:reputation, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress reputation responses

### Description
Large reputation responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for reputation responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/reputation-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(reputation): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for reputation error-response bodies"
labels: type:test, area:reputation, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot reputation errors

### Description
reputation error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the reputation error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/reputation-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(reputation): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate reputation error handling into shared middleware"
labels: type:refactor, area:reputation, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize reputation errors

### Description
reputation handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route reputation errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/reputation-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(reputation): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for reputation"
labels: type:docs, area:reputation, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document reputation retention

### Description
reputation's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/reputation-retention.md` covering what reputation stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/reputation-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(reputation): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a webhook callback on disputes events"
labels: type:feature, area:disputes, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on disputes events

### Description
Consumers must poll for disputes changes. This issue adds an outbound webhook callback on notable disputes events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on disputes events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/disputes-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(disputes): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large disputes results"
labels: type:feature, area:disputes, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress disputes responses

### Description
Large disputes responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for disputes responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/disputes-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(disputes): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for disputes error-response bodies"
labels: type:test, area:disputes, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot disputes errors

### Description
disputes error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the disputes error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/disputes-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(disputes): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate disputes error handling into shared middleware"
labels: type:refactor, area:disputes, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize disputes errors

### Description
disputes handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route disputes errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/disputes-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(disputes): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for disputes"
labels: type:docs, area:disputes, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document disputes retention

### Description
disputes's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/disputes-retention.md` covering what disputes stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/disputes-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(disputes): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a webhook callback on audit events"
labels: type:feature, area:audit, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on audit events

### Description
Consumers must poll for audit changes. This issue adds an outbound webhook callback on notable audit events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on audit events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/audit-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(audit): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large audit results"
labels: type:feature, area:audit, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress audit responses

### Description
Large audit responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for audit responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/audit-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(audit): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for audit error-response bodies"
labels: type:test, area:audit, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot audit errors

### Description
audit error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the audit error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/audit-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(audit): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate audit error handling into shared middleware"
labels: type:refactor, area:audit, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize audit errors

### Description
audit handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route audit errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/audit-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(audit): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for audit"
labels: type:docs, area:audit, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document audit retention

### Description
audit's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/audit-retention.md` covering what audit stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/audit-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(audit): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a webhook callback on webhooks events"
labels: type:feature, area:webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on webhooks events

### Description
Consumers must poll for webhooks changes. This issue adds an outbound webhook callback on notable webhooks events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on webhooks events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/webhooks-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(webhooks): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large webhooks results"
labels: type:feature, area:webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress webhooks responses

### Description
Large webhooks responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for webhooks responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/webhooks-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(webhooks): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for webhooks error-response bodies"
labels: type:test, area:webhooks, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot webhooks errors

### Description
webhooks error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the webhooks error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/webhooks-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(webhooks): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate webhooks error handling into shared middleware"
labels: type:refactor, area:webhooks, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize webhooks errors

### Description
webhooks handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route webhooks errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/webhooks-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(webhooks): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for webhooks"
labels: type:docs, area:webhooks, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document webhooks retention

### Description
webhooks's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/webhooks-retention.md` covering what webhooks stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/webhooks-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(webhooks): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a webhook callback on auth events"
labels: type:feature, area:auth, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Notify on auth events

### Description
Consumers must poll for auth changes. This issue adds an outbound webhook callback on notable auth events.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a signed webhook to subscribers on auth events, with retry/backoff and a dead-letter path.
- Bound payload size; document the event schema.
- Cover delivery, retry, and DLQ in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/auth-51-webhook`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: delivery, retry, dead-letter.
- Include the full test output in the PR description.

### Example commit message
`feat(auth): add event webhook callback`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add gzip response compression for large auth results"
labels: type:feature, area:auth, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Compress auth responses

### Description
Large auth responses waste bandwidth. This issue enables compression for them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Enable gzip/deflate for auth responses above a size threshold; respect Accept-Encoding.
- No change for small responses.
- Cover compressed and uncompressed paths in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/auth-52-compress`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: above threshold compressed, small uncompressed.
- Include the full test output in the PR description.

### Example commit message
`feat(auth): compress large responses`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add snapshot tests for auth error-response bodies"
labels: type:test, area:auth, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Snapshot auth errors

### Description
auth error-response bodies aren't locked, so their shape can drift. This issue adds snapshot tests.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add snapshot tests for the auth error responses (RFC7807/structured shape) across the main failure codes.
- Update intentionally when the contract changes.
- Cover 400/404/409/500 shapes.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/auth-51-errsnap`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: 400, 404, 409, 500 shapes.
- Include the full test output in the PR description.

### Example commit message
`test(auth): snapshot error bodies`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Consolidate auth error handling into shared middleware"
labels: type:refactor, area:auth, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Centralize auth errors

### Description
auth handlers each format errors inconsistently. This issue centralizes it in error middleware.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Route auth errors through a shared error middleware producing consistent structured responses.
- Behaviour/codes unchanged; remove the per-handler duplication.
- Cover the middleware mapping in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/auth-51-errmw`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: each error maps consistently.
- Include the full test output in the PR description.

### Example commit message
`refactor(auth): centralize error handling`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
++++++
---
type: Feature
title: "Add a data-retention note for auth"
labels: type:docs, area:auth, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Document auth retention

### Description
auth's data-retention behavior is undocumented. This issue documents what's stored and for how long.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add `docs/auth-retention.md` covering what auth stores, retention windows, and purge behavior.
- Cross-reference the code; keep accurate.
- Note any PII handling.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/auth-51-retention`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against source.
- Include the full test output in the PR description.

### Example commit message
`docs(auth): document data retention`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
