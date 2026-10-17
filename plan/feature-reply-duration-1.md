---
goal: Show a persistent per-answer elapsed duration with a live counter
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, chat, timing]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Show one compact duration footer per user turn, live while processing and frozen after completion. Preserve final durations after subsequent replies and reloads.

## 1. Requirements & Constraints

- **REQ-001**: Count from actual message dispatch through turn cleanup; exclude queue waiting and include processing/approval waiting.
- **REQ-002**: Persist completed, cancelled and failed timings by user message ID; do not invent missing historical completion timestamps.
- **REQ-003**: Show live elapsed time even with sub Agents or thinking visible; replace the duplicate latest-turn “已处理” counter.
- **CON-001**: Use signed Lake build scripts; preserve the live user backend and terminals.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Persist exact turn timestamps.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add replyTimings table in internal/web/schema.sql, insert within Store.begin, finish via runTurn defer before queue dispatch, expose metadata in snapshots and mark unfinished records interrupted on restart. | Yes | 2026-10-12 |
| TASK-002 | Add internal/web/reply_timing_test.go for completion, abort, failure, reload and queued-turn start timing. Depends on TASK-001. | Yes | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: Render and validate compact per-turn counters.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add ReplyDuration.tsx and replyDurationState.ts, associate each transcript turn with its user message ID, remove duplicate AIProgress duration and style a clock/footer. Depends on TASK-001. | Yes | 2026-10-12 |
| TASK-004 | Add frontend duration tests; run typecheck, frontend tests and Go race suite; verify live/frozen counters and history persistence with a synthetic model. Depends on TASK-002 and TASK-003. | Yes | 2026-10-12 |
| TASK-005 | Build/install signed app, save screenshot/report and document timing behavior. Depends on TASK-004. | Yes | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: Latest AIView timestamps overwrite previous turns; persist per-message timings rather than estimating from card creation timestamps.

## 4. Dependencies

- **DEP-001**: Store.begin and runTurn completion own actual dispatch and cleanup; PendingMessages already excludes queued messages from transcript until dispatch.

## 5. Files

- **FILE-001**: internal/web/schema.sql, store.go, agent.go, reply_timing.go and reply_timing_test.go implement persistence.
- **FILE-002**: web-agent/shared/contracts.ts, web-agent/web/src/ReplyDuration.tsx, replyDurationState.ts, AIPanel.tsx, AIProgress.tsx and styles.css implement display.

## 6. Testing

- **TEST-001**: Final duration stays fixed across new turns and restart; each queued turn starts when dispatched.
- **TEST-002**: Cancel/failure records actual terminal status; server interruption has no invented finish time.
- **TEST-003**: Fast replies show “不到1秒”; invalid or absent timestamps do not produce fabricated time; multi-Agent turns retain one duration footer.

## 7. Risks & Assumptions

- **RISK-001**: Startup interruption lacks an exact finish time; keep its status and suppress duration.
- **ASSUMPTION-001**: “回答耗时” measures total elapsed handling time, including approvals and excluding queue waiting.

## 8. Related Specifications / Further Reading

[Message queue](feature-message-queue-1.md) · [Credential rules](../AGENTS.md)

## 9. Validation Results

- TypeScript typecheck, 78 frontend tests, targeted timing/queue race tests and full `go test -race ./...` passed.
- Browser observed a live counter updating, final durations of `16秒` and `不到1秒`, and identical values after reload. A queued message had no timing record until actual dispatch.
- Signed desktop build installed successfully. Existing user backend and terminal connections remain intact; its embedded frontend needs a backend switch to load the update.
- [Validation report](../docs/validation/lake-reply-duration.json) · [Verified interface](../docs/validation/lake-reply-duration.png)
