---
goal: Publish the user-authorized current TypeScript backend as Lake 0.3.28 for macOS arm64
version: 1
date_created: 2026-11-08
last_updated: 2026-11-08
owner: Lake maintainers
status: 'In progress'
tags: [release, typescript, macos, migration]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The user explicitly requested merging all PRs into develop, a macOS-only production release, and then selected the current TypeScript backend after being informed of its incomplete parity. This supersedes the previous Dev-only distribution restriction for this release, without claiming that missing features or the parity matrix have passed. PRs #197–#199 are merged; the integration base is `b0802ba96bb87ff7c8b66427bd71b7158c9feea0`.

## 1. Requirements & Constraints

- **REQ-001**: The macOS package uses the actual TypeScript SEA and matching lake-runtime resources; its version matches VERSION and the updater's `Lake <version> ` contract.
- **REQ-002**: Pilot's existing identity, tasks, acceptance, grants and unread state retain their current implementations; distribution promotion does not create another execution loop.
- **SEC-001**: Admit the release Home only through an explicit production profile. Dev cannot access release data, production cannot access Dev data, and mixed profiles are rejected before creating files.
- **SEC-002**: Migrate only the selected Home's legacy public settings/identity/history and credential references. Preserve original databases, security gates and unknown operations. Do not read Keychain or copy credentials across Homes.
- **CON-001**: All source/version changes use a topic PR to develop. Production promotion uses develop-to-master with checks, followed by signed packages from the exact master commit. Do not install or restart the user's production app.
- **CON-002**: Publish only macOS arm64 ZIP/DMG and their SHA-256 files. Keep unsupported features and incomplete parity explicit.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Implement explicit production distribution and isolated migration behavior.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add profile validation in runtime/typescript/runtime-profile.ts; wire ServerOptions.production and --production in server.ts without changing Security decisions. | Yes | 2026-11-08 |
| TASK-002 | Enable the existing same-Home provider/catalog migration for production and verify original legacy inputs remain unchanged and old work is not replayed. | Yes | 2026-11-08 |
| TASK-003 | Add a neutral signed TypeScript build entry, embed VERSION and make macOS packaging use TypeScript by default with standard release asset names. | Yes | 2026-11-08 |
| TASK-004 | Update DesktopProfile and Backend launch arguments so release metadata selects TypeScript and passes production, while Dev keeps dev isolation. Verify updater preparation and rollback on migration failure. | Yes | 2026-11-08 |

### Implementation Phase 2

- **GOAL-002**: Validate, integrate and publish the exact authorized macOS release.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Add pure profile, isolated production migration and native distribution tests; run source/server/frontend suites, signing/package/installer checks and an isolated real packaged backend smoke test. | Yes | 2026-11-08 |
| TASK-006 | Prepare VERSION 0.3.28, truthful macOS release notes and validation/rollback documentation; preserve parity diagnostic status and merge the preparation PR into develop. Depends on TASK-005. | Yes | 2026-11-08 |
| TASK-007 | Create develop-to-master release PR, satisfy its checks/review requirements, merge with a merge commit, and verify final source. Depends on TASK-006. | No | 2026-11-08 |
| TASK-008 | Build from clean master, verify ZIP/DMG/signatures/checksums and publish v0.3.28 with only four macOS assets. Verify downloaded assets and release target. Depends on TASK-007. | No | 2026-11-08 |

## 3. Alternatives

- **ALT-001**: Publishing the old Go package was rejected by the user's explicit current-TypeScript selection.
- **ALT-002**: Removing all Home guards or importing Dev data into production is rejected; explicit distribution profiles preserve isolation.

## 4. Dependencies

- **DEP-001**: Existing pinned Node 24.14.0, Agent SDK, pnpm, persistent Lake signing identity, and authenticated authorized GitHub account.
- **DEP-002**: Existing read-only/transactional legacy importers, security gate and updater rollback machinery; retain their ownership contracts.

## 5. Files

- **FILE-001**: runtime/typescript/server.ts, runtime-profile.ts, runtime-profile.test.ts, dev-settings.ts, build.mjs and server.test.cjs.
- **FILE-002**: scripts/build_lake.sh, build_lake_typescript.sh, build_lake_ts_candidate.sh, build_lake_desktop.sh and release verification/tests.
- **FILE-003**: client/macos/Sources/LakeUpdateCore/DesktopProfile.swift, LakeDesktop/Backend.swift, Resources/install-update.sh and associated tests.
- **FILE-004**: VERSION, client/macos/RELEASE_NOTES.md, agent.md, CONTRIBUTING.md, runtime/typescript/README.md, client/macos/README.md and release validation documentation.

## 6. Testing

- **TEST-001**: Production/Dev/candidate Home admission, cross-profile rejection and mixed-flag rejection with synthetic paths; no real production Home writes.
- **TEST-002**: Isolated legacy provider/history import in production, idempotence, preserved original databases and zero resumed model/tool work.
- **TEST-003**: macOS bundle runtime/arguments/version compatibility, signed SEA/native resources, package extraction and migration-error rollback.
- **TEST-004**: Full TypeScript and frontend suites, native update/window tests, Dev path guards and production PR automatic verification.

## 7. Risks & Assumptions

- **RISK-001**: Current TypeScript does not implement every legacy API. Release notes must identify these limits; publishing does not mark parity verified.
- **RISK-002**: Large legacy history can exceed the native startup deadline. Preparation must be bounded and rollback must preserve original databases and unresolved operations.
- **ASSUMPTION-001**: This release targets Apple Silicon macOS 13.5+ using the existing persistent signing certificate; Windows is not published.

## 8. Related Specifications / Further Reading

[Contribution workflow](../docs/development-workflow.md), [architecture ownership](../agent.md), [TypeScript boundaries](../runtime/typescript/README.md), [security](../docs/design/lake-security-v1.md), [TS layered memory](../docs/design/typescript-layered-memory.md).
