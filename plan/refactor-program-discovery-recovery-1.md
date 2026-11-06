---
goal: Prevent program lookup failures from locking ordinary Lake execution
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'Completed'
tags: [fix, security, zcode, execution]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Classify literal program discovery as read-only and reconcile only verifiable historical discovery failures without changing original operation results or replaying commands.

## 1. Requirements & Constraints

- **REQ-001**: Recognize literal `command -v/-V NAME...`, including a chain with literal hostname inspection, as read-only. Preserve the target PATH when compiling discovery.
- **REQ-002**: A missing executable may fail discovery without introducing an unresolved mutation or blocking a later ordinary command.
- **SEC-001**: Historical reconciliation requires the exact original SDK Bash input, its args hash, command execution hash, task/session/resource/generation bindings, matching completed failure receipts, and a literal discovery-only grammar.
- **SEC-002**: Never reconcile arbitrary SQL, kubectl exec, dynamic code, redirection, incomplete/cancelled/timed-out executions, source mismatches or child calls through this compatibility path.
- **CON-001**: Preserve original operations, attempts, command executions, acceptance and permissions. Persist a separate host verification receipt; it grants no successful business evidence and never permits replay of the original call.
- **GUD-001**: Keep existing UI. Preserve explicit denies, confirmation preferences and current resource/version checks.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Implement literal discovery classification and verifiable effect reconciliation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Update web-agent/shared/command-policy.ts to recognize literal lookup arguments and compile PATH-preserving discovery without changing opaque CLI classification. | Yes | 2026-11-06 |
| TASK-002 | Add runtime/zcode/discovery-recovery.ts to verify original SDK parts and host receipts; use verified receipts in TaskLedger unresolved-effect checks and work_read projection. Depends on TASK-001. | Yes | 2026-11-06 |
| TASK-003 | Add classification and actual SDK execution regressions for missing programs, historical reconciliation, source tampering, unknown writes and original-call replay. Depends on TASK-002. | Yes | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Validate and deliver the fix without dropping the already installed resource feature.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Run frontend, runtime type/build/integration, ledger and Dev isolation checks; record exact results in docs/validation/zcode-typescript-candidate/program-discovery-recovery.md. Depends on TASK-003. | Yes | 2026-11-06 |
| TASK-005 | Build a clean local candidate combining this branch and resource PR 190, install signed Lake Dev, verify exact historical discovery reconciliation and unchanged canonical records without running business commands; open a develop PR. Depends on TASK-004. | Yes | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: Disabling unknown-operation checks is rejected because a failed arbitrary command can have partial effects.
- **ALT-002**: Rewriting the old failure as success or repeating it is rejected; retain history and record the host's narrow verification separately.

## 4. Dependencies

- **DEP-001**: Existing public SDK SessionStore, host command execution receipts, TaskLedger and Lake Security.
- **DEP-002**: PR 190 remains a separate unmerged resource feature; local integration validation preserves its already installed behavior without merging protected branches.

## 5. Files

- **FILE-001**: web-agent/shared/command-policy.ts and web-agent/web/test/command-policy.test.ts.
- **FILE-002**: runtime/zcode/discovery-recovery.ts, tasks.ts, superagent.ts and server.ts.
- **FILE-003**: Runtime regression tests and the matching validation record.

## 6. Testing

- **TEST-001**: PATH-only fixture executables are discoverable but never executed; missing lookup returns nonzero and later commands can continue.
- **TEST-002**: The exact historical lookup chain yields a durable receipt while original rows remain byte-identical; restart retains verification and original-call replay is refused.
- **TEST-003**: Altered input/hash/result/bindings, unknown writes, dynamic scripts, cancellation and opaque CLIs yield no verification receipt and no extra dispatch.
- **TEST-004**: The real SDK and SSH fixture continue ordinary work after a failed lookup while explicit permissions and dangerous-operation confirmation still apply.

## 7. Risks & Assumptions

- **RISK-001**: Shell inspection is not arbitrary-code proof. Compatibility recovery accepts only the narrow literal hostname/program-lookup grammar and complete host receipts; all other unknown effects remain unresolved.
- **ASSUMPTION-001**: User requests repairing the application, not re-running their comparison or synchronizing business data. All execution tests use isolated fixtures.

## 8. Related Specifications / Further Reading

- [Contribution workflow](../CONTRIBUTING.md)
- [Security ownership](../agent.md)
- [Conversation execution](../docs/validation/zcode-typescript-candidate/conversation-runtime.md)
- [Agent capabilities](../docs/validation/zcode-typescript-candidate/agent-capabilities.md)
- [Validation and installed candidate](../docs/validation/zcode-typescript-candidate/program-discovery-recovery.md)
