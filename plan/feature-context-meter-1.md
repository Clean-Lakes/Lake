---
goal: Display per-conversation context occupancy and provider usage
version: 1
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Lake
status: 'Completed'
tags: [feature, ai, usage, react, go]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Add an accessible context indicator and expandable usage panel. Separate estimated current context, configured window, latest provider request usage/cache hits and cumulative session usage.

## 1. Requirements & Constraints

- **REQ-001**: Display current context/window occupancy and a hover/click/focus panel with used tokens, cache hits and session total.
- **REQ-002**: Preserve provider input/output/cache counts and latest normal request usage. Unknown provider/cache values remain unknown.
- **REQ-003**: Context estimate uses existing historyCost and tool schema budget; snapshots reflect compaction, clear and rollback independently of cumulative usage.
- **SEC-001**: Usage metadata contains numbers only, without messages, keys or private material.
- **CON-001**: Build bin/lake only through signed scripts/build_lake.sh; keep compaction notifications hidden.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Track and expose numerical usage.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Extend Usage/View/State in internal/ai/types.go, normalize provider cached input and known usage in provider.go, accumulate and snapshot context in engine.go/context.go; invalidate last request after compaction and history edits. | ✅ | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: Display context without adding transcript noise.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-002 | Extend web-agent/shared/contracts.ts and add ContextUsage.tsx beside Agent controls with occupancy ring, expandable panel, unknown/estimated labels and scoped CSS. Depends on TASK-001. | ✅ | 2026-10-11 |

### Implementation Phase 3

- **GOAL-003**: Verify accuracy and presentation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add provider normalization and context lifecycle regression tests; run Go race/vet, frontend checks/build; verify panel with isolated browser data and signed/no-Node binary; restart idle service. Depends on TASK-001 and TASK-002. | ✅ | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: Reusing cumulative token totals as current context was rejected because repeated tool calls and compaction make those quantities different.
- **ALT-002**: Showing missing cache usage as zero was rejected because absent reporting is unknown.

## 4. Dependencies

- **DEP-001**: Existing six-protocol usage accumulator, context budget estimate and React session snapshot.

## 5. Files

- **FILE-001**: internal/ai/types.go, provider.go, engine.go, context.go and context_test.go.
- **FILE-002**: web-agent/shared/contracts.ts, web/src/ContextUsage.tsx, AIPanel.tsx and styles.css.
- **FILE-003**: docs/validation/lake-context-usage.md and this plan.

## 6. Testing

- **TEST-001**: Repeated streamed usage events update one request without double counting; cache zero differs from cache unavailable; Anthropic cache input and Gemini totals normalize correctly.
- **TEST-002**: Snapshot survives persistence, separates current context from session total and updates after compaction/clear/rollback.
- **TEST-003**: Browser verifies panel open/close and unknown fields; signed build, Go race/vet and React checks pass.

## 7. Risks & Assumptions

- **RISK-001**: Local context budgeting is an estimate rather than the provider tokenizer; mark it explicitly.
- **ASSUMPTION-001**: Window limit is the configured Lake model context window; do not claim an automatically discovered provider limit.

## 8. Related Specifications / Further Reading

[Session permissions](feature-session-permissions-1.md)

[DeepSeek prompt caching](https://api-docs.deepseek.com/guides/kv_cache)
