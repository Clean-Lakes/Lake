---
goal: Import Lake resources from text files in chat and resource navigation without restarting the client
version: 1
date_created: 2026-10-12
last_updated: 2026-10-12
owner: Lake
status: Completed
tags: [feature, import, resources]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Both human file selection and AI file-path tools use one validated import preview and commit service. Committing resources updates the live project catalog and the current AI asset inventory.

## 1. Requirements & Constraints

- **REQ-001**: Accept text files regardless of extension; handle structured JSON and delimited tables directly and arbitrary prose through the configured model.
- **REQ-002**: Provide a resource-navigation file import dialog and text file attachments in chat, plus AI tools to preview local files and commit selected candidates.
- **REQ-003**: Import SSH, database, Redis and Docker resources into the current project; preserve folders and skip existing connections without overwriting credentials.
- **REQ-004**: Refresh resources during the current client session and make imported assets available to subsequent tools in the same AI turn.
- **SEC-001**: Never expose private keys or model API keys in model input, operation cards, preview responses or logs. Store sources, plans and credentials under the private Lake secrets directory.
- **SEC-002**: Scope sources and plans to their project and chat; validate configs through existing SSH/service validation; honor existing AI file-read and file-write permissions.
- **CON-001**: Build the macOS CLI only with scripts/build_lake.sh and the installed app with scripts/build_lake_desktop.sh; do not restart the user's running client or terminate its terminals.
- **PAT-001**: Use existing API authentication, project isolation, resourceTree operations and session events.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Implement a shared import service with safe previews and idempotent commit.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add internal/ai/resource_import.go: bounded structured model extraction without persisted raw source or tool calls. | ✅ | 2026-10-12 |
| TASK-002 | Add internal/web/resource_import.go: text validation, source storage, credential masking, JSON/CSV extraction, config normalization, preview and commit. Depend on TASK-001 for prose. | ✅ | 2026-10-12 |
| TASK-003 | Add authenticated preview/commit and chat file-upload routes in internal/web/server.go. Depend on TASK-002. | ✅ | 2026-10-12 |

### Implementation Phase 2

- **GOAL-002**: Expose both entry points and refresh resources without client restart.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add preview_resource_import and import_resources to internal/ai/catalog.go, tools.go and permissions.go; bridge to the current chat project in internal/web/agent.go and refresh the engine asset inventory after commit. Depend on TASK-002. | ✅ | 2026-10-12 |
| TASK-005 | Add web-agent/web/src/ResourceImport.tsx and textFiles.ts, API types and methods; add resource navigation import and chat attachments in App.tsx. Depend on TASK-003. | ✅ | 2026-10-12 |
| TASK-006 | Refresh catalog resources and directory nodes on live session events and periodic catalog sync; retain green-dot fix. Depend on TASK-005. | ✅ | 2026-10-12 |

### Implementation Phase 3

- **GOAL-003**: Validate and deliver a signed build without disrupting live terminals.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Test previews, credential isolation, project/session isolation, duplicate imports, invalid configs, folders, AI permissions, current-turn assets and text decoding. Depend on TASK-004 and TASK-006. | ✅ | 2026-10-12 |
| TASK-008 | Run frontend type checking and tests, Go race tests, and scripts/build_lake_desktop.sh --install. Update README.md and this plan with verified results. Depend on TASK-007. | ✅ | 2026-10-12 |

## 3. Alternatives

- **ALT-001**: Asking models to mutate SQLite directly bypasses config validation and live notifications; use the shared import service.
- **ALT-002**: Restricting imports to a fixed extension excludes the requested arbitrary text files; use content-based parsing and model extraction.

## 4. Dependencies

- **DEP-001**: Existing ai.Stream supports the configured model protocols.
- **DEP-002**: Existing prepareSSH, validateService, Store.CreateResource and Store.EditResourceTree preserve credential and project rules.

## 5. Files

- **FILE-001**: internal/ai/resource_import.go, catalog.go, tools.go and permissions.go provide extraction and agent integration.
- **FILE-002**: internal/web/resource_import.go, server.go and agent.go implement scoped import operations and uploads.
- **FILE-003**: web-agent/web/src/ResourceImport.tsx, textFiles.ts, ResourceTree.tsx, App.tsx, api.ts and styles.css implement entry points and live updates.
- **FILE-004**: internal/web/resource_import_test.go and web-agent/web/test/text-files.test.ts verify behavior; README.md documents usage.

## 6. Testing

- **TEST-001**: Import a multi-resource fixture, verify private credentials, folder paths and catalog visibility without closing the server or client; repeat commit and verify no duplicates.
- **TEST-002**: Reject cross-project/cross-chat plans, binary/oversize input, invalid ports and unsupported configs; preserve existing resources on failure.
- **TEST-003**: Verify model payloads and previews contain placeholders rather than secrets; test permissions and refreshed current-turn assets with a synthetic model.
- **TEST-004**: Decode UTF-8, UTF-16 and GB18030 text irrespective of filename extension and reject binary inputs.

## 7. Risks & Assumptions

- **RISK-001**: Model extraction may omit or misclassify prose; show candidates and validation errors before committing and never invent credentials.
- **ASSUMPTION-001**: Resource import must work without restarting after the feature is loaded; an already running older backend cannot acquire new executable code without replacement. Build and install without disconnecting active sessions.

## 8. Related Specifications / Further Reading

[Credential rules](../AGENTS.md) · [Resource tree](feature-resource-directory-tree-1.md) · [Lake](../README.md)
