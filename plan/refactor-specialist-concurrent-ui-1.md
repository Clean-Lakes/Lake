---
goal: Correct cancellation reports and concurrent specialist task presentation
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'Completed'
tags: [fix, ui, typescript, tasks]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Fix the three issues reproduced in native Lake Dev: premature unknown-effect cancellation reports, an unrelated task title paired with channel activity, and ambiguous stop scopes.

## 1. Requirements & Constraints

- **REQ-001**: Finalize stop reports only after SDK cancellation and actual business receipts settle. Independently stopped tasks must not cancel a sibling task.
- **REQ-002**: Show host-verified cancelled read commands as stopped, preserving original operation and execution records. Keep uncertain mutations unknown.
- **REQ-003**: Display concurrent task counts, the actual active task when only one remains, and the most recently updated task when idle.
- **REQ-004**: Distinguish project-wide, specialist-wide and individual-task stop controls in visible labels, accessible names and hints; preserve drafts.
- **SEC-001**: No permission, acceptance, resource, retry or unknown-effect checks are weakened. Old host-generated misreports may be corrected only through exact read projections with cancellation receipts.
- **CON-001**: Keep the original goal, operation, execution, message and approval data. No historical operation replay or automatic task resumption.
- **GUD-001**: Reuse Glyph, shared theme and AppSelect; validate light/dark, narrow layouts and keyboard access in Lake Dev.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Correct stop settlement and trusted cancellation projections.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add runtime/typescript/task-cancellation.ts receipt validation and legacy host-notice projection; connect it to agent.ts and superagent.ts. | Yes | 2026-11-06 |
| TASK-002 | Coalesce per-task stop requests in superagent.ts, defer reporting during cancellation, drain business dispatch, then publish exactly one final report. Depends on TASK-001. | Yes | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Correct specialist aggregates and explicit stop scope.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Project task updatedAt and add specialist activity selection in superAgentPresentation.ts; use it in PilotWorkspace.tsx and the channel header. | Yes | 2026-11-06 |
| TASK-004 | Label composer project/specialist/all-task stops separately from SuperTaskInspector.tsx individual stop; retain draft and disabled behavior. | Yes | 2026-11-06 |

### Implementation Phase 3

- **GOAL-003**: Validate and deliver through a develop PR.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add actual SDK stop regressions, barrier-controlled lifecycle tests, receipt-negative cases and frontend aggregation/render tests; run relevant full checks. Depends on TASK-002, TASK-003, TASK-004. | Yes | 2026-11-06 |
| TASK-006 | Install a clean signed Dev candidate retaining PRs 190 and 191, repeat native same-role two-task execution and individual stop, verify themes/narrow UI and record tested SHA. Depends on TASK-005. | Yes | 2026-11-06 |
| TASK-007 | Open the independent develop PR with code and native validation evidence; keep it unmerged pending explicit authorization. Depends on TASK-006. | Yes | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: Changing every cancelled operation to success is rejected; display and evidence authority remain separate.
- **ALT-002**: Selecting workers[0] while showing channel-wide activity is rejected; aggregate actual active workers and use timestamps for idle fallback.

## 4. Dependencies

- **DEP-001**: Existing TaskLedger, public SDK cancellation, host command receipts, persistent report outbox and role channels.
- **DEP-002**: Resource PR 190 and discovery PR 191 stay independent; local Dev validation may integrate them without merging GitHub PRs.

## 5. Files

- **FILE-001**: runtime/typescript/task-cancellation.ts, agent.ts, superagent.ts and matching tests.
- **FILE-002**: web-agent/shared/contracts.ts, superAgentPresentation.ts, PilotWorkspace.tsx, App.tsx, SuperTaskInspector.tsx and existing theme CSS.
- **FILE-003**: docs/ui-guidelines.md and docs/validation/typescript-candidate/specialist-concurrent-ui.md.

## 6. Testing

- **TEST-001**: Stop A while its read operation is in flight, settle the SDK before the receipt, and verify no premature report; B continues and completes independently.
- **TEST-002**: Interrupted opaque writes retain unknown and the truthful verification warning; forged, foreign or incomplete receipts cannot change card status or historical prose.
- **TEST-003**: Two running tasks show two; stopping the first shows the remaining active title; an idle role uses the latest updated task without inferring confirmation from old waiting states.
- **TEST-004**: Native Dev shows A stopped and B continuing to success, accurate history projection, explicit stop scopes, stable drafts, and usable light/dark/narrow geometry.

Native validation passed on clean signed candidate `918cae17608d06ebb29d278daa64aaae2e64efb9`, which integrates fix code `8774ea2a00f24eb291d45b12b7c3daa285f7bc46` with the previously installed PR 190/191 changes. A stopped at 17:36:31; B continued until 17:39:09 and passed independently. Combined checks: frontend 715/715, SDK/resource integration 131/131, source units 108 passed and one optional external Claude-Mem endpoint test skipped. See the [validation record](../docs/validation/typescript-candidate/specialist-concurrent-ui.md).

Delivered as [PR 192](https://github.com/Clean-Lakes/Lake/pull/192) targeting `develop`; the PR remains unmerged.

## 7. Risks & Assumptions

- **RISK-001**: Cancellation may leave real unknown effects. Settlement must preserve that distinction and cannot claim that an interrupted write had no effects.
- **ASSUMPTION-001**: The requested fixes preserve the existing scope of each stop API; they clarify the UI instead of silently changing what a button cancels.

## 8. Related Specifications / Further Reading

- [Contribution workflow](../CONTRIBUTING.md)
- [Ownership](../agent.md)
- [UI guidelines](../docs/ui-guidelines.md)
- [Specialist channels](../docs/lake-pilot.md)
