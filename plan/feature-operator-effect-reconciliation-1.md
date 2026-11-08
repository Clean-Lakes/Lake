---
goal: Add source-bound operator reconciliation for known SSH effects without replay or fabricated acceptance
version: 1
date_created: 2026-11-08
last_updated: 2026-11-08
owner: Lake
status: Completed
tags: [security, recovery, typescript, bug]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

The dual-cloud Ops exercise exposed a missing recovery path: an authorized service restart changed the remote machine, its SSH call was cancelled, and the new service remained alive. The original operation must remain unknown. An authenticated operator needs to record the independently checked effects and settle their risk before admitting new work. This is an explicit operator judgment, not a claim that arbitrary Shell is mechanically read-only or confined.

## 1. Requirements & Constraints

- **REQ-001**: Preserve the original operation, execution result, SDK tool input/output, attempt, goal acceptance and original background handle. Never replay the original operation or mark it successful through review.
- **REQ-002**: Require a real host-owned SSH Bash source, terminal command record, complete matching SDK provenance, original authenticated peer and unchanged current resource configuration. Live handles, unknown/imported provenance, children and unrelated evidence remain ineligible.
- **REQ-003**: Obtain successful bounded directory/file/process observations after the original execution ended, on the same authenticated peer and connection revision. Bind every selected original record, observation, declared effect, remaining process identity and operator acknowledgment by revision/hash.
- **REQ-004**: Separate recording observed effects from explicitly settling risk. A transport cancellation is not remote termination. The operator must state the actual effects, verify wrapper termination or a deliberate retained-process handoff, account for remaining work and explicitly acknowledge all affected objects. Unknown external effects keep the review open.
- **SEC-001**: Expose the decision only through the authenticated management API/UI, never through model tools, tool stdout, task prose, memory or work_finish. Record the QA tester as the acting operator; do not invent an additional user decision.
- **SEC-002**: Append immutable review and closure records. Check original/evidence content, source hashes, resource configuration, current permission and live-handle state before transactional publication. Reject stale revisions and replacement evidence; idempotent resubmission cannot overwrite a judgment.
- **SEC-003**: For observed changes, keep original canonical goal/source/shared-task mutations blocked and preserve known original command/cwd/scope replay protection. Related distinct work requires a separately admitted human request or a precisely routed and consumed followup after closure, under current normal permissions. An independently confirmed no-write judgment permits new operations on the original goal, matching existing no-write recovery; the original operation ID still cannot be replayed. Other unresolved operations remain blocking.
- **CON-001**: Use the existing Lake store, task ledger, SSH trust, operation API and shared frontend controls. Do not add test-RID/command allowlists, a second task ledger, an OS-sandbox claim or a production fallback.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Provide bounded, source-verifiable observations and define the operator review contract.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add a fixed directory-state profile in `runtime/typescript/ssh.ts` and a dedicated profile module. Use a clean system Python 2.7/3 environment as nobody, pin the private directory with O_NOFOLLOW and mount/inode checks, bound file hashing/metadata and matching process identities/listeners, and fail closed on incomplete observations. Return the actual authenticated SSH target with the result. No user-supplied program executes. | ✅ | 2026-11-08 |
| TASK-002 | Define `OperatorEffectReview` public types in `web-agent/shared/contracts.ts` and the source/evidence/hash contract in a new backend module. An observation supplements an operator judgment and cannot mechanically prove all effects of arbitrary Shell. | ✅ | 2026-11-08 |

### Implementation Phase 2

- **GOAL-002**: Publish append-only operator judgments and integrate their derived closure with existing replay protection. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Implement the dedicated review reader/confirmation in `runtime/typescript/operator-effect-review.ts`. Match exact original SDK Bash parameters and foreground/background source, terminal command record, original peer and current resource scope; accept only qualifying later observations; persist observed effects and an independently confirmed closure without rewriting the source. | ✅ | 2026-11-08 |
| TASK-004 | Wire the review through the existing authenticated session management API and `LakeSuperagent.effectResolution`; reuse `LakeExecution.hasLiveCommand`; update `TaskLedger.protectReconciledMutation` to consume the reviewed scope rather than require `removalReviewScope` for all closures. Keep existing narrow historical no-write reviews unchanged. | ✅ | 2026-11-08 |
| TASK-005 | Extend `web-agent/web/src/OperationReconciliation.tsx` with original output, bounded evidence, actual-effect notes, remote-process/accountability and separate closure confirmation. Use shared controls and communicate manual judgment accurately in both themes. | ✅ | 2026-11-08 |

