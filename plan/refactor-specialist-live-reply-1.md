---
goal: Restore specialist live status and final summaries
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'In progress'
tags: [refactor, frontend, zcode]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Project each actual specialist invocation into one changing status followed by its frozen public result. Keep canonical execution records intact.

## 1. Requirements & Constraints

- **REQ-001**: Replace interim narration in place, animate only actual execution, and display one final summary per invocation.
- **REQ-002**: Retain task boundaries, original user messages, plans, approvals, questions and inspector access.
- **SEC-001**: Never replay operations or infer acceptance from prose; failed resumes cannot reuse an earlier answer.
- **CON-001**: Continue PR 188 against develop; use signed isolated Lake Dev and require explicit authorization for merging.
- **GUD-001**: Reuse LoadingWaves, StatusText and reduced-motion/visibility behavior with stable keys.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Produce source-bound presentation entries without changing task authority.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add invocation projection in web-agent/shared/specialist-replies.ts and root-bound report metadata in runtime/zcode/superagent.ts. | ✅ | 2026-11-06 |
| TASK-002 | Replace stacked prose with a stable live status in web-agent/web/src/SpecialistChannel.tsx and preserve final report identity. Depends on TASK-001. | ✅ | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Validate invocation isolation, visible animation and final delivery.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add projection/SDK tests, run frontend and runtime checks, and inspect synthetic live transitions in light/dark/narrow/reduced-motion states. Depends on TASK-002. | ✅ | 2026-11-06 |
| TASK-004 | Build/install signed Lake Dev after confirming idle state, record tested SHA, and update PR 188. Depends on TASK-003. | | |

## 3. Alternatives

- **ALT-001**: Filtering by prose keywords is rejected because legitimate user text and independent results must retain identity.
- **ALT-002**: Deleting old progress records is rejected because the inspector and original evidence require them.

## 4. Dependencies

- **DEP-001**: Existing SDK root-turn metadata, host report outbox and specialist channel API.

## 5. Files

- **FILE-001**: web-agent/shared/contracts.ts and web-agent/shared/specialist-replies.ts define presentation metadata and projection.
- **FILE-002**: runtime/zcode/superagent.ts and runtime/zcode/agent.ts retain exact report/card invocation provenance.
- **FILE-003**: web-agent/web/src/SpecialistChannel.tsx, specialistChannelProjection.ts and specialistChannel.css render the stable status.

## 6. Testing

- **TEST-001**: Exercise multiple progress updates, exact final report replacement, failed resume, pagination, plans and concurrent tasks without source mutations.
- **TEST-002**: Verify stable DOM, running/waiting/disconnected animation, reduced motion, final summary and inspector in synthetic browser and Lake Dev.

## 7. Risks & Assumptions

- **RISK-001**: Older records lack invocation metadata; preserve their original source identities and avoid inventing completion.
- **ASSUMPTION-001**: Report outbox snapshots remain the authority for the public settled result; display projection never grants acceptance.

## 8. Related Specifications / Further Reading

- [UI guidelines](../docs/ui-guidelines.md)
- [Development workflow](../docs/development-workflow.md)
- [Architecture](../agent.md)
