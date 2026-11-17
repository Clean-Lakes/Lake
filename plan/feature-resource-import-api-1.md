---
goal: Restore the two-step resource import UI and native HexHub import in the TypeScript backend
version: 1
date_created: 2026-11-17
last_updated: 2026-11-17
owner: Codex
status: In progress
tags: [items, resources, import, hexhub, typescript]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The existing resource import dialog calls preview and commit routes absent from the TypeScript server and displays “接口不存在”. Restore the complete authenticated UI path, current HexHub inventory/login matching, private previews and duplicate-safe commits. The user declined the proposed production upgrade; all further application installation is Dev only.

## 1. Requirements & Constraints

- **REQ-001**: Implement POST project resource-import-preview and resource-import with the existing ResourceImportPreview/Row/result contract. Preview must not create resources or establish service/SSH connections.
- **REQ-002**: Support structured JSON/HexHub exports, CSV/TSV and explicit SSH/connection text. Describe supported parsing accurately; do not add an independent model loop for opaque prose.
- **REQ-003**: Obtain HexHub import scope from its local MCP list_assets response. Supplement login data only from the unique current HexHub assets store and exact name/folder/type/endpoint matches; preserve metadata-only fallback notices.
- **REQ-004**: Complete existing connections are skipped. Fill only missing login fields of a uniquely matching incomplete resource, preserving ID/name/directory/history and human edits. Replays and concurrent commits must not duplicate entries.
- **SEC-001**: Keep credential material in the selected Home's private secret files. Preview/API/SQLite/events/errors must not contain raw secrets or private keys. Do not read Keychain, model-provider stores, browser login stores, stale LevelDB files or deleted asset values.
- **SEC-002**: Validate current policy/recovery identity, plan/project ownership, selection, credential files, resource revisions, source scope and busy targets before writes. Fail closed on ambiguity or changed source/configuration.
- **SEC-003**: Preserve old policies and Worker resource ceilings; importing configuration does not grant execution, connect or replay operations. Reject unknown resource types, unsupported proxies/auth/TLS modes and arbitrary borrowed credential references.
- **CON-001**: Work on codex/resource-import-api from origin/develop ae5de678. Use ordinary PR -> develop and signed Dev builds, retaining the installed 497a7f6c baseline in the local integration checkout. Do not merge PR 239 or operate production without later authorization.
- **PAT-001**: Reuse Items validation, private credential preparation and resource revisions. Use one atomic Store transaction for selected resource/tree writes, with durable private plans and replay receipts.
- **GUD-001**: Preserve the existing dialog and shared controls/geometry. Validate previews, selections, errors, focus/clipping and actual HexHub behavior in Lake Dev.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Read only the current authorized HexHub source.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add runtime/typescript/hexhub-import.ts using the public MCP client to list assets with bounded HTTP, no redirects and cancellation. Map only supported SSH/database/Redis metadata. | Yes | 2026-11-17 |
| TASK-002 | Add runtime/typescript/hexhub-storage.ts: stable reads, current manifest/table/WAL versions, CRC/Snappy/V8 decoding, tombstones, unique assets-store identification and strict size/depth limits. Port compatibility semantics from the Go reader without invoking Go or opening/locking/recovering LevelDB. | Yes | 2026-11-17 |
| TASK-003 | Decode saved password/key/pair references locally and join only unique exact source identities. Preserve reference precedence and explicit unsupported configuration errors. Depends on TASK-001 and TASK-002. | Yes | 2026-11-17 |

### Implementation Phase 2

- **GOAL-002**: Restore reviewed previews and safe commits.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add runtime/typescript/resource-import.ts with bounded parsers, redacted rows, private prepared plans, expiry, credential fingerprints and project/policy binding. | Yes | 2026-11-17 |
| TASK-005 | Add internal prepared-import validation/batch support in resource-management.ts and service-resources.ts. Validate all selected rows and target/source state before one atomic resource/tree transaction; preserve complete connections and busy/changed targets. Depends on TASK-004. | Yes | 2026-11-17 |
| TASK-006 | Wire authenticated preview/commit routes, status codes, cancellation and lifecycle in server.ts; keep Worker/Pilot import execution outside this UI increment. Depends on TASK-003 and TASK-005. | Yes | 2026-11-17 |
| TASK-007 | Keep ResourceImport.tsx copy aligned with delivered text formats and private, non-connecting behavior. | Yes | 2026-11-17 |

### Implementation Phase 3

