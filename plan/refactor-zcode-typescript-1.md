---
goal: Move the complete Lake operations backend into the ZCode TypeScript source
version: 1
date_created: 2026-10-01
last_updated: 2026-10-02
owner: Lake
status: In progress
tags: [refactor, architecture, migration, typescript]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The existing Lake frontend remains the user interface. Following the user's 2026-10-02 clarification, `@zcode/lake` owns only Lake operations data and operations workflows. Agent sessions, context compaction, code tools, terminals, subagents, Skills, plugins, MCP and generic automation use ZCode's existing implementations. Go remains the signed launcher and native desktop presentation bridge.

## 1. Requirements & Constraints

- **REQ-001**: Remove Eino from both runtime and build dependencies; use TypeScript for every operations service.
- **REQ-002**: Preserve all existing SQLite schema-version-19 tables, records, private file data, configuration and frontend method signatures.
- **REQ-003**: Preserve Lake resources and operations workflows; connect the current frontend to native ZCode sessions/tools/terminals/subagents/extensions. Preserve historical Lake metadata without adding parallel implementations of these services.
- **REQ-004**: Remove Lake-owned Agent, context, terminal, code editing, specialist and extension engines. Native ZCode is the sole owner of these capabilities.
- **SEC-001**: Store credentials only in the private file vault; reject symlinks and permissive permissions; never expose credentials to the frontend, events, diagnostics or source control.
- **SEC-002**: Freeze task targets; approve before dispatch; revalidate authorization after approval; append audit records; never automatically replay a dispatched command with unknown outcome.
- **CON-001**: Build user-facing macOS launchers only with `scripts/build_lake.sh` using the persistent signing identity.
- **CON-002**: Existing frontend source and data stay compatible. Native file dialogs, media presentation and signed Keychain migration are desktop boundary concerns.
- **PAT-001**: Domain is pure; application services use typed ports; adapters own SQLite, filesystem, subprocess, network and ZCode integration.

## 2. Implementation Steps

- **GOAL-001**: Define the ownership and compatibility contract before implementing the new backend.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add `third_party/zcode/.agents/specs/lake-typescript.md`, register managed module lake in `architecture-policy.yaml`, and provide `module.ts`, `contract.ts`, `contract.example.ts`, `CONTRACT.md`. | ✅ | 2026-10-01 |
| TASK-002 | Inventory old CLI, SQLite migrations and frontend methods; record fixtures and exact compatibility assertions in the new package tests. Depends on TASK-001. | ✅ | 2026-10-02 |

- **GOAL-002**: Implement all operations services in TypeScript with one data owner.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Implement `packages/lake/src/adapters/storage` with schema 1–19 migrations and repositories; verify synthetic legacy databases before any launcher switch. Depends on TASK-002. | ✅ | 2026-10-02 |
| TASK-004 | Implement vault, settings, authorization, process/SSH/Kubernetes/database execution and append-only journal adapters. Depends on TASK-003. | ✅ | 2026-10-02 |
| TASK-005 | Implement Lake operations workflow execution and workflow schedules; adapt frontend methods to ZCode native session, file, execution and extension APIs. Depends on TASK-004. | ✅ | 2026-10-02 |
| TASK-006 | Connect ZCode's public agent interface to TypeScript Lake tools, event persistence, approval and cancellation. Depends on TASK-005. | ✅ | 2026-10-02 |

- **GOAL-003**: Replace the Go backend, verify and deliver the source migration.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Replace `cmd/lake` with a signed launcher and remove desktop business logic in favor of typed TypeScript commands; remove Eino source/dependencies only after compatibility tests pass. Depends on TASK-006. | ✅ | 2026-10-02 |
| TASK-008 | Update source/runtime build and release checks; run managed architecture checks, ZCode root/CLI typecheck and lint, frontend tests/build, signed desktop tests and end-to-end fixture execution. Depends on TASK-007. | ✅ | 2026-10-02 |
| TASK-009 | Update migration/startup documentation, create feature commits and push `codex/zcode-lake-runtime`; mark complete only after all requirements pass. Depends on TASK-008. | | |

## 3. Alternatives

