---
goal: Retire TypeScript task reconciliation and acceptance gates in favor of submitted reports
version: 1
date_created: 2026-11-12
last_updated: 2026-11-12
owner: Lake
status: 'Completed'
tags: [refactor, tasks, typescript, acp]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

The user explicitly requested removal of both the specialist status UI and backend pending-result/acceptance mechanism. A submitted report ends an execution; it is not an independent business verification. Historical operations and acceptance records remain unchanged.

## 1. Requirements & Constraints

- **REQ-001**: Remove task status badges, status filters/groups and acceptance verdicts from specialist pages. List every task by original assignment time and retain exact Worker/session/task navigation.
- **REQ-002**: `TaskLedger.finishHost` and `finish` record completed or partial reports without requiring successful operations, evidence acceptance or reconciliation. Neither method writes `superAcceptance`.
- **REQ-003**: New operations do not depend on historical unknown/dispatched results, project/MCP reconciliation locks or acceptance. Reusing an original operation call ID never repeats I/O.
- **REQ-004**: Shared tasks aggregate submitted member reports without a unified acceptance receipt or acceptance announcement. Partial reports remain explicitly partial in recorded report metadata.
- **SEC-001**: Preserve current project/resource permissions, explicit deny, connection revisions, Pilot approval preferences, confirmed Plan mode, task owner/generation/deadline, cancellation, live child/background joins, credential isolation and Memory consent/source checks.
- **CON-001**: Keep historical operation/attempt/acceptance data unchanged. Compatibility acceptance fields are not new pass decisions. Do not mass-rewrite old blocked goals, repeat old operations, create complete Home backups or touch production.
- **PAT-001**: Use existing report outboxes, SDK tools and signed Lake Dev build; do not introduce a second model loop, execution runtime or verification service.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Retire result gates and retain actual execution ownership.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In `runtime/typescript/tasks.ts`, replace step/goal acceptance creation and `verifySteps` with durable report submission; remove mutation reconciliation locks; retain exact call identity and active attempt binding checks. | ✅ | 2026-11-12 |
| TASK-002 | In `runtime/typescript/joint-tasks.ts` and `superagent.ts`, derive member submission/aggregate completion from reports; remove acceptance/unknown requirements from scheduling, followup, stopping and result delivery. Depends on TASK-001. | ✅ | 2026-11-12 |
| TASK-003 | In `runtime/typescript/security.ts`, remove the historical MCP pending-operation gate; in `server.ts` retire reconciliation writes with HTTP 410; in `super-prompts.ts`, `agent.ts` and `final-report.ts` remove acceptance instructions. Preserve current authorization and report requirements. Depends on TASK-001. | ✅ | 2026-11-12 |
| TASK-004 | In `runtime/typescript/memory.ts`, `task-context.ts` and `router-context.ts`, distinguish submitted reports from historical accepted results. Memory may capture only original settled operation observations under existing consent and source checks; unknown is never promoted to successful experience. Depends on TASK-002. | ✅ | 2026-11-12 |

### Implementation Phase 2

- **GOAL-002**: Deliver the simplified task view with regression and Dev evidence. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Update `SpecialistTaskList.tsx`, `specialistTaskListModel.ts`, `specialistTaskList.css`, `SpecialistChannel.tsx`, `SessionInspector.tsx`, `SuperTaskInspector.tsx` and shared task presentation: flat chronological task records, title-only task selector, no acceptance verdict UI or reconciliation forms. | ✅ | 2026-11-12 |
| TASK-006 | Adapt affected runtime and frontend regressions to the new report contract. Verify unknown/failed history remains unchanged, new calls proceed, stale ownership/permissions still reject, partial/shared reports deliver once and old reconciliation writes return 410. Depends on TASK-001 through TASK-005. | ✅ | 2026-11-12 |
| TASK-007 | Update `agent.md`, task/security/UI specifications and compatibility evidence. Run type/build, runtime/host/ACP and frontend suites plus boundary/naming checks; inspect fixture light/dark/narrow layouts. Depends on TASK-006. | ✅ | 2026-11-12 |
| TASK-008 | Capture a fresh private hash baseline, normally stop Lake Dev, sign/build/install with `scripts/build_lake_desktop.sh --dev --install`, verify exact clean source SHA/signatures/provenance, inspect actual task results and compare original records. Update draft PR #222 targeting develop without merging. Depends on TASK-007. | ✅ | 2026-11-12 |

## 3. Alternatives

- **ALT-001**: Hiding labels alone leaves backend completion blocked; the user explicitly rejected this scope.
- **ALT-002**: Marking old unknown operations or acceptance records successful would falsify execution history; retain them as original observations instead.

## 4. Dependencies

- **DEP-001**: Existing `superDeliveries`, report outboxes, original SDK/ACP execution owners, current permission checks and original per-call operation identities.
- **DEP-002**: Node 24.14.0, pinned SDK/ACP runtime, persistent local signing identity and isolated Lake Dev installation.

## 5. Files

- **FILE-001**: Runtime task ledger, shared tasks, SuperAgent orchestration, security, report prompts, contextual and Memory adapters listed in TASK-001 through TASK-004.
- **FILE-002**: Specialist/task result components and corresponding regression fixtures listed in TASK-005 and TASK-006.
- **FILE-003**: `agent.md`, `docs/security/task-confirmation.md`, relevant design/UI documents and `docs/validation/acp-agent-execution/` evidence.

## 6. Testing

- **TEST-001**: Completed/partial reports settle with failed/unknown or absent operations, create no acceptance receipts, retain original operation hashes and deliver once across restart.
- **TEST-002**: Exact call retries do not repeat I/O; new calls with current permission work despite historical pending results; policy/owner/resource/Plan/stop/deadline and live background checks remain effective.
- **TEST-003**: Shared member reports, followup and truthful Memory observations work without acceptance; no unknown or report text becomes verified success.
- **TEST-004**: Flat task list retains every identity, original chronological order, directory search, focus/selection/scroll/animation and task detail navigation in light/dark/narrow views.
- **TEST-005**: Signed Dev provenance and original user records/configuration hashes match; no production action or complete backup occurs.

## 7. Risks & Assumptions

- **RISK-001**: Completed now means an execution submitted its report, not a verifier approved the business outcome; prompts, display and Memory must preserve that distinction.
- **RISK-002**: Old clients may still interpret compatibility acceptance fields; this change delivers matching current TypeScript backend and Web assets, retaining old fields only for data readability.
- **ASSUMPTION-001**: Required running/waiting/stopping/error lifecycle and current authorization remain; the user's removal targets pending-result/acceptance governance, not permission checks or actual process ownership.

## 8. Related Specifications / Further Reading

- [Architecture ownership](../agent.md)
- [Task confirmation and result contract](../docs/security/task-confirmation.md)
- [Items/Security/Memory ownership](../docs/design/items-security-memory-integration.md)
- [TypeScript Memory source rules](../docs/design/typescript-layered-memory.md)
- [Contribution workflow](../docs/development-workflow.md)
