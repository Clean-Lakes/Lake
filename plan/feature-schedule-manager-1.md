---
goal: Complete project schedule management and execution history
version: 1
date_created: 2026-10-19
last_updated: 2026-10-19
owner: Lake
status: Completed
tags: [feature, schedules, desktop]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Expose existing project schedules through the workspace menu with pause/resume and durable execution history. Do not create real schedules during verification.

## 1. Requirements & Constraints

- **REQ-001**: List project schedules with frequency, next execution, enabled state, last outcome and originating session.
- **REQ-002**: Pause/resume using revision checks; pausing prevents future occurrences without cancelling an active execution.
- **REQ-004**: Validate project SRE collaboration and model configuration before enabling a workflow inspection; never block pausing or reminders on these requirements.
- **REQ-003**: Persist the latest 100 executions per schedule, including running, completed, failed, interrupted and missed occurrences. Preserve existing schedule files and permission snapshots.
- **SEC-001**: Authenticate all routes, enforce project boundaries, omit saved permission options, and never execute a schedule merely by viewing or enabling it.
- **CON-001**: Existing schedules remain intact; creation continues through explicitly requested conversation tools. Normal manual checks must not trigger scheduling proposals.
- **GUD-001**: Use Glyph, theme variables, accessible modal controls and compact Lake styling.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Add project schedule APIs and persisted execution history.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | In internal/web/schedules.go record bounded history during claim, completion and restart; retain atomic schedule writes. | ✅ | 2026-10-19 |
| TASK-002 | Add internal/web/schedule_routes.go GET collection and PATCH enabled routes, revision conflict handling and future-only resume. Register in internal/web/server.go. Depends on TASK-001. | ✅ | 2026-10-19 |
| TASK-003 | Add internal/web/schedule_routes_test.go for isolation, stale writes, pause/resume, durable history and missed/restart semantics. Depends on TASK-002. | ✅ | 2026-10-19 |

### Implementation Phase 2

- **GOAL-002**: Deliver and verify the workspace schedule manager.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add contracts, api methods, ScheduledTasks.tsx/css and a project-scoped workspace-menu entry in App.tsx and SidebarUtilities.tsx. Depends on TASK-002. | ✅ | 2026-10-19 |
| TASK-005 | Update internal/ai/prompts/question-policy.txt and schedule tool descriptions to require explicit user scheduling intent; retain operation permission checks. | ✅ | 2026-10-19 |
| TASK-006 | Test frontend and backend, verify fictional browser states and build/install signed macOS Dev and Windows x64 Dev sequentially. Save docs/validation evidence. Depends on TASK-003, TASK-004 and TASK-005. | ✅ | 2026-10-19 |

## 3. Alternatives

- **ALT-001**: Hide scheduling entirely; rejected because the user requested a complete manager for the existing backend feature.
- **ALT-002**: Build a new workflow editor; excluded because listing, enabling/disabling and execution records can reuse existing saved schedules.

## 4. Dependencies

- **DEP-001**: Existing tool-schedules.json scheduler, project store, saved workflows and session navigation.
- **DEP-002**: Existing authenticated HTTP handler and signed Dev build scripts.

## 5. Files

- **FILE-001**: internal/web/schedules.go, schedule_routes.go, schedule_routes_test.go and server.go implement and verify scheduler management.
- **FILE-002**: web-agent/shared/contracts.ts, web-agent/web/src/api.ts, ScheduledTasks.tsx/css, SidebarUtilities.tsx and App.tsx expose management.
- **FILE-003**: internal/ai/prompts/question-policy.txt and extended_catalog.go define explicit-intent behavior.

## 6. Testing

- **TEST-001**: Go race-enabled scheduler, route, bridge and prompt regressions with isolated temporary stores.
- **TEST-002**: Frontend tests, TypeScript production build and browser fixture checks for list, empty, error, pause/resume, history, navigation, keyboard and dark/narrow layouts.
- **TEST-003**: Signed macOS Dev build and Windows x64 package checks; preserve Dev data and release artifacts.

## 7. Risks & Assumptions

- **RISK-001**: Scheduler claims may race management writes; a mutex and expected revision prevent lost updates.
- **RISK-002**: Older schedules have no full history; display their saved last state and start recording future executions without inventing older entries.
- **ASSUMPTION-001**: Scheduling runs only while Lake runs; missed occurrences are skipped after restart and are never silently replayed.

## 8. Related Specifications / Further Reading

[UI guidelines](../docs/ui-guidelines.md)
[Existing scheduler](../internal/web/schedules.go)
[Development workflow](../CONTRIBUTING.md)
