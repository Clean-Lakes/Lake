---
goal: Preserve task context across independent specialist Workers
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'Completed'
tags: [feature, context, memory, zcode]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

New specialist tasks receive a bounded, sourced working set and a scoped history lookup. They retain independent SDK sessions and current execution permissions.

## 1. Requirements & Constraints

- **REQ-001**: Supply recent same-project, exact-RoleID task summaries, human clarifications, report references and resource clues to new Workers.
- **REQ-002**: Provide read-only lookup of older task context; resolve known references before asking users to repeat information.
- **SEC-001**: History never imports approvals, acceptance, current health or unresolved-operation clearance. Do not execute the user's database synchronization during verification.
- **SEC-002**: Revalidate withdrawn knowledge and dependent context on actual provider/tool use; retain canonical source records.
- **CON-001**: Use existing canonical task records and the existing Lake Memory publisher; do not create another long-term knowledge store or share SDK transcripts.
- **GUD-001**: Follow CONTRIBUTING.md, docs/development-workflow.md and agent.md; update the existing develop PR without merging.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Connect scoped contextual recall to task assignment and provider requests.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add runtime/zcode/task-context.ts for bounded canonical same-role task context and exact lookup. | Yes | 2026-11-06 |
| TASK-002 | Integrate assignment/provider context and recall_task_context into runtime/zcode/superagent.ts and super-prompts.ts. Depends on TASK-001. | Yes | 2026-11-06 |
| TASK-003 | Extend runtime/zcode/memory.ts continuation provenance to filter withdrawn contextual dependencies. Depends on TASK-001. | Yes | 2026-11-06 |
| TASK-006 | Add the optional pinned Claude-Mem local index, recall_memory, managed lifecycle, authenticated HTTP boundary and index forgetting. Depends on TASK-003. | Yes | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Validate semantic continuity, isolation and unchanged execution authority.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add lifecycle, memory and real SDK protocol regression cases for a fresh task reusing earlier entrance/instance clues. Depends on TASK-002, TASK-003 and TASK-006. | Yes | 2026-11-06 |
| TASK-005 | Run local checks, install signed idle Lake Dev, record SHA and update PR 188. Depends on TASK-004. | Yes | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: Sharing the previous SDK transcript is rejected because task contexts and execution authority must remain independent.
- **ALT-002**: Automatically promoting unfinished tasks to successful long-term memory is rejected; historical context can remain useful without acceptance.

## 4. Dependencies

- **DEP-001**: Existing task/input/report/operation records, host provider projection and Lake Memory read provenance.

## 5. Files

- **FILE-001**: runtime/zcode/task-context.ts owns the ephemeral working-set projection.
- **FILE-002**: runtime/zcode/superagent.ts and runtime/zcode/super-prompts.ts connect dispatch and recall.
- **FILE-003**: runtime/zcode/memory.ts, memory.test.ts, superagent-lifecycle.test.ts and server.test.cjs verify recall and forgetting.

## 6. Testing

- **TEST-001**: New comparison-to-sync fixture retains source entrance and instance without sharing session IDs, receipts or acceptance.
- **TEST-002**: Reject cross-project/role reads, stale revisions/hashes and invalid pagination; enforce UTF-8 byte budgets.
- **TEST-003**: Forgetting a contextual source fences dependent provider/tool continuation without changing original tasks or operations.

## 7. Risks & Assumptions

- **RISK-001**: Old observations may be stale; every historical entry identifies provenance, outcome and unresolved operations and requires current resource checks.
- **ASSUMPTION-001**: This fixes short-term task continuity even when long-term extraction has produced no durable notes; long-term memory switches retain their established semantics.

## 8. Related Specifications / Further Reading

- [Architecture](../agent.md)
- [Context contract](../docs/design/context-role-memory-contract.md)
- [Layered Memory](../docs/design/zcode-layered-memory.md)
- [Validation and installed SHA](../docs/validation/zcode-typescript-candidate/task-memory-recall.md)
