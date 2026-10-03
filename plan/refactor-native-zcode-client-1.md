---
goal: Replace the Wails client with the native ZCode client and CLI, retaining only LAKE data and native workflow lake associations
version: 1
date_created: 2026-10-02
last_updated: 2026-10-03
owner: Lake
status: 'In progress'
tags: [refactor, architecture, migration]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The user's final scope supersedes the previous frontend preservation requirement and the unfinished Wails navigation fix. Deliver the existing native Electron client and original ZCode CLI under LAKE branding. Add a data presentation panel and lake associations to native saved workflows; do not ship a competing operations workflow engine.

## 1. Requirements & Constraints

- **REQ-001**: Use the original native Electron renderer, host, Agent protocol, session navigation, tools, browser/CUA, extensions, automation and workflow execution.
- **REQ-002**: Present lakes/resources and original native saved workflows in the client; persist explicit lake/workspace and lake/workflow associations and reject foreign-lake resource access.
- **REQ-003**: Use LAKE product display names and Agent identity; preserve upstream package namespaces, protocol identifiers and attribution.
- **REQ-004**: Isolate global data in ~/.lake, project metadata in .lake and Electron state in Application Support/LAKE; LAKE_HOME overrides all runtime roots. Do not implicitly import original ZCode data.
- **SEC-001**: Keep old SQLite data and private vault files; do not print, log or commit credentials. Normal operations do not read legacy Keychain items.
- **CON-001**: Build the user-facing macOS bin/lake only through scripts/build_lake.sh using the persistent signing identity. Sign and verify the native application before replacing the installed app, retaining a backup.
- **CON-002**: Historical LAKE workflows remain readable but cannot be launched from the new client. Native workflow files, journals and permissions remain native-owned.
- **PAT-001**: Renderer → hook → IPlatformService → bounded data-worker request → existing SQLite/vault. Agent → native MCP permission/transport → scoped LAKE data tools. No custom model proxy or Agent loop.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Define the final ownership boundary and remove unfinished work for the superseded client.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Restore only the uncommitted Wails concurrency files created in the interrupted turn and record final user scope in third_party/zcode/.agents/specs/lake-native-client.md. | Yes | 2026-10-02 |
| TASK-002 | Define strict LAKE data request/response and workspace/workflow association contracts in packages/shared/src/lake-data.ts; store only associations in dedicated schema-20 metadata tables, creating a private backup before upgrade. | Yes | 2026-10-03 |

### Implementation Phase 2

- **GOAL-002**: Attach the existing data layer to original native clients.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | After TASK-002, implement a data-only worker in apps/zcode-cli/packages/lake/src/adapters/native-data and bundle lake-data.cjs; open LakeDatabase/LakeData/FileVault without instantiating LakeApplication, custom Agent adapters, WorkflowRunService or WorkflowSchedules. | Yes | 2026-10-03 |
| TASK-004 | After TASK-003, expose scoped native MCP data tools from the worker and attach them through the existing native CLI MCP startup contract for explicitly linked workspaces; retain native tool admission and workflow execution. | Yes | 2026-10-03 |
| TASK-005 | After TASK-003, add the bounded optional IPlatformService data method, preload IPC forwarding and a main-process data-worker adapter; do not put session or workflow state into Main. | Yes | 2026-10-03 |

### Implementation Phase 3

- **GOAL-003**: Present lake associations in the original native UI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-006 | After TASK-005, add packages/ui/src/lake/LakePanel.tsx and useLakeData.ts; list existing lakes/resources and bind native workspaces, using existing UI components and semantic theme tokens. | Yes | 2026-10-03 |
| TASK-007 | After TASK-006, reuse settings/saved-workflows components and native ZCodeAgentService saved-workflow APIs to display/launch workflows for linked lake workspaces and persist explicit native-workflow lake links. | Yes | 2026-10-03 |

### Implementation Phase 4

- **GOAL-004**: Deliver native LAKE application and CLI identities.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | Update desktop-product-identity.mjs, native runtime names, localized product strings and Agent identity without renaming protocol/package namespaces or attribution. | Yes | 2026-10-03 |
| TASK-009 | Change cmd/lake/main.go normal launch to native CLI arguments; keep explicit signed legacy secret migration. Replace scripts/build_lake_desktop.sh with source-native Electron packaging using existing native runtime-asset preparation. | Yes | 2026-10-03 |

### Implementation Phase 5

