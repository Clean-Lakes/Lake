---
goal: Restore normal startup for a finalized foundation-only initial migration with a closed startup gate
version: 1.0
date_created: 2026-11-04
last_updated: 2026-11-04
owner: Lake maintainers
status: Completed
tags: [security, recovery, compatibility]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

The affected Home is initialized, has a valid format-2 finalization receipt, retains all 133 original operations including five unknown outcomes, and contains only the foundation Security schema. Version 0.3.26 restores read-only navigation but provides no supported operation for resuming this already-finalized initial adoption. The original gate-closing failure was not logged; the banner alone does not establish that cause. This plan adds a narrow host maintenance operation; it does not add a general gate-open API or claim that a historical unknown outcome has been reconciled.

## 1. Requirements & Constraints

- **REQ-001**: Add `lake security recover-finalized-startup --home PATH`; default invocation previews without changing files. Applying requires both `--apply` and the exact `--expected-digest` returned by preview.
- **REQ-002**: Accept only gate-closed, StoreReady, non-restored Homes with a verified finalized single-canonical initial inventory, foundation reader 1, no domain Security/Super-agent tables, no goals, and no active legacy Web execution or queued messages.
- **SEC-001**: Verify original operation proofs, exact receipt operation coverage, current outcome/handle digest, current control identity and absence of pending migration/restore or independent stores. Keep unknown outcomes and all existing permissions unchanged.
- **SEC-002**: Applying requires exclusive Home/root/Web ownership, a durable private authorization record, fresh digest verification and an atomic final control write. No model, Engine, terminal, background worker or resource command may run in maintenance.
- **SEC-003**: Reject actual restore/recovery Homes, initialized domain runtime, active work, tampering, stale digests and source changes; never remove records, recreate deleted archives or write database rows to pass preflight.
- **CON-001**: Follow CONTRIBUTING.md and docs/development-workflow.md. Use a branch from origin/develop, a develop PR and explicit corresponding merge authorization. Production maintenance and restart require explicit approval of a concrete preview.
- **CON-002**: Build any user-facing maintenance binary with scripts/build_lake.sh. Isolated validation never uses production secrets or dispatches production host operations.
- **PAT-001**: Reuse finalization receipt/proof verification, private JSON persistence, existing offline owner locks and the original replay guard.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Establish the exact supported recovery profile and reproduce its current rejection.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Read the contribution, agent ownership and recovery specifications; inspect the live Home only through metadata/read-only requests; record closed gate, valid finalization and foundation-only schema. | ✅ | 2026-11-04 |
| TASK-002 | Add synthetic finalized-foundation fixtures and a regression proving that normal startup and resume-initial-migration both reject the closed finalized Home before this change. Depends on TASK-001. | ✅ | 2026-11-04 |

### Implementation Phase 2

- **GOAL-002**: Implement and validate the scoped host recovery operation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Implement internal/ai/security_finalized_startup.go with deterministic preview/digest, foundation-only checks, exclusive apply, durable actor record, precommit revalidation and atomic gate transition; never change a DB. Depends on TASK-002. | ✅ | 2026-11-04 |
| TASK-004 | Wire CLI parsing/help in cmd/lake and add missing Home, apply-without-digest and preview validation tests. Document the exact supported profile in docs/security/checkpoint-and-recovery.md. Depends on TASK-003. | ✅ | 2026-11-04 |
| TASK-005 | Cover read-only preview, unchanged files, stale/tampered inputs, restored/enforced/active Homes, journal interruption/reentry, owner contention, fresh work admission and old-call replay refusal. Run race/vet and boundary checks. Depends on TASK-004. | ✅ | 2026-11-04 |

### Implementation Phase 3