### Implementation Phase 3

- **GOAL-003**: Validate safety and complete the real benchmark. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | Test altered SDK/source/peer/configuration/evidence, live calls, unrelated observations, stale revisions, original-goal replay, a new post-closure request, other unknown operations, retained processes and immutable source/acceptance. Run TypeScript, frontend, bundled service and boundary checks appropriate to the implementation. | ✅ | 2026-11-08 |
| TASK-007 | Sign and install Lake Dev from a clean commit with `scripts/build_lake_desktop.sh --dev --ts-candidate --install`; inspect real failed operations and the recorded review state in native light/dark/narrow layouts. Independently settle the QA effects, rerun failures from fresh authorized requests and finish both 19-case matrices, including S12 and cleanup. Record QA assistance separately. Completed with business execution at `7840fafa`, final CSS/build validation at `79550853`, 36 business passes plus 2 expected no-replay cases; all 13 new directories cleaned and all 28 registered paths independently absent. See the dual-cloud validation record for autonomous reruns and limits. | ✅ | 2026-11-08 |

## 3. Alternatives

- **ALT-001**: Clear unknown or mark the cancelled command successful. Rejected because it falsifies execution and can replay a partial write.
- **ALT-002**: Add another regex for the exercise restart script. Rejected because a test-specific exception does not implement general operator reconciliation.
- **ALT-003**: Treat TaskStop or SSH EOF as remote process termination. Rejected because the actual retained wrapper and service disprove that inference.

## 4. Dependencies

- **DEP-001**: Existing authenticated local management API, LakeStore transactions, SDK session source and resource/SSH key validation.
- **DEP-002**: Linux system Python 2.7 or 3, `/proc`, and the existing unprivileged observer account for the first bounded directory profile. Unsupported platforms keep an explicit unavailable state.

## 5. Files

- **FILE-001**: `runtime/typescript/operator-effect-review.ts` and tests: operator attestation, immutable source/evidence and closure derivation.
- **FILE-002**: `runtime/typescript/ssh.ts`, profile module/tests, `execution.ts`, `superagent.ts`, `tasks.ts`, `discovery-recovery.ts`, `server.ts`: observations, management wiring and original ledger/replay constraints.
- **FILE-003**: `web-agent/shared/contracts.ts`, `web-agent/web/src/OperationReconciliation.tsx` and relevant frontend tests: authenticated review contract and controls.
- **FILE-004**: `runtime/typescript/super-prompts.ts`, `docs/design/lake-security-v1.md`, `docs/validation/typescript-candidate/cloud-ops-2026-11-08.md`: service lifecycle guidance, actual recovery boundary and benchmark evidence.

## 6. Testing

- **TEST-001**: Genuine foreground failure and background cancellation each require terminal source, exact provenance, matching later peer and bounded evidence; altered/missing data rejects publication.
- **TEST-002**: Source operation/attempt/result/acceptance remain bytewise unchanged after observed review and closure; stale or duplicate decisions cannot alter them or selected evidence.
- **TEST-003**: Original goal/source/shared task and known replay remain rejected; new independent post-closure work retains normal approvals; another unknown operation still blocks conflicting writes.
- **TEST-004**: A live wrapper, unknown retained service, PID reuse, partial observations or unverified external effects cannot be silently called stopped or cleared.
- **TEST-005**: Real UK restart repair and both cloud matrices include independent process/file/network assertions, assistance attribution and final exact-scope cleanup.

## 7. Risks & Assumptions

- **RISK-001**: Arbitrary Shell may affect more than a directory. The observer does not establish a sandbox; only an informed authenticated operator may attest all actual effects. Unaccounted effects prevent closure.
- **RISK-002**: Process/file observations are time-bound. Report identities and timestamps, revalidate before publication, and never infer that a numeric PID still identifies the same process.
- **ASSUMPTION-001**: The user authorized the delegated QA operator to inspect and manage only the isolated exercise fixtures and to document each intervention; production assets and unrelated processes remain outside the test.

## 8. Related Specifications / Further Reading

- [Security closure and reconciliation](../docs/design/lake-security-v1.md)
- [Architecture ownership](../agent.md)
- [Contribution workflow](../CONTRIBUTING.md)
- [Dual-cloud evidence](../docs/validation/typescript-candidate/cloud-ops-2026-11-08.md)
