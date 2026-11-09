---
goal: Keep bounded log diagnostics available after SSH failure without replaying uncertain mutations
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake maintainers
status: 'Completed'
tags: [ssh, security, recovery, diagnostics]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

The reported reboot investigation was blocked because date -Is, last and journalctl queries fell into the opaque/write category, and a connection failure before command dispatch became unknown. Implement precise read classification and positive host dispatch evidence, retaining original failed/unknown records and all current resource permissions.

## 1. Requirements & Constraints

- **REQ-001**: Recognize literal date ISO display, last reboot listings and bounded journalctl query options; reject setting time, journal mutations, paging, unknown flags and dynamic shell execution as read-only evidence.
- **REQ-002**: Persist SSH dispatch phases before invoking the transport exec method. A terminal failure positively recorded before exec is a failed/not-sent observation, not unknown effects.
- **SEC-001**: Once exec is requested, transport loss remains uncertain for opaque/mutating commands. Model output cannot supply dispatch proof. Current identity, resource revision, policy, deadlines and cancellation remain enforced.
- **SEC-002**: Missing historical dispatch evidence is not proof of no execution. Preserve old records and allow separately permitted, newly classified read-only diagnostics without accepting unresolved work.
- **CON-001**: Continue the open resource-execution fix PR #206 on its clean topic branch, originally based on current origin/develop. Do not merge or publish without corresponding authorization. Use isolated fixtures and signed Lake Dev only.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Correct classification and command dispatch accounting.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-001 | Add literal parameter validators in web-agent/shared/command-policy.ts for date ISO display, last reboot listings and journalctl queries; add positive and mutation/pager/unknown-flag negatives in web-agent/web/test/command-policy.test.ts. | Yes | 2026-11-09 |
| TASK-002 | Add durable SSH dispatch phase to CommandRecord in runtime/typescript/execution.ts, initialize not_sent, persist exec_requested before connection.exec and channel_open only after successful callback. | Yes | 2026-11-09 |
| TASK-003 | Extend exact command binding checks in runtime/typescript/tasks.ts to recognize positive not-sent terminal failures while keeping operation IDs immutable and already-issued commands unknown. Settle proven no-effect failed attempts before a fresh attempt. Depends on TASK-002. | Yes | 2026-11-09 |

### Implementation Phase 2

- **GOAL-002**: Validate recovery and document the delivered boundary.

| Task | Description | Completed | Date |
| --- | --- | --- | --- |
| TASK-004 | Test connection rejection, cancellation before send, exec-request transport loss, background settlement, restart/missing phases and fresh read-only continuation against exact host and operation bindings. Add real SDK/loopback SSH recovery coverage in server.test.cjs. Depends on TASK-001 through TASK-003. | Yes | 2026-11-09 |
| TASK-005 | Run TS/frontend checks, runtime suites, ADK boundary and signed Dev build; record tested functional SHA, actual native Dev observations and remaining historical limitations. Depends on TASK-004. | Yes | 2026-11-09 |
| TASK-006 | Update agent.md, relevant security/Pilot documentation, validation notes and PR #206 with final scope and evidence. Depends on TASK-005. | Yes | 2026-11-09 |

## 3. Alternatives

- **ALT-001**: Removing unknown protection is rejected because commands may have already changed remote state.
- **ALT-002**: Treating any spawn_error or missing exit code as not executed is rejected; transport failures after exec may have side effects.
- **ALT-003**: Retrospectively rewriting old unknown records from command text is rejected; old calls lack the new host dispatch proof and were not necessarily compiled under the current policy.

## 4. Dependencies

- **DEP-001**: Existing command policy, bound ExecutionPort, LakeSSH, canonical TaskLedger and SDK sessions; no new service or parallel ledger.

## 5. Files

- **FILE-001**: web-agent/shared/command-policy.ts and web-agent/web/test/command-policy.test.ts.
- **FILE-002**: runtime/typescript/execution.ts, tasks.ts, execution-dispatch.test.ts and server.test.cjs.
- **FILE-003**: agent.md, docs/security/task-confirmation.md and docs/validation/typescript-candidate/ssh-readonly-recovery-2026-11-09.md.

## 6. Testing

- **TEST-001**: Screenshot query chain compiles as read-only; time setting, journal maintenance, pager execution, unknown flags and shell substitution do not.
- **TEST-002**: Proven pre-send failure permits a new authorized invocation, never replay of the original call ID; post-request loss remains unknown even without output or an opened channel.
- **TEST-003**: An original unknown mutation still blocks writes and completion while a new bounded journal query succeeds. Reopening preserves both original records and dispatch proof.

## 7. Risks & Assumptions

- **RISK-001**: journalctl supports state-changing options; the query validator must use a closed parameter set rather than a program-name allowlist.
- **RISK-002**: A persisted exec_requested phase may precede actual transport transmission if the host crashes; conservative unknown is intentional.
- **ASSUMPTION-001**: The requested fix changes future recovery accounting, not authorization to execute real reboot investigations or automatically reconcile historical unknowns.

## 8. Related Specifications / Further Reading

[Architecture](../agent.md), [task confirmation](../docs/security/task-confirmation.md), [Security](../docs/design/lake-security-v1.md), [workflow](../docs/development-workflow.md).

Verification: [signed Dev and recovery results](../docs/validation/typescript-candidate/ssh-readonly-recovery-2026-11-09.md), tested functional SHA `21cf5990de41de998d817811a95029d14da6ed24`. Delivered through open PR #206 to develop; merge and production release are outside this task.
