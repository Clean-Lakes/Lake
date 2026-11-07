---
goal: Repair the audited TypeScript Dev migration and restore observable product contracts
version: 1
date_created: 2026-11-07
last_updated: 2026-11-07
owner: Lake maintainers
status: In progress
tags: [migration, bug, runtime, memory, security]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In_progress-yellow)

Repair findings A01–A14 in the 2026-11-07 cutover audit. An implemented endpoint requires a valid response, persistent state where applicable, regression coverage and recorded validation. Unimplemented platform integrations remain explicit limitations and cannot pass the full-cutover gate.

## 1. Requirements & Constraints

- **REQ-001**: Preserve PR 197's model error and Pilot handoff fixes and the immutable audit in PR 198.
- **REQ-002**: Restore exact saved project MCP choices; prove native automatic memory publication and independent-session retrieval.
- **REQ-003**: Replace false successful API responses with implemented contracts or explicit errors; retain every unresolved audit item in the validation report.
- **SEC-001**: Preserve store/epoch identity, current project decisions, credential references, consent, revocation, unknown-operation fences and original execution history.
- **CON-001**: Use a topic branch, develop-targeted PR and signed Lake Dev installation. New PR merge requires explicit authorization.
- **GUD-001**: Apply docs/ui-guidelines.md to frontend changes; inspect light/dark and narrow layouts when visuals change.
- **PAT-001**: Reuse the existing SDK, LakeStore, operation ledger and native memory publisher; do not create competing authorities.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Fix lost MCP configuration, native memory extraction and dishonest HTTP contracts (A01, A02, A09).

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In runtime/typescript/migration.ts import verified legacy MCP inheritance and explicit bindings from the current security authority epoch, without overwriting TS choices; test absent, stale, denied and restart cases. | ✅ | 2026-11-07 |
| TASK-002 | In runtime/typescript/agent.ts scope acknowledgement instructions to the foreground memory stage; verify SDK extraction receives its own native protocol. In memory.ts preserve guarded publication and expose meaningful no-change results. Test a real durable preference, independent recall and forgetting. | No | — |
| TASK-003 | In runtime/typescript/server.ts constrain method/path dispatch, implement persisted presets and real model connection testing, and reject unknown session/resource actions instead of returning unrelated DTOs. Test malformed, unreachable, restart and deletion cases. | ✅ | 2026-11-07 |

### Implementation Phase 2

- **GOAL-002**: Restore message inputs and interaction controls after Phase 1 (A03–A05).

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | In runtime/typescript/server.ts, store.ts, agent.ts and superagent.ts carry structured resource IDs, mentions and attachment ownership into a frozen user message and task execution; use existing attachment size/hash/type contracts and reject cross-session references. | No | — |
| TASK-005 | Connect plans/mode/executePlan in server.ts and superagent.ts to the canonical frozen Goal plan, original live confirmation and transactional user-action receipt; reject stale, foreign and restarted confirmations. | No | — |
| TASK-013 | Implement persistent user queues with pause/resume/edit/remove/reorder, compare-and-swap revisions and dispatch-time reference validation in message-queue.ts; retain uncertain admissions without resubmitting them after restart. | No | — |
| TASK-014 | Connect queue push to the exact original SDK task/root supplement receipt; ambiguous or unsupported task targeting must retain the queued item and return an explicit error. | No | — |
| TASK-006 | Connect compact, rollback, clear and child cancellation through supported SDK APIs; preserve operation/approval history and return explicit unsupported capability errors for absent host ports. | No | — |

### Implementation Phase 3

