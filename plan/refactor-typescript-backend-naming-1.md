---
goal: Use TypeScript backend naming throughout Lake-owned surfaces and contracts
version: 1
date_created: 2026-11-06
last_updated: 2026-11-07
owner: Codex
status: 'In progress'
tags: [refactor, typescript, compatibility]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Describe the implementation as Lake's TypeScript backend. Keep actual dependency identifiers and attribution at the integration boundary, and retain explicit read compatibility for existing data.

## 1. Requirements & Constraints

- **REQ-001**: Rename Lake-owned runtime paths, build output, scripts, docs, prompts, UI and public metadata to TypeScript/native terminology.
- **REQ-002**: Preserve SDK session history, task identities and historical native-child records after renaming; no task replay or acceptance changes.
- **SEC-001**: Preserve upstream source bytes, package names, pinning, copyright, licenses and notices. Conflicting session archives must fail safely rather than overwrite or merge.
- **CON-001**: Work on codex/typescript-backend-naming from origin/develop; PR targets develop and remains unmerged without explicit authorization. Preserve other installed Dev changes through a local integration branch.
- **GUD-001**: Keep the existing TypeScript preview/default/production migration gates and separate Dev Home. Use signed build scripts for all native installation.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Establish neutral names and a narrow dependency boundary.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Move runtime to runtime/typescript, rename preparation/parity scripts and first-party design/validation paths; update all references and archive-name documentation. | true | 2026-11-07 |
| TASK-002 | Add runtime/typescript/sdk.ts to re-export pinned public SDK APIs. Rename bundle output to bin/lake-runtime and use TypeScript/native labels in server, prompts, frontend and native desktop. | true | 2026-11-07 |

### Implementation Phase 2

- **GOAL-002**: Preserve previous data and validate the final names. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add shared legacy source normalization and a private SQLite backup migration to agent-sessions.sqlite; preserve the original archive and reject conflicting or changed legacy archives. | true | 2026-11-07 |
| TASK-004 | Add scripts/check_backend_naming.py with explicit dependency, attribution and compatibility exceptions; test migration and legacy-child rendering and run appropriate frontend/runtime/build checks. | true | 2026-11-07 |
| TASK-005 | Build the signed combined Dev candidate, validate the neutral window title and existing history, record tested SHA and coverage, and open a develop PR. | | |

## 3. Alternatives

- **ALT-001**: Blind global replacement including dependency namespaces and licenses. Rejected because it would damage attribution, reproducibility and public SDK imports.
- **ALT-002**: Point at a new empty SDK database or rename live WAL sidecars. Rejected because it can lose history or produce an inconsistent archive.

## 4. Dependencies

- **DEP-001**: Node 24 SQLite backup API, existing private Home ownership guard and the pinned SDK source manifest.
- **DEP-002**: Existing Lake Dev combination of PR 190–194; protected branches remain unchanged.

## 5. Files

- **FILE-001**: runtime/typescript, scripts/prepare_typescript_runtime.py, scripts/check_typescript_parity.py and TypeScript/native build scripts.
- **FILE-002**: web-agent/shared/runtime-compat.ts, runtime/typescript/session-archive.ts and their compatibility tests.
- **FILE-003**: web-agent/shared/contracts.ts, frontend memory/worker/API consumers, client/macos/Sources/LakeDesktop/App.swift and legacy desktop wording.
- **FILE-004**: agent.md, first-party plans, documentation and validation records; original license/notice files remain intact.
- **FILE-005**: scripts/check_backend_naming.py and its test file establish the audited naming boundary.

## 6. Testing

- **TEST-001**: Existing and fresh session archives, WAL snapshot copying, repeat startup, interrupted publication, symlink rejection and conflicting archive refusal.
- **TEST-002**: Public bootstrap/session/memory identifiers, historical native-child projection, frontend rendering and real SDK task/stop/history regression.
- **TEST-003**: Naming audit, source pinning, TypeScript/frontend checks, signed candidate build and isolated Dev history/title verification.

## 7. Risks & Assumptions

- **RISK-001**: A previous executable can write the retained legacy archive after rollback; detect a changed legacy fingerprint and require reconciliation rather than silently choosing conflicting histories.
- **RISK-002**: Historical documents contain old paths; identify mapped current names and preserve original commit references instead of claiming historical commands were rerun.
- **ASSUMPTION-001**: Dependency provenance and legacy read compatibility are legitimate exceptions to product naming, not alternative Lake backend identities.

## 8. Related Specifications / Further Reading

- [Contribution rules](../CONTRIBUTING.md)
- [Development workflow](../docs/development-workflow.md)
- [Architecture ownership](../agent.md)
- [Frontend guidelines](../docs/ui-guidelines.md)
