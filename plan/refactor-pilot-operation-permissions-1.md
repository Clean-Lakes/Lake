---
goal: Unify managed agent operation confirmation under current Pilot preferences
version: 1
date_created: 2026-11-09
last_updated: 2026-11-09
owner: Lake
status: In progress
tags: [refactor, permissions, typescript]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The user requires specialists and native children to follow Pilot's operation switches. Enabling automatic execution removes secondary risk/transport/SDK confirmation prompts. Operation risk remains recorded and is not a read-only proof.

## 1. Requirements & Constraints

- **REQ-001**: Pilot is the only preference authority for its managed Workers and role channels. Runtime and options API report its current effective switches.
- **REQ-002**: Each managed business tool uses one category switch; automatic allows execution without another risk-, SDK- or transport-based prompt. Disabled switches request approval before I/O.
- **SEC-001**: Keep hard deny, resource/configuration/credential fences, SSH trust, cancellation, original generation, Memory, Plan/read-only scope, result ledger and acceptance. Do not replay or approve historical pending calls.
- **CON-001**: Use SDK public permission capability and session rules; no SDK source edits or alternate executor/model loop. Development only; no production install, merge or release is implied.
- **PAT-001**: Shared default values remain in `web-agent/shared/execution-preferences.ts`; tool categories and SDK projection live in `runtime/typescript/operation-permissions.ts`.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Identify every managed approval source and centralize its preference decision.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Audit `LakeSuperagent.taskProfile/configureBash/configureNativeControl/hostEntries/databaseEntries/extensionEntries`, `LakeExtensions`, and human-only `LakeTerminals`; record category and retained fences. | Yes | 2026-11-09 |
| TASK-002 | Add `operationApproval` and `operationPermissionRules`; use them in the audited managed tools, including Skill, local MCP discovery and calls. Remove MCP-wide approval scanning and Bash risk-forced approval. | Yes | 2026-11-09 |
| TASK-003 | Return effective Pilot preferences for managed options API; reject independent managed permission configuration. Update permission tooltip and architecture/confirmation specifications to the user's current instruction. | Yes | 2026-11-09 |

### Implementation Phase 2

Depends on TASK-002 and TASK-003.

- **GOAL-002**: Verify actual SDK approval behavior and the installed Dev application.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Extend `runtime/typescript/server.test.cjs`: auto on/off for high-risk-classified Bash, child writes and file searches, HTTP/stdio MCP, current-policy changes and effective options; retain existing deny/trust/Plan/ledger regressions. | Yes | 2026-11-09 |
| TASK-005 | Run TS typecheck/source and bundled tests, frontend typecheck/tests/build, ADK/naming/diff checks; record exact results. | Yes | 2026-11-09 |
| TASK-006 | Build/install signed Lake Dev from a clean commit, verify automatic script execution without an approval and disabled-switch behavior in isolated Dev fixtures, open a develop PR with evidence. | No | 2026-11-09 |

## 3. Alternatives

- **ALT-001**: Whitelist Python read scripts; rejected because each interpreter/container form would retain a conflicting second approval system.
- **ALT-002**: Enable SDK yolo mode; rejected because it changes unrelated tool and Plan behavior. Keep build mode with scoped public rules.

## 4. Dependencies

- **DEP-001**: Pinned public SDK PermissionRuleset and resolvePermissionCapability contracts; existing task policy hash invalidates old execution after preferences change.
- **DEP-002**: Persistent macOS signing identity and isolated Dev Home; no production credentials are copied.

## 5. Files

- **FILE-001**: `runtime/typescript/operation-permissions.ts`, `superagent.ts`, `extensions.ts`, `server.ts` — authority, categories and native SDK projection.
- **FILE-002**: `runtime/typescript/server.test.cjs` — real SDK/protocol regression fixtures.
- **FILE-003**: `web-agent/web/src/PermissionSettings.tsx`, `agent.md`, `docs/security/task-confirmation.md` — user-visible and architecture semantics.
- **FILE-004**: `docs/validation/typescript-candidate/pilot-operation-permissions-2026-11-09.md` — audit, tested SHAs and limits.

## 6. Testing

- **TEST-001**: Automatic Pilot/Worker/child operations complete with real local/protocol evidence and zero permission_requested events; false switches produce pending approval before side effects.
- **TEST-002**: Current policy changes invalidate previous execution; deny, wrong project, changed configuration, credentials, stop and Plan/read-only scopes retain actual rejection and no fabricated success.
- **TEST-003**: MCP discovery cannot force approval only because it is stdio; unrelated services cannot change another call's approval. Calls retain exact pins and enabled bindings.
- **TEST-004**: Effective Worker/channel options match Pilot; independent permission writes fail and do not change either authority.

## 7. Risks & Assumptions

- **RISK-001**: Automatic commands can change the system even when an opaque script cannot be classified. The user explicitly requested automatic execution; do not label such scripts read-only or accepted merely because they ran.
- **ASSUMPTION-001**: Plan acceptance and first/changed SSH host-key trust are distinct explicit protocols, not duplicate per-operation preferences. Human-owned PTY handoff is separate from managed Bash execution.

## 8. Related Specifications / Further Reading

- [Architecture](../agent.md)
- [Task confirmation](../docs/security/task-confirmation.md)
- [Contribution workflow](../docs/development-workflow.md)