- **ALT-001**: Retain the Go/SQLite backend under a ZCode wrapper. Rejected by the explicit requirement to rewrite all operations services in TypeScript.
- **ALT-002**: Adopt the ZCode frontend. Rejected because the user requires the current frontend.

## 4. Dependencies

- **DEP-001**: Pinned ZCode source at `29628c9acdb81b703bbd4080c207a0e7ce5e276e`, Node 24.14.0 and pnpm 10.33.2.
- **DEP-002**: Node SQLite, ZCode public bootstrap/contracts and native process/SSH adapters.
- **DEP-003**: Existing Wails desktop shell and Lake local signing identity.

## 5. Files

- **FILE-001**: `third_party/zcode/apps/zcode-cli/packages/lake/` owns Lake operations data/workflows and the native ZCode protocol adapters.
- **FILE-002**: `third_party/zcode/architecture-policy.yaml`, CLI entry and workspace lockfile register/build the managed package.
- **FILE-003**: `cmd/lake/`, `client/desktop/` and `go.mod` become launcher/presentation code without Eino or data ownership.
- **FILE-004**: `scripts/build_lake*.sh`, `scripts/build_zcode_agent.mjs`, release verification and migration/startup docs record the TypeScript runtime.

## 6. Testing

- **TEST-001**: Open synthetic schema 1–19 databases, verify lake/resources/history/workflows/executions remain readable, preserve journal immutability and reject unsupported future schemas.
- **TEST-002**: Test vault permissions/symlinks and credential redaction; no test uses real credentials.
- **TEST-003**: Execute selected fixture lake → host query → fixed read-only check → approval/result → journal; denied or revoked authorization dispatches nothing.
- **TEST-004**: Exercise every current frontend method and terminal/workflow cancellation, event order, stale results and dispatched-unknown recovery.
- **TEST-005**: Run source architecture, typecheck, lint, package tests, frontend verification and signed macOS build; assert Eino is absent from launcher's dependencies and process graph.

## 7. Risks & Assumptions

- **RISK-001**: Backend migration is broader than agent replacement; unsupported legacy actions must remain visible in the plan until implemented and tested.
- **RISK-002**: Migration bugs could damage history; use synthetic fixtures and private pre-migration backups, and preserve schema 19 rather than introduce unrelated changes.
- **ASSUMPTION-001**: Go may remain for signed startup, native desktop dialogs/event transport and the explicit signed legacy Keychain migration; all operations policy and storage run in TypeScript.

## 8. Related Specifications / Further Reading

- [ZCode architecture policy](../third_party/zcode/architecture-policy.yaml)
- [Managed Lake specification](../third_party/zcode/.agents/specs/lake-typescript.md)
- [Previous runtime integration](../docs/zcode-runtime.md)

Progress evidence: Eino source and runtime dependencies are removed. The signed launcher and desktop bridge now use the source-built TypeScript runtime. `test/desktop-methods.json` and the Go reflection test cover 75 desktop methods. Synthetic regression covers schema 1–19, vault, selected-lake operations, approvals, journal, native sessions/tools/MCP/PTY, workflow recovery and scheduler leases/grants. Final signed release verification passed: backend 58/58, native SSH integration 1/1, frontend 38/38, 75 desktop method signatures, Go test/vet and desktop race checks, root/CLI typecheck, Lake lint (0 warnings/errors), changed managed architecture (0 violations), and strict desktop/launcher signature checks. Root lint retains 70 upstream warnings; full CLI lint has upstream max-lines errors. The Mac was locked, so desktop click inspection could not be completed. Real remote deployments/models/connectors and native browser/CUA host interaction are outside the verified boundary. Branch push remains pending.

Scope correction (2026-10-02): user explicitly requires every capability except the Lake data layer and operations workflows to use ZCode built-ins. Custom TypeScript context/compaction, code editing/checkpoints, specialist/checkpoints and UI session engines created during migration are withdrawn. Previously committed Lake terminal/task and extension engines have been replaced by native ZCode APIs. The specialist form edits only the supported native profile adapter fields; old custom execution settings remain historical configuration. Legacy metadata repositories remain for data compatibility, not as active competing runtimes.
