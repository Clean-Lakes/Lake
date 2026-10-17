---
goal: Reimplement HexHub AI behavior in Go and connect Lake Web Agent
version: 1.0
date_created: 2026-10-10
last_updated: 2026-10-10
owner: Lake
status: Completed
tags: [feature, go, ai, reverse-engineering]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Rebuild the recovered HexHub 5.4.1 AI contracts in Go; replace the Web coordinator with a supervised Go worker while retaining Lake terminal ownership and approvals.

## 1. Requirements & Constraints

- **REQ-001**: Implement streamed model/tool iterations, reasoning, usage, three profiles, structured references, persistence, abort, rollback, compaction and prompt presets in `internal/ai`.
- **REQ-002**: Implement all 24 recovered tools and explicit local/SSH/container runtime selection, plus file/command/web tools. Missing asset settings return capability errors, never substitute local resources.
- **SEC-001**: Keep model keys out of persisted AI state and output; use private credential references; retain strict SSH host verification and frozen approvals.
- **CON-001**: Build macOS `bin/lake` only through `scripts/build_lake.sh`; sign Go worker with the persistent Lake development identity.
- **GUD-001**: Treat extracted JavaScript and prompt constants as reverse-engineering evidence; rebuilt Go is Lake source.
- **PAT-001**: Exchange correlated JSON frames over inherited stdio; expose browser APIs only through the authenticated Lake web server.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Deliver a deterministic Go AI runtime and provider adapters.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Implement `internal/ai` engine, provider adapters, tool registry, runtime executors, persistence and `cmd/lake-ai`; preserve recovered schemas and prompt provenance. | ✅ | 2026-10-10 |
| TASK-002 | Add Go tests with isolated model servers for multi-step tools, six protocols, approvals, cancellation, restart, context limits and asset targeting. Depends on TASK-001. | ✅ | 2026-10-10 |

### Implementation Phase 2

- **GOAL-002**: Wire Go into the Lake UI and signed build.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Implement `web-agent/server/src/go-ai.ts`; route messages/settings/profile/preset/approval/history requests into Go and bridge terminal calls. Depends on TASK-001. | ✅ | 2026-10-10 |
| TASK-004 | Add streamed reasoning/operations/approval/chart views and controls in `web-agent/web/src`; support service assets and model protocol selection. Depends on TASK-003. | ✅ | 2026-10-10 |
| TASK-005 | Build signed Go worker, run Go race tests and Web check/test/build, document capability matrix and fixture validation. Depends on TASK-002 and TASK-004. | ✅ | 2026-10-10 |

## 3. Alternatives

- **ALT-001**: Embedding the HexHub binary was rejected because it provides neither maintainable Go source nor independence from HexHub runtime.
- **ALT-002**: Keeping the TypeScript coordinator was rejected because the user explicitly selected a Go AI backend.

## 4. Dependencies

- **DEP-001**: Existing Lake React UI, terminal service, SQLite store and strict OpenSSH configuration.
- **DEP-002**: Go 1.25, Node 24.14, pnpm 10.33 and the existing signing identity.

## 5. Files

- **FILE-001**: `internal/ai/`, `cmd/lake-ai/` and `docs/hexhub-ai/` contain rebuilt runtime and evidence.
- **FILE-002**: `web-agent/server/src/`, `web-agent/shared/`, `web-agent/web/src/` and build scripts integrate the runtime.

## 6. Testing

- **TEST-001**: Use local fake provider servers to verify incremental text/tool assembly and protocol conversion without real keys.
- **TEST-002**: Verify approvals cannot be reused or survive stale terminal context; cancellation and restart do not replay effects.
- **TEST-003**: Run Go race tests, Web static checks, existing regression tests, signed build and local browser smoke.

## 7. Risks & Assumptions

- **RISK-001**: Original Go source is unavailable; reconstructed behavior must be distinguished from exact binary equivalence.
- **ASSUMPTION-001**: External database/Docker/Redis access requires registered connection metadata and installed services; fixture tests cannot establish production compatibility.

## 8. Related Specifications / Further Reading

[Lake Web Agent](../web-agent/README.md)
[Recovered frontend contracts](../docs/hexhub-ai/recovered-contracts.ts)
