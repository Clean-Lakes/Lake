---
goal: Enable creation of six service resource types in Lake Dev
version: 1
date_created: 2026-11-06
last_updated: 2026-11-06
owner: Lake
status: 'In progress'
tags: [feature, items, resources, zcode]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

Enable MySQL, PostgreSQL, Redis, APISIX, Prometheus and VictoriaMetrics creation with validated configuration, private credentials and explicit connection checks in the TS candidate.

## 1. Requirements & Constraints

- **REQ-001**: Enable the six existing resource choices and retain project/parent-directory identity.
- **REQ-002**: Save/edit configuration without contacting its endpoint; only an explicit connection-test action performs a bounded read-only probe.
- **SEC-001**: Store secrets only in private current-Home files. Never return credential values, raw server errors or response bodies to UI/model/logs.
- **SEC-002**: Reject unknown configuration fields, unsafe credential references, endpoint userinfo/query/fragment, credential-forwarding redirects and stale saved tests.
- **CON-001**: Items owns configuration and revisions; successful configuration or a connection probe grants no task permission or acceptance. Preserve existing tasks and operation ledgers.
- **GUD-001**: Use shared AppSelect/Glyph and existing field geometry; clear secrets and obsolete test results on changes, type switches and dismissal.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Implement six service configuration lifecycles and explicit bounded probes.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add runtime/zcode/service-resources.ts with validated per-kind settings, scoped private credentials, prepare/rollback and connection tests. | Yes | 2026-11-06 |
| TASK-002 | Integrate resource creation/edit/test endpoints in runtime/zcode/server.ts and connection revision updates. Depends on TASK-001. | Yes | 2026-11-06 |
| TASK-003 | Enable choices in web-agent/web/src/App.tsx and add explicit cancellable tests to ServiceResourceFields.tsx and api.ts. Depends on TASK-002. | Yes | 2026-11-06 |

### Implementation Phase 2

- **GOAL-002**: Validate persistence, credentials, actual protocol probes and native UI.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add service lifecycle/HTTP tests and frontend draft/render tests, run full relevant frontend/backend/type/build checks. Depends on TASK-003. | Yes | 2026-11-06 |
| TASK-005 | Update docs/ui-guidelines.md, install signed Lake Dev from a clean code SHA, verify light/dark/narrow creation forms and preserve actual task records; open develop PR. Depends on TASK-004. | | |

## 3. Alternatives

- **ALT-001**: Enabling only dropdown options is rejected because the TS backend currently rejects five of the requested types.
- **ALT-002**: Saving credentials inline or using arbitrary Shell for connection tests is rejected; use typed protocol clients and HTTP probes.

## 4. Dependencies

- **DEP-001**: Existing LakeMySQL, private Home storage, LakeSecurity, resource tree and shared UI.
- **DEP-002**: Pin PostgreSQL/Redis protocol clients with bundled licenses; no production service deployment or live user database changes.

## 5. Files

- **FILE-001**: runtime/zcode/service-resources.ts and server.ts own registration and explicit probes.
- **FILE-002**: ServiceResourceFields.tsx, serviceResourceModel.ts, App.tsx and api.ts own the user flow.
- **FILE-003**: runtime/zcode/service-resources.test.cjs, server.test.cjs and web frontend tests cover actual boundaries.

## 6. Testing

- **TEST-001**: Each kind can be created under a project folder and survives restart; invalid creation leaves no resource, tree leaf or secret file.
- **TEST-002**: Credential edits retain or explicitly clear credentials, increment configuration revisions, never expose plaintext and reject foreign/symlink references.
- **TEST-003**: Explicit probes use only fixed reads, bounded timeout/body size and exact current endpoint; redirects cannot forward authentication and stale results cannot mark edited settings successful.
- **TEST-004**: Native Dev forms remain usable in light/dark and narrow windows; cancelling never saves draft resources or secrets.

## 7. Risks & Assumptions

- **RISK-001**: TLS/auth/network errors are real failures, not proof of server health; report the tested protocol without claiming business availability.
- **ASSUMPTION-001**: User requested enabling resource creation, not adding sample servers or deploying services; all automated tests use isolated synthetic resources.

## 8. Related Specifications / Further Reading

- [Contribution workflow](../CONTRIBUTING.md)
- [Ownership](../agent.md)
- [Items integration](../docs/design/items-security-memory-integration.md)
- [UI guidelines](../docs/ui-guidelines.md)
