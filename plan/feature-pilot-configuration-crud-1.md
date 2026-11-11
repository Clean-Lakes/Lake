---
goal: Pilot natural-language CRUD for resources, folders, Skills and MCP
version: 1
date_created: 2026-11-11
last_updated: 2026-11-11
status: In progress
tags: [feature, pilot, configuration, typescript]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Expose existing Lake configuration ownership through Pilot tools. Persist configuration through shared host services, with exact admitted human sources, current object revisions and durable mutation receipts. Resource configuration remains project-scoped; Skills and MCP server settings remain Lake-global. Configuration does not constitute a connection observation or task acceptance.

## 1. Requirements & Constraints

- **REQ-001**: Create, read, partially update and archive project resources and resource folders, retaining exact resource IDs and history. Support existing connection kinds; do not claim unimplemented runtime adapters.
- **REQ-002**: List/read/create/update/remove Skills and register/unregister Skill roots. Edit Lake-managed content only; imported content is never overwritten or physically deleted.
- **REQ-003**: List/create/update/delete global MCP server settings, test an explicitly selected saved connection and update its current-project binding through existing catalog checks. Preserve omitted headers/env and existing credentials.
- **SEC-001**: Mutations require the current complete admitted human event, exact quote, stable event/part receipt and expected revision. Register only on Pilot, excluding Worker, child and ACP business catalogs. Respect recovery, Plan mode and current read/write/MCP preferences.
- **SEC-002**: No credential values, credential file references or trust/permission settings in model management schemas/results. New SSH entries without saved credentials remain unavailable; explicitly selected same-project SSH source may supply saved credentials internally. No connection or process starts on CRUD reads/writes.
- **CON-001**: Reuse `LakeResourceNavigation`, `LakeSSH`, `LakeServiceResources`, `LakeExtensions` and the existing SQLite/file stores; add no model loop, service or asset registry. Pending filesystem mutation receipts never replay automatically after interruption.
- **CON-002**: Preserve existing Dev data and local Codex max configuration; use isolated temporary Homes for mutation tests and the signed Dev workflow for installation. Ordinary PR targets develop; no merge/release authorization is implied.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Shared host CRUD and truthful public configuration projections.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add `runtime/typescript/resource-management.ts` for shared resource create/update; use it in `server.ts`. Extend `resource-navigation.ts` to exempt only the exact current configuration event/router from its idle check. Preserve other tasks/terminals/pending inputs. | ✅ | 2026-11-11 |
| TASK-002 | Extend `ssh.ts` with explicit incomplete-configuration parsing for unavailable resource drafts, leaving execution validation strict. Add `LakeExtensions.removeSkill` in `extensions.ts` and HTTP DELETE support: archive managed directories, unregister imported paths, retain credentials and roots. Validate all Skill patch fields before I/O. | ✅ | 2026-11-11 |

### Implementation Phase 2

- **GOAL-002**: Pilot tools and provenance. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add `runtime/typescript/pilot-configuration.ts`: bounded revisioned resource/folder, Skill/root and MCP catalogs, strict partial patches, stable mutation journal, exact human admission, explicit global scope, MCP test/binding handling and redacted receipts. | ✅ | 2026-11-11 |
| TASK-004 | Register these entries only in `LakeSuperagent.routerEntries`, inject host dependencies from `server.ts`, update `super-prompts.ts` and operation preference categories. Exclude management names from `agent.ts` child and `acp/catalog.ts` external business tools. | ✅ | 2026-11-11 |

### Implementation Phase 3

- **GOAL-003**: Isolated end-to-end verification and signed Dev delivery. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add `pilot-configuration.test.cjs` and SDK-host scenarios in `server.test.cjs`: CRUD, folder nesting/archive, restart, partial patches, secrets, imported Skills, stale/cross-project/source/replay rejection, interrupted writes, permissions, Plan mode and non-Pilot catalogs. | ✅ | 2026-11-11 |
| TASK-006 | Run backend types/build/unit/host and applicable frontend/boundary/naming checks. Record tested SHA and isolated outcomes in `docs/validation/acp-agent-execution/pilot-configuration-crud.md`; update runtime/product/architecture documentation. Install signed Lake Dev only when idle, verify source/signature/record hashes, and update draft PR #222. | | |

## 3. Alternatives

- **ALT-001**: Model-generated SQL, shell edits or HTTP calls against settings were rejected because they bypass validators, scope checks and credential isolation.
- **ALT-002**: A second configuration database or automatic external service discovery was rejected; existing stores and explicit MCP tests cover this feature.

## 4. Dependencies

- **DEP-001**: Existing SQLite `LakeStore`, resource navigation trash, SSH/service validators and extension private-file ownership checks.
- **DEP-002**: Current Pilot admission, public SDK ToolEntry/permission resolution and project MCP catalog/binding fences.

## 5. Files

- **FILE-001**: `runtime/typescript/resource-management.ts`, `resource-navigation.ts`, `ssh.ts`, `extensions.ts`, `server.ts` — shared CRUD.
- **FILE-002**: `runtime/typescript/pilot-configuration.ts`, `superagent.ts`, `super-prompts.ts`, `operation-permissions.ts`, `agent.ts`, `acp/catalog.ts` — tool routing and guards.
- **FILE-003**: `runtime/typescript/pilot-configuration.test.cjs`, `server.test.cjs` — isolated persistence and actual SDK tool-loop tests.
- **FILE-004**: `agent.md`, `docs/lake-pilot.md`, `runtime/typescript/README.md`, `docs/validation/acp-agent-execution/compatibility.md` and the validation record — delivered behavior and limitations.

## 6. Testing

- **TEST-001**: All CRUD operations remain visible through standard APIs after restart; omitted settings and credential bytes are retained, and metadata catalogs never connect or spawn.
- **TEST-002**: Reject stale revisions, foreign IDs, unadmitted/foreign quotes, conflicting/repeated parts, interrupted journal writes, unknown fields, secret input, forbidden paths and non-Pilot management.
- **TEST-003**: Exercise actual SDK calls using synthetic loopback model responses, with resource/folder CRUD, Skill/root CRUD, MCP settings and safe catalog binding; no real server or daily Dev data mutation.
- **TEST-004**: Signed Dev origin/signature and original business/configuration hashes remain unchanged except intended code installation; no production operation or full backup.

## 7. Risks & Assumptions

- **RISK-001**: SQLite and private extension/Skill files are separate transaction domains. A durable pending record blocks replay when completion cannot be established; current state must be read independently.
- **RISK-002**: Global Skill/MCP changes can affect other projects. Require explicit global tool scope and return it in receipts; project MCP access remains separately bound.
- **ASSUMPTION-001**: The user requests CRUD capability, not changes to current production resources or installed extensions. All mutation validation uses temporary synthetic configuration.

## 8. Related Specifications / Further Reading

[Contribution workflow](../CONTRIBUTING.md), [development workflow](../docs/development-workflow.md), [module ownership](../agent.md), [Items/Security/Memory integration](../docs/design/items-security-memory-integration.md), [Security](../docs/design/lake-security-v1.md), [existing specialist configuration](feature-pilot-specialist-config-1.md).
