---
goal: Restore resource Mini Boxes and durable conversation unread indicators
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Codex
status: 'Completed'
tags: [feature, frontend, runtime]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Restore the existing Mini Box in task execution details and show green unread dots for Pilot and specialist conversations.

## 1. Requirements & Constraints

- **REQ-001**: Render resource-bound Bash and inspect_host records in Mini Box, retaining raw receipts and child execution identity.
- **REQ-002**: Persist message revisions and read receipts for Pilot and specialist channels; include failed replies and pending questions, independently of task acceptance and running indicators.
- **REQ-003**: Running/preparing spinners and unread dots are visually exclusive; retain unread receipts until content is viewed. Different adjacent reply roles receive 12px additional spacing.
- **SEC-001**: Interrupt only the exact live command owned by the original session, task, generation and unchanged resource configuration. Scrub projected output. Do not change task acceptance or reconcile unknown operations.
- **CON-001**: Branch from origin/develop; PR targets develop and remains unmerged until explicit authorization. Build only signed Lake Dev, preserving other pending Dev changes and release isolation.
- **GUD-001**: Follow docs/ui-guidelines.md; retain Mini Box geometry and shared Glyph icons. A viewed conversation is read only when loaded content is visible at its end.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Restore host-bound command previews and per-command interruption.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add scrubbed command execution projections and exact interruption to runtime/zcode/execution.ts and server.ts; keep operation ownership checks. | ✅ | 2026-11-06 |
| TASK-002 | Mount MiniBox in web-agent/web/src/WorkerExecutionTree.tsx with scoped cards, including native child runs; adapt miniBoxModel.ts and MiniBox.tsx for SDK execution identities. | ✅ | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Add durable unread state and validate the integrated Dev application. Depends on GOAL-001 for combined UI validation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add runtime/zcode/conversation-reads.ts; project cursors in workspace/channel/snapshot responses; validate monotonic read acknowledgements. | ✅ | 2026-11-06 |
| TASK-004 | Add visible conversation read marker and Pilot/specialist green indicators; retain legacy completion protocol compatibility. | ✅ | 2026-11-06 |
| TASK-005 | Run frontend and runtime checks, verify Lake Dev command display and unread behavior, record exact tested SHA, and open PR against develop. Automated checks and signed installation passed; native message read-on-view, role spacing, light/dark and narrow execution pane reviewed at bedcece6. Coverage limits are recorded separately. See docs/validation/zcode-typescript-candidate/minibox-unread.md. | ✅ | 2026-11-06 |

## 3. Alternatives

- **ALT-001**: Reuse completion counts for all unread messages. Rejected because partial replies, failures, questions and Pilot messages do not require successful task acceptance.
- **ALT-002**: Map SDK executions to fictitious PTY terminal IDs. Rejected because it would weaken generation ownership and target the wrong cancellation mechanism.

## 4. Dependencies

- **DEP-001**: Existing MiniBox, operation ledger and LakeExecution host adapter.
- **DEP-002**: Existing signed Lake Dev and pending PR 190–193 local integration; these PRs are preserved without merging protected branches.

## 5. Files

- **FILE-001**: runtime/zcode/conversation-reads.ts, execution.ts, superagent.ts, server.ts and api-inventory.json implement host projections and endpoints.
- **FILE-002**: web-agent/shared/contracts.ts and web-agent/web/src/api.ts define optional backward-compatible fields and clients.
- **FILE-003**: web-agent/web/src/WorkerExecutionTree.tsx, MiniBox.tsx, miniBoxModel.ts, miniBoxPreview.ts, SessionInspector.tsx restore execution UI.
- **FILE-004**: web-agent/web/src/ConversationReadMarker.tsx, PilotWorkspace.tsx, SpecialistChannel.tsx and App.tsx connect visible reads and navigation dots.
- **FILE-005**: runtime/zcode/server.test.cjs and web-agent/web/test cover identity isolation, read races and rendering.

## 6. Testing

- **TEST-001**: Verify Mini Box on initial dispatch, Bash stdout/exit code parsing, native child ownership and unrelated command isolation.
- **TEST-002**: Verify unread on non-success replies and Pilot replies, excluding user/tool-only updates; stale/future/cross-session reads and restart persistence.
- **TEST-003**: Verify native Lake Dev light/dark and narrow views, green dots while another conversation is selected, read-on-view and Mini Box output/interrupt behavior using synthetic local commands only.

## 7. Risks & Assumptions

- **RISK-001**: An old completion-only backend lacks message cursor support; retain its existing completion read path without fabricating new runtime capabilities.
- **RISK-002**: Stream and read requests can race; acknowledge only the rendered cursor and let newer revisions remain unread.
- **ASSUMPTION-001**: Read receipts are local workspace metadata shared across windows, following the existing completion read design.

## 8. Related Specifications / Further Reading

- [Contribution workflow](../CONTRIBUTING.md)
- [Development workflow](../docs/development-workflow.md)
- [UI guidelines](../docs/ui-guidelines.md)
- [Architecture ownership](../agent.md)