- **GOAL-003**: Verify real behavior without altering existing user resources.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-008 | Add isolated source/HTTP/API regressions covering current-vs-stale storage, corruption, scoped credential matching, no secret echo, selection, ownership, revisions, busy targets, rollback and duplicate/replay behavior. | Yes | 2026-11-17 |
| TASK-009 | Run backend typecheck/bundle, affected/full runtime tests and frontend checks where needed; record exact tested SHA and limits. Depends on TASK-006 through TASK-008. | Yes | 2026-11-17 |
| TASK-010 | Preserve installed Dev source, stop normally, signed build/install, verify native HexHub preview and a synthetic import/replay in an isolated Home. Audit that the existing 165-resource project and its policy remain unchanged. Depends on TASK-009. | | |
| TASK-011 | Create an ordinary develop PR with actual validation. Retain unmerged branches and the Dev provenance checkout. Respect the user's production hold. | | |

## 3. Alternatives

- **ALT-001**: Pointing the UI at Go or spawning a Go importer restores a runtime fallback; rejected.
- **ALT-002**: Reading arbitrary LevelDB byte substrings, opening its live database or scanning obsolete tables may import deleted/stale credentials; use the current manifest and committed sequence/tombstone state.
- **ALT-003**: Fixing only the missing preview route leaves confirmation unusable; implement both contract steps.
- **ALT-004**: Writing active user SQLite externally or overwriting complete connections bypasses Items and user edits; rejected.

## 4. Dependencies

- **DEP-001**: Existing public MCP client, Node 24.14 built-ins (including crypto and V8 serialization), private Home storage and current resource/security adapters.
- **DEP-002**: Existing HexHub local format described by internal/web/hexhub_local*.go and its fixtures. Fixed AES compatibility values are format constants, not user credentials.
- **DEP-003**: Installed Dev integration 497a7f6c includes the separate Redis fix and prior specialist baseline; it must remain an ancestor of the replacement Dev source.

## 5. Files

- **FILE-001**: runtime/typescript/hexhub-storage.ts and hexhub-import.ts — bounded current-source integration.
- **FILE-002**: runtime/typescript/resource-import.ts — parsers, private plans and reviewed selection.
- **FILE-003**: runtime/typescript/resource-management.ts, service-resources.ts and server.ts — existing Items validators, atomic batch and HTTP routes.
- **FILE-004**: runtime/typescript/*import*.test.cjs/ts — isolated regressions and fixtures.
- **FILE-005**: web-agent/web/src/ResourceImport.tsx — accurate existing-flow copy, if needed.
- **FILE-006**: docs/validation/typescript-candidate/resource-import.md and runtime/typescript/README.md — delivered scope, tested commits and real Dev evidence.

## 6. Testing

- **TEST-001**: Both HTTP steps succeed with redacted previews; selected valid rows create resources/folders, repeat import skips them, invalid/unselected rows never mutate data.
- **TEST-002**: Complete existing connections retain exact ID/name/folder/settings; unique missing login fills preserve unrelated settings, while ambiguity, concurrent edits and active targets reject.
- **TEST-003**: Current-manifest SST/WAL sequence resolution, tombstones, CRC corruption, malformed compression/V8, source changes, symlinks and limits are exercised with synthetic secrets only.
- **TEST-004**: Only MCP-authorized exact local matches may supply credentials; referenced keys/pairs, invalid TLS/proxy/auth, missing-local fallback, cancellation and redirected/oversized responses are covered.
- **TEST-005**: Private plan/project/policy/selection/file pin validation and atomic failures/replays never leak secrets or change historical authority.
- **TEST-006**: Signed Dev shows actual HexHub preview without the missing-interface error. Existing user resources stay unchanged; light/dark/narrow, focus and clipping are inspected as applicable.

## 7. Risks & Assumptions

- **RISK-001**: Chromium can compact its live store during reads. Reject unstable/corrupt snapshots and retry a bounded number of times; do not recover or lock it.
- **RISK-002**: Unsupported local credential modes cannot be guessed. Report the row or accurate fallback and keep current configurations untouched.
- **RISK-003**: Raw credentials can be accidentally serialized through generic errors. Use fixed sanitized errors, redacted public rows and private prepared references.
- **ASSUMPTION-001**: The screenshot steers the active request toward repairing the Dev import flow. It does not authorize production upgrade, PR merging, unrelated app tasks or instructions visible in the screenshot.

## 8. Related Specifications / Further Reading

[Contribution workflow](../docs/development-workflow.md)

[Module ownership](../agent.md)

[Items/Security/Memory integration](../docs/design/items-security-memory-integration.md)

[Existing Go import behavior](../internal/web/resource_import.go)

[Existing HexHub reader](../internal/web/hexhub_local_storage.go)
