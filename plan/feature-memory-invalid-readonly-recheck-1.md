---
goal: Recover fresh read-only diagnostics when an old Worker context has invalid memory, and report the real blocker
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake maintainers
status: 'Completed'
tags: [memory, recovery, tasks, reporting]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

The reported old reboot task failed before any new tool call because its prior memory dependency became unavailable. A generic unresolved-operation notice hid that error. Preserve the old context and execution ledger; a newly admitted human followup can instead receive an independent, tightly scoped read-only recheck by the same specialist in a fresh SDK Session.

## 1. Requirements & Constraints

- **REQ-001**: Report invalid-memory failures accurately even when an older unknown operation also exists. Project only proven host-generated legacy notices; never rewrite stored reports or model prose.
- **REQ-002**: For a fresh human followup to a nonterminal ordinary specialist task with invalid memory, automatically create one independent read-only recheck using the same RoleID, original explicit resource scope and original deadline. Preserve old Task/Worker/Session/attempts/operations.
- **SEC-001**: Do not clear memory provenance, revive unavailable knowledge, reuse the old SDK transcript, copy old task-context summaries or replay previous operations. New context starts from actual human requirements and current resource metadata.
- **SEC-002**: Enforce read-only recovery in TaskLedger for every business operation and temporary child. Missing scope, explicit original plan, expired/closed task and role mismatch cannot use this recovery. Current project permissions remain enforced.
- **CON-001**: The new recheck's receipt never closes or accepts its source task; no production host access or historical ledger mutation. Continue open PR #206 without merging or publishing.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Add precise detection, fresh bounded recovery and accurate reporting.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | Expose a read-only LakeMemory continuation-needs-fresh-context predicate in runtime/typescript/memory.ts; keep validateContinuation and old read provenance intact. | Yes | 2026-11-09 |
| TASK-002 | In superagent.ts route(followup), create an idempotent independent read-only Worker for eligible invalid-memory contexts; copy only original human requirement, exact target IDs and deadline. Omit task-context recall in the recheck and explain its relation in the trusted assignment. Depends on TASK-001. | Yes | 2026-11-09 |
| TASK-003 | Add canonical readOnlyRecoveryOf metadata to Goal and enforce it before TaskLedger.operation dispatch; reject opaque/write operations regardless of normal permission switches. Depends on TASK-002. | Yes | 2026-11-09 |
| TASK-004 | Prioritize actual memory-context failure in new reportPresentation and project exact old generic notices only with matching report ID, worker, root turn and host error card. Original stored messages stay immutable. | Yes | 2026-11-09 |

### Implementation Phase 2

- **GOAL-002**: Verify the actual old-context failure path and deliver a reviewable fix.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-005 | Add lifecycle, ledger and real SDK regressions with a used memory source invalidated before a fresh human followup, including an original unknown operation. Assert fresh Session, same role, bounded scope/deadline, no stale knowledge in provider requests, read success, mutation rejection and unchanged source records. Depends on TASK-001 through TASK-004. | Yes | 2026-11-09 |
| TASK-006 | Run pinned TS/runtime regressions, boundary check and signed Lake Dev validation using isolated QA data; update design/validation notes and PR #206 with exact tested SHA and remaining limitations. Depends on TASK-005. | Yes | 2026-11-09 |

## 3. Alternatives

- **ALT-001**: Clearing memoryReads or reusing the old Session is rejected because the old transcript and native state can contain invalid knowledge.
- **ALT-002**: Removing unknown/permission protection or replacing old acceptance is rejected.
- **ALT-003**: Silently retrying arbitrary changes in a new context is rejected; this recovery is an independent read-only diagnostic only.

## 4. Dependencies

- **DEP-001**: Existing LakeMemory source validation, admitted human input, stable role routing, independent SDK Sessions and canonical TaskLedger.

## 5. Files

- **FILE-001**: runtime/typescript/memory.ts, memory-errors.ts, superagent.ts, tasks.ts and their tests.
- **FILE-002**: runtime/typescript/task-cancellation.ts or a dedicated report projection module plus tests.
- **FILE-003**: agent.md, docs/design/typescript-layered-memory.md and docs/validation/typescript-candidate/memory-invalid-recheck-2026-11-09.md.

## 6. Testing

- **TEST-001**: New followup creates exactly one fresh scoped read-only diagnostic; duplicate event/part retries reuse its original receipt.
- **TEST-002**: Revoked knowledge, old transcript, prior task summaries, Todo state and operation replay handles do not enter the new context; original records and memoryReads remain unchanged.
- **TEST-003**: Real cause replaces only a proven host generic notice; unknown mutations still block, current reads succeed, source task acceptance remains unchanged.

## 7. Risks & Assumptions

- **RISK-001**: Generic notices may be user/model text; projection requires positive host report/error identities.
- **RISK-002**: A new Task must not become a way to extend deadlines, widen resources or replay writes. Canonical recovery metadata and tests enforce those boundaries.
- **ASSUMPTION-001**: A new admitted human followup requests a recheck within the original explicit target scope. No automatic restart occurs solely due to an upgrade or memory state change.

## 8. Related Specifications / Further Reading

[Architecture](../agent.md), [Memory](../docs/design/typescript-layered-memory.md), [Security](../docs/security/task-confirmation.md), [previous SSH fix](refactor-ssh-readonly-recovery-1.md).

Verified implementation: `7873b3b7b7160a2494d3210343859de3b837aba3`. Evidence: [validation](../docs/validation/typescript-candidate/memory-invalid-recheck-2026-11-09.md).