- **GOAL-003**: Prepare a reviewable production recovery and verify the whole normal runtime.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Build the signed CLI and validate a private representative Home through recovery, normal Web/Engine startup, restart, Pilot activation and loopback-model conversation. Keep production data unchanged. Depends on TASK-005. | ✅ | 2026-11-04 |
| TASK-007 | Create the develop PR with tested SHA and concrete live read-only preview. Obtain explicit merge and production-maintenance/restart authorization before applying its digest. Depends on TASK-006. | ✅ | 2026-11-04 |
| TASK-008 | Under authorized offline ownership verify the existing current paired checkpoint, apply the exact reviewed digest, reopen the installed stable client and verify normal bootstrap, Pilot, history/resources and preservation of all five unknown operations. Record remaining limitations accurately. Depends on TASK-007. | ✅ | 2026-11-04 |

PR #153 was explicitly authorized and merged at `26a60dce44cf8c491be99e336c8704b647a0c4bf`; its tree matches tested source `5a1f26894d64c160f4b8e64e2479ee8e132fa712`. After separately authorized maintenance and restart, installed stable 0.3.26 loaded normal Pilot, 134 resources and nine legacy snapshots; the configured model actually replied through the native client. All 133 original operation rows remained unchanged, including five unknown outcomes; no resource command or new task was executed. The paired checkpoint and private control audit were retained. Actual restored/enforced Homes remain outside this command's profile.

## 3. Alternatives

- **ALT-001**: Editing control.json or removing recovery records is rejected because it has no bound validation or audit and could bypass an actual restore.
- **ALT-002**: Continuing to show only read-only history is rejected because it does not restore the user's normal client.
- **ALT-003**: Generalizing the existing unfinished initial-migration command is rejected; its existing StoreReady=false contract remains unchanged.

## 4. Dependencies

- **DEP-001**: Current verifyLegacyFinalization, legacyOperationProofs, privateSecurityRead/writeSecurityJSON and exclusive owner primitives.
- **DEP-002**: Existing signed build identity and a complete private paired checkpoint before production maintenance.

## 5. Files

- **FILE-001**: internal/ai/security_finalized_startup.go and security_finalized_startup_test.go: preview, apply, audit and boundary/replay tests.
- **FILE-002**: cmd/lake/main.go and security_recovery_test.go: explicit host CLI routing and argument tests.
- **FILE-003**: docs/security/checkpoint-and-recovery.md: scoped finalized-startup recovery contract.
- **FILE-004**: This implementation plan and the PR validation record.

## 6. Testing

- **TEST-001**: Preview returns a stable digest and leaves control, both databases, receipt and historical rows unchanged.
- **TEST-002**: Closed finalized foundation Home can resume and restart normally; old unknown operations retain original status/result/identity and regenerated old calls remain refused.
- **TEST-003**: Reject missing/mismatched receipts, changed operation states, extra operations, domain tables, reader upgrades, backup recovery, active work, queued input and unavailable ownership without opening the gate.
- **TEST-004**: A fault after durable authorization leaves the gate closed; reentry with the same digest succeeds, a different digest fails; already-applied replay is a verified no-op.
- **TEST-005**: Signed isolated Web validation loads Pilot and can answer via a loopback fixture without any production provider or resource operation.

## 7. Risks & Assumptions

- **RISK-001**: Gate closure reason was not persisted by the old startup path. Eligibility is therefore restricted to the complete finalized foundation profile plus a new explicit operator decision; it is never inferred from a banner or version number.
- **RISK-002**: Normal startup performs its existing schema upgrades. Isolated full-runtime and restart validation is required before applying the production action.
- **ASSUMPTION-001**: A valid initial-adoption policy preserving unresolved outcomes remains applicable to fresh work; the recovery command never supplies approval for a new resource operation.

## 8. Related Specifications / Further Reading

- [Contribution workflow](../CONTRIBUTING.md)
- [Development workflow](../docs/development-workflow.md)
- [Module ownership](../agent.md)
- [Checkpoint and recovery](../docs/security/checkpoint-and-recovery.md)
- [Finalization implementation](../internal/ai/security_migration_finalize.go)