- **GOAL-003**: Restore resource and legacy management contracts (A06–A08, A11, A13); depends on Phase 1.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Implement resource-tree parent validation, movement and navigation trash/restore in server.ts and store.ts; prevent cross-project parents, cycles and execution-owner deletion; test restart and restored hierarchy. | ✅ | 2026-11-07 |
| TASK-008 | Extend migration.ts and service-resources.ts to exact saved PostgreSQL and Redis configuration and private credential references; preserve TLS and later edits. Imported availability records saved configuration, not a successful live probe. | No | — |
| TASK-009 | Restore the saved workflow catalog with versioned CRUD and migration receipts; preserve templates without executing them or creating grants. Keep unavailable frozen workflow execution explicit. | No | — |

| TASK-015 | Restore Kubernetes and local workspace configuration with exact ownership and execution adapters; do not turn copied metadata into an executable connection. | No | — |
| TASK-016 | Restore frozen workflow runs, schedule eligibility, model reasoning controls and legacy read-only evidence/export APIs through their existing authorities. | No | — |

### Implementation Phase 4

- **GOAL-004**: Validate recovery and integrated Dev without treating optional or unavailable ports as delivered (A10, A12, A14); depends on preceding phases.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | Exercise security recovery, unknown-operation reconciliation, watchdog owner leases and queued dispatch eligibility through runtime tests; change only proven defects in the existing authorities. | No | — |
| TASK-011 | Update runtime/typescript/README.md and validation evidence with actual host-port/CLI/platform capabilities and every unfinished audit requirement; keep full-cutover gate closed until parity evidence exists. | No | — |
| TASK-012 | Run source/server/frontend regressions and boundary checks, commit source, verify idle Dev, run scripts/build_lake_desktop.sh --dev --ts-candidate --install, inspect native Dev and record tested SHA. Open a PR against develop with the exact remaining limits. | No | — |

## 3. Alternatives

- **ALT-001**: Enabling all MCP servers or weakening approval rules would mask migration loss and broaden permissions; rejected.
- **ALT-002**: Replacing SDK memory extraction with a second summarizer would violate the existing single-publisher architecture; rejected.

## 4. Dependencies

- **DEP-001**: SDK v3.17.2 source under third_party/agent-sdk supplies the native runtime and memory protocol.
- **DEP-002**: Current signed Dev source and the existing private Dev security authority provide the migration baseline; production data is excluded.

## 5. Files

- **FILE-001**: runtime/typescript/{migration,extensions,security}.ts and regression tests own configuration admission.
- **FILE-002**: runtime/typescript/{agent,memory}.ts and regression tests own native extraction and publication.
- **FILE-003**: runtime/typescript/{server,store,superagent,service-resources}.ts and tests own HTTP/product contracts and task integration.
- **FILE-004**: docs/validation/typescript-candidate/cutover-repair-2026-11-07.md records completed validation and unresolved work.

## 6. Testing

- **TEST-001**: Unit and isolated server tests cover exact migration, native extraction stages, durable memory publication, invalid routes, real connectivity and state after restart.
- **TEST-002**: Existing runtime/frontend suites and naming/ADK boundary checks remain passing; no external business command is replayed by QA.
- **TEST-003**: Signed Dev validation records app source SHA, credentials remaining private, original data preservation and actual knowledge-service discovery.

## 7. Risks & Assumptions

- **RISK-001**: Legacy security data may be stale or inconsistent; reject ambiguous authority and record the reason without changing authorization.
- **RISK-002**: Native memory may legitimately choose no change; completed model calls alone cannot establish successful durable extraction.
- **RISK-003**: Full workflow, terminal and non-macOS parity requires distinct platform/service evidence; a capability label cannot substitute for implementation.
- **ASSUMPTION-001**: The user authorizes local fixes, tests, Dev installation and a reviewable develop PR; new protected-branch merges remain unapproved.

## 8. Related Specifications / Further Reading

- [Cutover audit](../docs/validation/typescript-candidate/cutover-audit-2026-11-07.md)
- [Architecture ownership](../agent.md)
- [Task confirmation and recovery](../docs/security/task-confirmation.md)
- [Development workflow](../docs/development-workflow.md)
- [Existing full migration plan](refactor-typescript-backend-1.md)
