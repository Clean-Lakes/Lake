---
goal: Deliver routed human supplements to the current specialist invocation
version: 1
date_created: 2026-11-17
last_updated: 2026-11-17
owner: Lake
status: 'In progress'
tags: [runtime, bug, supplements]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Pilot currently records followups without delivering them to the active invocation. A specialist blocked in a prerequisite question therefore never reads the supplement. Deliver exact routed inputs to the original execution and retain the existing next-invocation fallback when delivery is unconfirmed.

## 1. Requirements & Constraints

- **REQ-001**: Deliver only successfully routed followups to their exact Task/Worker/Session; preserve ordering, generation, source identity and original deadline.
- **REQ-002**: Distinguish queued input from consumed input. Only SDK drain events, matching Codex user-message events, or the resolved prerequisite-question result may add an input to invocationInputIds.
- **REQ-003**: Resume a prerequisite question with the actual supplement as new context, without inventing answers. Re-evaluate missing information in the same invocation.
- **REQ-004**: Show every active specialist prerequisite question directly above the Pilot composer, with its real name, avatar and task; reply to the exact original worker session without opening task details. Preserve drafts during refreshes and isolate concurrent questions.
- **REQ-005**: A resolved question must carry complete followups within its actual serialization budget; retain all overflow input as unconsumed for a safe continuation.
- **SEC-001**: Never resolve plan or operation approvals from a supplement; preserve current permission, memory, cancellation and resource checks. Do not replay business operations or stopped tasks.
- **CON-001**: Use the existing native SDK and official Codex 0.160.1 App Server; no second model loop, dependency upgrade or production installation.
- **GUD-001**: Keep original Dev business records and credentials unchanged. Synthetic tests contain no user credentials or remote mutations.
- **PAT-001**: Use host-issued delivery IDs and bounded metadata receipts; do not duplicate supplement bodies in receipts.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Reproduce the stalled question and specify consumption boundaries.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Inspect sanitized Dev input/worker metadata and add regression cases in runtime/typescript/superagent-lifecycle.test.ts for supplements during a prerequisite question and before a new question. | Yes | 2026-11-17 |
| TASK-002 | Verify installed 0.160.1 turn/steer schemas, clientUserMessageId and userMessage.clientId; add protocol tests in runtime/typescript/codex-app-server.test.ts. Depends on TASK-001. | Yes | 2026-11-17 |

### Implementation Phase 2

- **GOAL-002**: Deliver supplements without duplicate input or implicit approvals. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Update runtime/typescript/superagent.ts to record generation-bound deliveries, forward after successful routing, wake prerequisite questions with new context, and mark consumption only at confirmed input boundaries. | Yes | 2026-11-17 |
| TASK-004 | Update runtime/typescript/agent-host.ts and agent.ts to forward native turn_steer_drained receipts and remove unconsumed host-owned queued supplements before invocation settlement. Depends on TASK-003. | Yes | 2026-11-17 |
| TASK-005 | Update runtime/typescript/acp/client.ts, codex-app-server.ts, service.ts and types.ts to steer the exact active turn and report consumption only for its matching clientUserMessageId. Depends on TASK-003. | Yes | 2026-11-17 |
| TASK-006 | Update super-prompts.ts, agent.md and docs/lake-pilot.md to describe actual recorded/delivered states and superseded questions. Depends on TASK-003, TASK-004 and TASK-005. | Yes | 2026-11-17 |

### Implementation Phase 3

- **GOAL-004**: Bring specialist questions into the Pilot conversation. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | Project active, generation-bound questions in SuperWorkspace and render them with shared ReplyIdentity and AgentQuestion above the Pilot composer. Answers retain their original session and question IDs. | Yes | 2026-11-17 |
| TASK-011 | Validate concurrent questions, exact-session answers, refresh draft stability, disconnect/retirement, keyboard focus and light/dark/narrow layouts. Update UI guidelines and local validation evidence. Depends on TASK-010. | Yes | 2026-11-17 |

### Implementation Phase 4

