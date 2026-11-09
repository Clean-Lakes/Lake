---
goal: Default Pilot resource work to specialist delegation and close verified direct tasks correctly
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake maintainers
status: 'In progress'
tags: [pilot, routing, tasks, acceptance]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The 0.3.28 production diagnostic showed an inline Pilot SSH task and no specialist routing calls. Its SSH operation succeeded; manual work_update accepted the step, then work_finish incorrectly required a running step and left the goal paused. Fix default coordination and task closure while preserving shared Agent capability and all original execution authorities.

## 1. Requirements & Constraints

- **REQ-001**: Resource I/O defaults to an existing suitable specialist or a newly created stable role, including a short check and an empty specialist catalog. Pure conversation and explaining existing results remain direct.
- **REQ-002**: Pilot retains general-purpose tools for an explicit request to execute personally; native children do not replace persistent specialist delegation by default. Coordination policy is not a permission grant or a language-keyword classifier.
- **REQ-003**: Ordinary host-managed Pilot tasks expose the host-managed result protocol. Explicit Plan and frozen manual acceptance contracts remain intact.
- **SEC-001**: Completing an already accepted step requires its actual successful business receipts, accurate identities/revisions, current generation/policy and current resource checks; failed, unknown, stale or unrelated evidence cannot complete work.
- **CON-001**: Do not mutate or replay the diagnosed production task. Use isolated tests and Lake Dev; create an ordinary PR to develop without assuming new production-release authorization.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Implement the coordination default and correct host-owned completion.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Update superRouterPrompt in runtime/typescript/super-prompts.ts and the bounded request context in router-context.ts to state default resource delegation, role reuse/creation and the explicit direct-work exception. | Yes | 2026-11-09 |
| TASK-002 | Derive host-managed tools from the effective goal/mode in superagent.ts, omitting manual step tools for ordinary inline work while retaining explicit-plan controls. | Yes | 2026-11-09 |
| TASK-003 | Extend TaskLedger.finishHost in tasks.ts to finalize already accepted current steps through original receipt verification without starting a new attempt or dispatching tools. | Yes | 2026-11-09 |

### Implementation Phase 2

- **GOAL-002**: Verify behavior, document boundaries and prepare a reviewable fix.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add ledger regressions for accepted steps, stale generation/policy, tampered evidence and discovery-only results; add SDK routing/default-context and explicit direct-capability cases. Depends on TASK-001 through TASK-003. | Yes | 2026-11-09 |
| TASK-005 | Run pinned TS typecheck, source/runtime suites and appropriate signed Lake Dev validation; record exact SHA and conditional skips without contacting production resources. Depends on TASK-004. | Yes | 2026-11-09 |
| TASK-006 | Update agent.md, docs/lake-pilot.md and validation notes; commit and open a topic PR to develop with actual verification and current limitations. Depends on TASK-005. | No | 2026-11-09 |

## 3. Alternatives

- **ALT-001**: Removing Pilot tools is rejected because roles share complete Agent capabilities.
- **ALT-002**: Hard-coded keyword detection or new mandatory UI modes for ordinary delegation is rejected; the model applies the coordination policy to the admitted request, while the host preserves permissions and identities.
- **ALT-003**: Marking prose as completion, replaying the old SSH call or rewriting production history is rejected.

## 4. Dependencies

- **DEP-001**: Existing role catalog, route_work, independent Workers, task ledger and signed TS runtime.

## 5. Files

- **FILE-001**: runtime/typescript/super-prompts.ts, router-context.ts and superagent.ts.
- **FILE-002**: runtime/typescript/tasks.ts, tasks.test.ts and server.test.cjs plus bounded-context tests.
- **FILE-003**: agent.md, docs/lake-pilot.md and docs/validation/typescript-candidate/pilot-delegation-2026-11-09.md.

## 6. Testing

- **TEST-001**: Real SDK routing creates one specialist when none exists, reuses a suitable stable role and preserves a separate execution Session; explicit Pilot execution remains capable.
- **TEST-002**: Accepted-step completion uses current real business evidence once; rejects stale/foreign/tampered/unknown evidence and discovery-only observations.
- **TEST-003**: Ordinary inline tools omit manual step bookkeeping; explicit plans, permission revocation, resource revision changes and context budget remain enforced.

## 7. Risks & Assumptions

- **RISK-001**: Delegation is a model coordination policy, not a security boundary; fixture requests alone cannot prove real-model adherence. Record actual Dev validation separately.
- **ASSUMPTION-001**: The user requests the default delegation change without revoking Pilot's previously authorized complete capability.

## 8. Related Specifications / Further Reading

[Architecture ownership](../agent.md), [task confirmation](../docs/security/task-confirmation.md), [Pilot contracts](../docs/lake-pilot.md), [contribution workflow](../CONTRIBUTING.md).

Verification: [2026-11-09 validation](../docs/validation/typescript-candidate/pilot-delegation-2026-11-09.md), tested functional commit `83c77a3b4282c91bccc633d80b25ee68201b5f3e`. PR preparation remains until TASK-006 is recorded.