- **GOAL-005**: Verify, install and push the complete native path.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | After TASK-003 through TASK-009, test data/vault preservation, scoped associations, original workflow routing, native sessions switching during active work, background completion and approval routing with an isolated model fixture. | No | 2026-10-02 |
| TASK-011 | Run native root/CLI typecheck and lint, data tests, architecture checks, launcher Go checks and signed native build. Record existing lint failures separately. | Yes | 2026-10-03 |
| TASK-012 | After packaged runtime verification and TASK-011, install the verified app with backup, update migration documentation and commit/push codex/zcode-lake-runtime; record unavailable GUI checks separately. | No | 2026-10-02 |

## 3. Alternatives

- **ALT-001**: Continuing to implement per-conversation navigation and workflow execution in Wails conflicts with the latest user instruction and is abandoned.
- **ALT-002**: Copying native workflow definitions into LAKE workflow tables introduces duplicate state and is rejected; only association metadata is stored in LAKE.

## 4. Dependencies

- **DEP-001**: Vendored source ZCode 3.14.3, Node 24.14.0, pnpm 10.33.2 and Electron 41.0.3 already declared in the repository.
- **DEP-002**: Existing private SQLite/vault adapters with schema-20 association migration and native saved-workflow APIs.
- **DEP-003**: Persistent Lake Local Development Code Signing identity and native desktop packaging assets.

## 5. Files

- **FILE-001**: third_party/zcode/packages/shared/src/lake-data.ts and platform.ts define the client boundary.
- **FILE-002**: third_party/zcode/apps/zcode-cli/packages/lake/src/adapters/native-data holds data-worker IO and metadata persistence.
- **FILE-003**: third_party/zcode/packages/desktop/src/main, src/preload and src/renderer/src/desktopPlatform.ts hold native IPC adaptation.
- **FILE-004**: third_party/zcode/packages/ui/src/lake and useLakeData.ts hold presentation only.
- **FILE-005**: scripts/build_lake_desktop.sh, scripts/build_zcode_agent.mjs and cmd/lake/main.go hold source build and signed launch.

## 6. Testing

- **TEST-001**: Synthetic schema-19 databases retain lakes/resources/journal/history/legacy workflows; association updates survive worker restart and reject mismatched resources/workspaces.
- **TEST-002**: Native workflows list, launch and open their original run/artifact views; association metadata does not create LAKE workflow runs or invoke the former runner.
- **TEST-003**: Native desktop fixture holds task A while creating/opening task B, checks independent messages and native permissions, then returns to A and verifies its result.
- **TEST-004**: Native data/model keys remain private and never enter UI DTOs, error text or committed output; normal launch never invokes legacy Keychain reads.
- **TEST-006**: A guarded native CLI/data fixture denies original .zcode/app-data access and confirms independent LAKE storage; packaged GUI confirms overridden LAKE roots.
- **TEST-005**: Verify native original capability surfaces and packaged runtime assets; execute root/CLI typecheck/lint, scoped tests, architecture, Go launcher tests and deep signature checks.

## 7. Risks & Assumptions

- **RISK-001**: Original native capabilities can still fail on provider limits, unavailable services or missing permissions; using the original client does not guarantee all external calls succeed.
- **RISK-002**: Existing native lint max-lines failures are baseline issues and must be reported without marking them passed.
- **ASSUMPTION-001**: Existing model settings may require a controlled import into native provider preferences; credentials must travel only through native/private storage APIs.

## 8. Related Specifications / Further Reading

[Native client ownership](../third_party/zcode/.agents/specs/lake-native-client.md)
[Historical migration](../docs/migration-closure.md)
[Native UI design](../third_party/zcode/DESIGN.md)

## Verification record (2026-10-03)

Data/history/private storage: 36 passing tests. Root typecheck and CLI typecheck: passed (29 CLI packages). Root lint: 70 warnings, no errors. LAKE lint and architecture: passed. Full CLI lint: fails on existing max-lines limits, recorded separately. Go test/vet: passed.

Packaged native protocol: session B created, opened and completed while A was active; A completed and reopened. Native saved workflow completed with a Markdown artifact. Main/Host and native Scheduler startup verified. Packaged runtime probes passed under pinned Node and Electron Node; TUI import, signed installed CLI --help and deep signature verification passed. Native client installed with the previous app retained as a timestamped backup. GUI interaction checks in TASK-010 remain pending because macOS is locked and computer-use tools require manual unlock. Upstream Computer Use is an unavailable open-source placeholder, not a shipped proprietary capability.
