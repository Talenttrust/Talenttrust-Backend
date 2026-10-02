---
type: Feature
title: "Add total-count pagination metadata to contracts list responses"
labels: type:feature, area:contracts, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count contracts pages

### Description
contracts list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Include a total-count (and page metadata) in contracts list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/contracts-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(contracts): add pagination total count`

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
title: "Add ETag / conditional-GET support to contracts read endpoints"
labels: type:feature, area:contracts, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag contracts

### Description
contracts reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a stable ETag on contracts reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/contracts-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(contracts): add conditional GET`

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
title: "Add spec-contract tests for contracts against the OpenAPI document"
labels: type:test, area:contracts, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test contracts

### Description
contracts responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add tests asserting contracts responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/contracts-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(contracts): add OpenAPI contract tests`

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
title: "Extract contracts magic strings into a constants module"
labels: type:refactor, area:contracts, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name contracts strings

### Description
contracts uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Move the contracts literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/contracts-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(contracts): extract string constants`

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
title: "Add a sequence diagram for the contracts request lifecycle"
labels: type:docs, area:contracts, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram contracts

### Description
contracts's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a docs section with a sequence diagram of the contracts request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/contracts-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(contracts): add sequence diagram`

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
title: "Add total-count pagination metadata to milestones list responses"
labels: type:feature, area:milestones, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count milestones pages

### Description
milestones list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Include a total-count (and page metadata) in milestones list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/milestones-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(milestones): add pagination total count`

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
title: "Add ETag / conditional-GET support to milestones read endpoints"
labels: type:feature, area:milestones, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag milestones

### Description
milestones reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a stable ETag on milestones reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/milestones-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(milestones): add conditional GET`

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
title: "Add spec-contract tests for milestones against the OpenAPI document"
labels: type:test, area:milestones, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test milestones

### Description
milestones responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add tests asserting milestones responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/milestones-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(milestones): add OpenAPI contract tests`

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
title: "Extract milestones magic strings into a constants module"
labels: type:refactor, area:milestones, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name milestones strings

### Description
milestones uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Move the milestones literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/milestones-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(milestones): extract string constants`

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
title: "Add a sequence diagram for the milestones request lifecycle"
labels: type:docs, area:milestones, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram milestones

### Description
milestones's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a docs section with a sequence diagram of the milestones request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/milestones-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(milestones): add sequence diagram`

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
title: "Add total-count pagination metadata to reputation list responses"
labels: type:feature, area:reputation, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count reputation pages

### Description
reputation list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Include a total-count (and page metadata) in reputation list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/reputation-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(reputation): add pagination total count`

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
title: "Add ETag / conditional-GET support to reputation read endpoints"
labels: type:feature, area:reputation, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag reputation

### Description
reputation reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a stable ETag on reputation reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/reputation-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(reputation): add conditional GET`

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
title: "Add spec-contract tests for reputation against the OpenAPI document"
labels: type:test, area:reputation, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test reputation

### Description
reputation responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add tests asserting reputation responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/reputation-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(reputation): add OpenAPI contract tests`

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
title: "Extract reputation magic strings into a constants module"
labels: type:refactor, area:reputation, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name reputation strings

### Description
reputation uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Move the reputation literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/reputation-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(reputation): extract string constants`

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
title: "Add a sequence diagram for the reputation request lifecycle"
labels: type:docs, area:reputation, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram reputation

### Description
reputation's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a docs section with a sequence diagram of the reputation request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/reputation-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(reputation): add sequence diagram`

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
title: "Add total-count pagination metadata to disputes list responses"
labels: type:feature, area:disputes, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count disputes pages

### Description
disputes list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Include a total-count (and page metadata) in disputes list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/disputes-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(disputes): add pagination total count`

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
title: "Add ETag / conditional-GET support to disputes read endpoints"
labels: type:feature, area:disputes, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag disputes

### Description
disputes reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a stable ETag on disputes reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/disputes-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(disputes): add conditional GET`

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
title: "Add spec-contract tests for disputes against the OpenAPI document"
labels: type:test, area:disputes, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test disputes

