---
goal: Progressive terminal authorization and session permission controls
version: 1
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Lake
status: 'Completed'
tags: [feature, permissions, terminal, react, go]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-Completed-brightgreen)

Add terminal management to the resource sidebar, authorize each new Agent terminal before creation, and persist explicit permission settings per conversation. Closing a terminal preserves the conversation; its next terminal operation requests creation authorization again unless automatic terminal creation was explicitly enabled.

## 1. Requirements & Constraints

- **REQ-001**: Show live resource terminals with owning session titles in the sidebar and allow closing one or all terminals for that resource.
- **REQ-002**: Default new Agent terminal creation requires an in-turn approval; rejection creates no terminal or command effect. Reuse of an existing Agent terminal does not request creation approval.
- **REQ-003**: Persist boolean silentReadFiles=true, silentWriteFiles=false, silentReadSQL=true, silentCommands=false, silentTerminalCreation=false, blockUnreferencedAssets=false, denyLocalExecution=false in aiOptions.
- **REQ-004**: Enforce permissions in Go. Dangerous operations retain explicit target confirmation; permission switches never authorize credential access.
- **REQ-005**: Manual terminal closure invalidates the old connection; the next operation requires a fresh creation decision, and old command/approval history stays in its original turn.
- **SEC-001**: Resource-close endpoints verify terminal/resource association, and approval fingerprints detect ownership/context drift.
- **CON-001**: Build bin/lake only through scripts/build_lake.sh with the persistent signing identity. Never print model keys or SSH private-key contents.
- **PAT-001**: Reuse Engine approval channels, pending cards, SQLite aiOptions and current React styling.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Enforce operation-specific permissions and creation approvals in Go.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add Permissions and Approval kind fields in internal/ai/types.go; implement gate classification and referenced-asset/local-execution checks in internal/ai/tools.go and permissions.go; validate/load booleans in internal/web/agent.go. | ✅ | 2026-10-11 |
| TASK-002 | Refactor host terminal selection into a reusable plan in internal/web/host_session.go; expose creation requirements/frozen target in bridge policy and require approval or configured automatic creation at every Agent opening path. | ✅ | 2026-10-11 |
| TASK-003 | Add live terminal metadata to Store.Catalog and resource-scoped terminal-close routes in internal/web/store.go and server.go, preserving retained sessions and history. | ✅ | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: Expose resource terminal management and permission choices in React.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Extend shared/contracts.ts and web/src/api.ts; add resource terminal controls in App.tsx and operation-specific approval text plus permission dialog in AIPanel.tsx using current CSS. Depends on TASK-001, TASK-002 and TASK-003. | ✅ | 2026-10-11 |

### Implementation Phase 3

- **GOAL-003**: Verify progressive authorization, browser flows and the signed local service.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add Go integration tests for first approval, reject/no-effect, reuse, manual close/re-authorize, silent controls, scope/local blocks and cross-resource close rejection. Keep previous read-only/session tests with explicit fixture permissions. Depends on TASK-001 through TASK-004. | ✅ | 2026-10-11 |
| TASK-006 | Run Go race/vet checks, React checks/build and browser approval/close/recreate verification; build and verify the signed binary, restart only idle local service, and record results in docs/validation. Depends on TASK-005. | ✅ | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: A permanent resource-level creation grant was rejected because manual closure must request a fresh creation decision by default.
- **ALT-002**: Frontend-only permission toggles were rejected because tool execution must enforce the configured policy in Go.

## 4. Dependencies

- **DEP-001**: Existing Engine.Decision, terminal manager and authenticated HTTP APIs; no additional runtime dependency.

## 5. Files

- **FILE-001**: internal/ai/types.go, tools.go, permissions.go, engine.go and catalog.go.
- **FILE-002**: internal/web/agent.go, host_session.go, store.go and server.go.
- **FILE-003**: web-agent/shared/contracts.ts, web/src/api.ts, App.tsx, AIPanel.tsx and existing stylesheet.
- **FILE-004**: internal/web and internal/ai tests, docs/validation and this plan.

## 6. Testing

- **TEST-001**: First use prompts before process creation; rejected approval has no terminal/effect; approved reuse does not reprompt; manual close prompts a new ID and creates a new terminal only after approval.
- **TEST-002**: Silent file/read-SQL/command/write controls and local/reference blocks enforce configured behavior; protected credential/dangerous checks remain.
- **TEST-003**: Resource close preserves sessions and rejects mismatched resource/terminal IDs; browser verifies close controls, saved settings and recreated-session approval.
- **TEST-004**: Go race/vet, frontend order regressions, React build, codesign and signed empty-PATH runtime verification pass.

## 7. Risks & Assumptions

- **RISK-001**: Closing a busy terminal interrupts its command; the UI identifies busy state and backend records unknown/interrupted effects without replay.
- **ASSUMPTION-001**: Permission preferences apply to the current conversation. A terminal creation decision covers that opening and its bounded initial read-only host inspection, not future arbitrary commands.

## 8. Related Specifications / Further Reading

[Persistent host-session validation](../docs/validation/lake-go-server.md)

[Lake credential/build rules](../AGENTS.md)
