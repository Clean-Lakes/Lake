---
goal: Allow pending messages while Lake replies, with editing, removal and ordering
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, chat, queue]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Persist a per-session pending message queue and dispatch each message after the previous reply completes. Keep the composer usable while replying and expose edit, remove, drag ordering and keyboard ordering.

## 1. Requirements & Constraints

- **REQ-001**: Send while busy enqueues text, image/file attachments and resource references without interrupting the active turn.
- **REQ-002**: Edit, remove and reorder pending messages; expose pause/resume and preserve order across refresh or session switching.
- **REQ-003**: Dispatch only one turn per session; stop, failure and restart pause the remaining queue; approval keeps the active turn and queue waiting.
- **SEC-001**: Revalidate resource and attachment access when dispatching; do not return image payloads in queue snapshots; retain private database permissions.
- **CON-001**: Build and install through signed Lake scripts, preserving current user backend and terminal connections.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Add persistent queue transactions and serialized dispatch.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add queue tables in internal/web/schema.sql and internal/web/message_queue_store.go; increment revisions, atomically consume with Store.Begin and pause on restart. | Yes | 2026-10-12 |
| TASK-002 | Add internal/web/message_queue.go validation, session scheduling and authenticated CRUD/control endpoints; integrate messages, runTurn completion and abort in server.go and agent.go. Depends on TASK-001. | Yes | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: Implement queue controls and usable busy composer.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add contracts/API types and PendingMessages.tsx with inline editor, remove, drag/drop and move buttons; use revision checks and pause before editing. Depends on TASK-002. | Yes | 2026-10-12 |
| TASK-004 | Integrate queue snapshots and busy composer in App.tsx; keep stop available beside enqueue button and allow attachments while replying. Depends on TASK-003. | Yes | 2026-10-12 |

### Implementation Phase 3

- **GOAL-003**: Verify queue lifecycle and install signed build.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Test FIFO dispatch, mutations, revision conflicts, attachment/resource isolation, failures/stops, restart persistence and concurrent submissions with Go race tests; run TypeScript/frontend checks. Depends on TASK-004. | Yes | 2026-10-12 |
| TASK-006 | Verify queue edit/remove/reorder and busy composer using a synthetic model in the browser; capture screenshot, document behavior and build/install signed client. Depends on TASK-005. | Yes | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: A frontend-only queue disappears on reload and requires a visible browser to dispatch; use a backend queue.

## 4. Dependencies

- **DEP-001**: Store.update provides SQLite transactions and session events; runTurn owns turn cleanup and completion.

## 5. Files

- **FILE-001**: internal/web/message_queue.go, message_queue_store.go, schema.sql, server.go, store.go and agent.go implement queue persistence and dispatch.
- **FILE-002**: web-agent/shared/contracts.ts, web-agent/web/src/api.ts, PendingMessages.tsx, messageQueue.ts, pendingMessages.css and App.tsx implement the composer and controls.

## 6. Testing

- **TEST-001**: Block a synthetic model, enqueue several messages, reorder/edit/remove, release the first response and assert exactly one ordered request at a time.
- **TEST-002**: Reject stale revisions, foreign resource/file references and malformed ordering; pause on abort/failure/restart without replay.
- **TEST-003**: Verify busy input is editable, shortcut queues a message, stop remains accessible and queue controls update without reload.

## 7. Risks & Assumptions

- **RISK-001**: Turn completion can race with editing; pause the queue before opening the editor and use revision checks for all edits.
- **ASSUMPTION-001**: Queued messages use the model selected when they are dispatched; manually resumed messages constitute a new request after a stop or failure.

## 8. Related Specifications / Further Reading

[Credential rules](../AGENTS.md) · [Model settings](feature-model-provider-settings-1.md)

## 9. Validation Results

- TypeScript typecheck, 72 frontend tests, queue-focused race tests and full `go test -race ./...` passed.
- Synthetic browser verified typing while replying, shortcut/button enqueue, inline edit, removal, move buttons, keyboard ordering, native drag ordering, reload persistence and FIFO drain. Model request order was `你好 → 明白 → 好的`.
- Built and installed the signed client; preserved the running user backend and terminal connections. Current user process still requires a backend switch to load the new embedded client and queue API.
- [Validation report](../docs/validation/lake-message-queue.json) · [Verified interface](../docs/validation/lake-message-queue.png)