### Description
disputes responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add tests asserting disputes responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/disputes-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(disputes): add OpenAPI contract tests`

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
title: "Extract disputes magic strings into a constants module"
labels: type:refactor, area:disputes, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name disputes strings

### Description
disputes uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Move the disputes literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/disputes-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(disputes): extract string constants`

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
title: "Add a sequence diagram for the disputes request lifecycle"
labels: type:docs, area:disputes, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram disputes

### Description
disputes's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a docs section with a sequence diagram of the disputes request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/disputes-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(disputes): add sequence diagram`

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
title: "Add total-count pagination metadata to audit list responses"
labels: type:feature, area:audit, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Count audit pages

### Description
audit list responses omit a total count, so clients can't show page counts. This issue adds it.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Include a total-count (and page metadata) in audit list responses without an N+1 query.
- Keep it optional/behind a param if it's expensive.
- Cover the count in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/audit-61-count`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: count matches, empty set is 0.
- Include the full test output in the PR description.

### Example commit message
`feat(audit): add pagination total count`

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
title: "Add ETag / conditional-GET support to audit read endpoints"
labels: type:feature, area:audit, stack:nodejs, stack:typescript, priority:medium, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## ETag audit

### Description
audit reads always transfer full bodies. This issue adds ETag + If-None-Match 304 handling.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Emit a stable ETag on audit reads and return 304 for matching If-None-Match.
- Ensure the ETag changes when the resource changes.
- Cover 200 and 304 in tests.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b feature/audit-62-etag`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: fresh 200, matching 304, changed body new etag.
- Include the full test output in the PR description.

### Example commit message
`feat(audit): add conditional GET`

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
title: "Add spec-contract tests for audit against the OpenAPI document"
labels: type:test, area:audit, stack:nodejs, stack:typescript, priority:high, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Spec-test audit

### Description
audit responses can drift from the OpenAPI spec. This issue adds contract tests asserting conformance.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add tests asserting audit responses conform to the documented OpenAPI schema (status, shape).
- Fail on undocumented fields or wrong types.
- Keep deterministic.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b test/audit-61-spec`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: documented shape, wrong-type caught.
- Include the full test output in the PR description.

### Example commit message
`test(audit): add OpenAPI contract tests`

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
title: "Extract audit magic strings into a constants module"
labels: type:refactor, area:audit, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Name audit strings

### Description
audit uses repeated inline string literals (keys, codes). This issue centralizes them.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Move the audit literal strings into a constants module and reference them.
- Behaviour identical; no string value changes.
- Tests pass.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b refactor/audit-61-strconsts`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: values unchanged, tests pass.
- Include the full test output in the PR description.

### Example commit message
`refactor(audit): extract string constants`

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
title: "Add a sequence diagram for the audit request lifecycle"
labels: type:docs, area:audit, stack:nodejs, stack:typescript, priority:low, Stellar Wave, MAYBE REWARDED, GRANTFOX OSS, OFFICIAL CAMPAIGN, Official Campaign | FWC26
assignees: ''
---

## Diagram audit

### Description
audit's request lifecycle (middleware -> handler -> service -> repo) isn't visualized. This issue adds a diagram.

### Requirements and context
- **Repository scope:** Talenttrust/Talenttrust-Backend only.
- Add a docs section with a sequence diagram of the audit request lifecycle.
- Keep it accurate to the code.
- Link from the docs index.

### Suggested execution
- Fork the repo and create a branch
- `git checkout -b docs/audit-61-seqdiagram`
- Implement changes
  - **Write code in:** the relevant module.
  - **Write comprehensive tests in:** cover the new behaviour and edge cases.
- Test and commit

### Test and commit
- Run `npm run lint`, `npm test`, and `npm run build`.
- Cover edge cases: n/a — verify against code.
- Include the full test output in the PR description.

### Example commit message
`docs(audit): add sequence diagram`

### Guidelines
- **Minimum 95 percent test coverage** for impacted modules.
- Clear, reviewer-focused documentation.
- **Timeframe: 96 hours.**

### Community & contribution rewards
- 💬 **Join the TalentTrust community on Discord:** https://discord.gg/WqnGpcPx
- ⭐ This is a **GrantFox OSS / Official Campaign** task and **may be rewarded**. When your PR is merged you'll be prompted to rate the project — a **5-star rating** is much appreciated.