- **GOAL-003**: Validate and prepare a develop PR. Depends on GOAL-002 and GOAL-004.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Run focused regressions, TypeScript checks, affected host integration tests and scripts/check_adk_runtime_boundary.py; cover stale/rejected/late delivery, source isolation, routing failure and approval preservation. | Yes | 2026-11-17 |
| TASK-008 | Build signed Lake Dev using scripts/build_lake_desktop.sh --dev --install, verify synthetic supplement delivery without real resource operations, and record tested SHA and remaining limits in docs/validation/typescript-candidate/. Depends on TASK-007. | Yes | 2026-11-17 |
| TASK-012 | Bound question-result batches, preserve overflow, and verify the long-context tail in actual native SDK and Codex requests. Rebuild signed Dev for the final product commit. | | |
| TASK-009 | Review diff, verify authorized GitHub identity, push codex/specialist-followup-delivery and open a PR against develop. Leave merge pending explicit authorization. Depends on TASK-008 and TASK-012. | | |

## 3. Alternatives

- **ALT-001**: Keep next-invocation-only delivery. Rejected because a pending question prevents that invocation from ending.
- **ALT-002**: Restart the specialist whenever a supplement arrives. Rejected because it cancels ongoing work and can repeat operations.
- **ALT-003**: Treat a queued steering acknowledgement as consumed. Rejected because an old report can finish before the model receives the supplement.

## 4. Dependencies

- **DEP-001**: Existing public SDK guide/drain and queue-removal APIs and installed official Codex 0.160.1 protocol.
- **DEP-002**: Existing TaskLedger, superInputs routing transaction, Worker lease and Lake Dev signed-build workflow.

## 5. Files

- **FILE-001**: runtime/typescript/superagent.ts, agent-host.ts, agent.ts and super-prompts.ts.
- **FILE-002**: runtime/typescript/acp/client.ts, codex-app-server.ts, service.ts and types.ts.
- **FILE-003**: runtime/typescript/superagent-lifecycle.test.ts, codex-app-server.test.ts and test-fixtures/.
- **FILE-005**: web-agent/shared/contracts.ts, PilotSpecialistQuestions.tsx, AgentQuestion.tsx, PilotWorkspace.tsx, App.tsx, agentQuestion.css and frontend regression fixtures.
- **FILE-004**: agent.md, docs/lake-pilot.md and docs/validation/typescript-candidate/.

## 6. Testing

- **TEST-001**: A routed supplement resolves only the exact current prerequisite question, carries its original text, and permits continuation without changing Task/Worker/generation.
- **TEST-002**: Native queued input remains unconsumed until drain; an unconsumed guide falls back once after settlement.
- **TEST-003**: Codex uses exact threadId/expectedTurnId/clientUserMessageId; acknowledgements, history, wrong client IDs and late notifications never count as consumption.
- **TEST-004**: Failed routing, stop, stale generation, deadlines, other specialists, plan confirmation and operation approvals cannot be bypassed.
- **TEST-006**: Pilot automatically displays all current source-bound questions with real names/avatars; answers and retirement affect only the exact original task, drafts survive snapshots, and disconnected forms cannot submit.
- **TEST-005**: Signed Dev and isolated real/synthetic runtime validation record actual input consumption and no duplicate or real business operations.
- **TEST-007**: Long supplements reach the provider with their exact tail; oversized batches consume only complete results and retain their suffix for the same task's next invocation.

## 7. Risks & Assumptions

- **RISK-001**: A question can race with a steering request. Resolve it as superseded context without injecting the same queued supplement twice.
- **RISK-002**: A late drain can arrive after execution settlement. Bind every receipt to the issued generation and preserve unconsumed input for the next invocation.
- **ASSUMPTION-001**: A supplement can be unrelated to part of a question; the model must assess remaining ambiguity rather than the host fabricating answer choices.

## 8. Related Specifications / Further Reading

- [Contribution workflow](../CONTRIBUTING.md)
- [Pilot continuous intake](../docs/lake-pilot.md)
- [Current task contract](../docs/security/task-confirmation.md)
- [Official local agent runtime](../docs/design/local-agent-runtime.md)
