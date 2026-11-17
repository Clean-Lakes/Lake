---
goal: Restore authorized service configuration in migrated projects and Kubernetes connections in the TypeScript runtime
version: 1
date_created: 2026-11-17
last_updated: 2026-11-17
owner: Codex
status: In progress
tags: [resources, security, kubernetes, typescript, migration]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The TypeScript service resource path rejects every project containing a preserved Go policy, including confirmed legacy policies that explicitly allow resource management. Kubernetes appears in the existing form but its create/test path returns 501. Implement a bounded configuration adapter and the existing Kubernetes connection contract, then import the user's fourteen missing entrances through authenticated APIs without duplicating resources.

## 1. Requirements & Constraints

- **REQ-001**: Preserve existing resource IDs, credentials, directories and historical policy records. Match imports by project, resource type and explicit connection endpoint before creating a resource.
- **REQ-002**: Add Kubernetes create, edit and explicit connection testing to `LakeServiceResources`; support uploaded YAML/JSON kubeconfig or endpoint/token, context, namespace, timeout and TLS settings.
- **REQ-003**: Redis connection tests must support existing RESP2-only servers, preserve explicit ACL usernames and authenticate before PING without changing server configuration.
- **SEC-001**: Adapt only confirmed, valid legacy policies with explicit unrestricted management/read permissions. Explicit deny, ask, resource scopes, unsupported limits, recovery identity and current policy changes continue to reject unsupported operations.
- **SEC-002**: Configuration and its explicit connection test do not grant Worker execution, expand the preserved policy ResourceIDs, edit historical policy rules, or resume old operations.
- **SEC-003**: Keep kubeconfig, token and embedded certificate/private-key material in the selected Home's private secrets directory. Reject credential plugins, external file references, proxies, impersonation, YAML anchors/aliases and redirected credential requests. Never log parser source text or credentials.
- **CON-001**: Work on `codex/resource-policy-k8s` from `origin/develop`; use signed scripts and isolated test homes. Validate the fixed Dev app before integration/release. PR merges and production operations follow the explicit authorization rules in AGENTS.md.
- **GUD-001**: Reuse existing Kubernetes forms and shared AppSelect/Glyph geometry. Preserve saved credentials on metadata-only edits.
- **PAT-001**: Use the existing `LakeServiceResources` transaction, credential cleanup, revision, cancellation and private-file validation paths.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Permit already-authorized resource configuration without weakening runtime execution boundaries.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add a configuration-only legacy policy adapter in `runtime/typescript/security.ts`; validate current project/policy/recovery identity and explicit management plus probe capabilities. | ✅ | 2026-11-17 |
| TASK-002 | Replace blanket service configuration/test migration checks in `runtime/typescript/service-resources.ts` with the adapter; revalidate during I/O and before publishing its result. Keep Worker execution checks unchanged. Depends on TASK-001. | ✅ | 2026-11-17 |

### Implementation Phase 2

- **GOAL-002**: Implement the existing Kubernetes connection form contract in TypeScript.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add `runtime/typescript/kubernetes.ts` with bounded kubeconfig parsing, metadata resolution and explicit `/version` observations using native HTTP/TLS transports, cancellation and sanitized errors. | ✅ | 2026-11-17 |
| TASK-004 | Extend `LakeServiceResources` parsing, private credential storage, create/update/test and cleanup for Kubernetes; route Kubernetes through `LakeResourceManagement`. Depends on TASK-003. | ✅ | 2026-11-17 |
| TASK-005 | Restore Kubernetes edit defaults and saved-credential testing in `web-agent/web/src/serviceResourceModel.ts`, `ServiceResourceFields.tsx`, `KubernetesResourceFields.tsx` and `api.ts`. Depends on TASK-004. | ✅ | 2026-11-17 |
| TASK-006 | Pin the YAML parser in `web-agent/package.json` and lockfile, TypeScript resolution and bundled license notices. | ✅ | 2026-11-17 |

### Implementation Phase 3

- **GOAL-003**: Verify the security/connection behavior and complete authorized resource imports.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Add isolated HTTP/TLS integration tests in `runtime/typescript/service-resources.test.cjs` and Kubernetes tests for credentials, parser bounds, policy denial, cancellation, revision changes and HTTP error validation. Depends on TASK-002 and TASK-004. | ✅ | 2026-11-17 |
| TASK-008 | Run TypeScript checks, affected/full runtime suites, frontend checks/build and repository boundary checks; record the exact tested SHA. Depends on TASK-005, TASK-006 and TASK-007. | ✅ | 2026-11-17 |
| TASK-009 | Build/install with `scripts/build_lake_desktop.sh --dev --install` after normal Dev shutdown; verify the real Dev API, import missing scene-grouped resources with independent credentials, and audit duplicate endpoints and retained records. Depends on TASK-008. | | |
| TASK-010 | Create the ordinary PR targeting develop. After the repository-required merge/release authorization and verified production installation, repeat the idempotent resource import against the release Home and record final receipts. Depends on TASK-009. | | |
| TASK-011 | Fix the RESP3 handshake incompatibility found on the four actual Redis entrances. Add a RESP2-only wire regression, validate exact AUTH identity/rejected credentials and update signed Dev before repeating all fourteen probes. | | |

## 3. Alternatives

- **ALT-001**: Deleting or rewriting legacy policies would bypass explicit boundaries and destroy migration provenance; rejected.
- **ALT-002**: Inserting resources directly into the active SQLite databases would bypass host validation, credential handling and revisions; rejected.
- **ALT-003**: Calling Go or kubectl from the TypeScript connection adapter would restore a runtime dependency and permit kubeconfig execution; use native TypeScript HTTP/TLS instead.

## 4. Dependencies

- **DEP-001**: Existing Node 24.14 runtime, signed desktop build scripts and persistent Lake signing identity.
- **DEP-002**: A pinned `yaml` parser with AST traversal and alias detection; follow its official options documentation.
- **DEP-003**: User-provided/saved credentials and the already-inspected 217 proxy endpoints; no model-provider credential stores or Keychain access.

## 5. Files

- **FILE-001**: `runtime/typescript/security.ts` — configuration-only compatibility adapter.
- **FILE-002**: `runtime/typescript/kubernetes.ts` — bounded parsing and connection client.
- **FILE-003**: `runtime/typescript/service-resources.ts` — Kubernetes CRUD, secret handling and tests.
- **FILE-004**: `web-agent/web/src/serviceResourceModel.ts`, `ServiceResourceFields.tsx`, `KubernetesResourceFields.tsx`, `api.ts` — existing form/edit contract.
- **FILE-005**: `web-agent/package.json`, `web-agent/pnpm-lock.yaml`, `runtime/typescript/tsconfig.json`, `runtime/typescript/build.mjs` — dependency, types and notices.
- **FILE-006**: `runtime/typescript/service-resources.test.cjs`, Kubernetes integration tests and `web-agent/web/test/service-resources.test.ts` — regressions.
- **FILE-007**: `docs/validation/typescript-candidate/resource-policy-kubernetes.md` and `runtime/typescript/README.md` — actual scope and verification evidence.

## 6. Testing

- **TEST-001**: Valid confirmed legacy allow policy permits configuration/probing; malformed/unconfirmed/scoped/ask/deny/limited or stale recovery policies reject before networking; old policy bytes and Worker boundaries remain unchanged.
- **TEST-002**: HTTP/token and embedded kubeconfig certificate connections return only validated version/metadata; wrong CA/name, invalid auth, redirect, malformed JSON/version, oversized reply, cancellation and concurrent config/policy changes fail accurately.
- **TEST-003**: YAML aliases/anchors, extra documents, duplicate names/keys, missing references, unsupported plugins/files/proxy/impersonation and excessive size/depth fail without credential exposure or execution.
- **TEST-004**: Create/edit/rename/restart preserve exact private credentials, folder identity and revisions; failed saves/tests clean temporary secrets, and duplicate-aware imports preserve existing records.
- **TEST-005**: Real Dev and authorized production checks use separate Homes; record connection observations and every created/skipped/pending resource without secrets.

## 7. Risks & Assumptions

- **RISK-001**: Legacy policies can carry constraints absent from current adapters. Unsupported policy shapes remain closed rather than interpreted as allow.
- **RISK-002**: Existing cluster certificates may name an internal endpoint. Use the correct CA and TLS server name; do not silently disable verification.
- **RISK-003**: Dev or release may have active tasks. Inspect activity and use the supported normal stop/install workflow without terminating unrelated tasks.
- **ASSUMPTION-001**: The user authorized resource configuration in both Homes and provided the Jushan SSH login. Database/Redis/cluster credentials must be obtained from actual existing scoped configuration, not inferred from that SSH password.

## 8. Related Specifications / Further Reading

[Contribution workflow](../docs/development-workflow.md)

[Module ownership](../agent.md)

[Items/Security/Memory integration](../docs/design/items-security-memory-integration.md)

[Kubernetes Go reference](../internal/kubernetes/config.go)

[YAML parser options](https://eemeli.org/yaml/#parse-options)

2026-11-17 progress: feature `8c4c43c2` passed local suites; signed Dev integration `60b2d26e` preserves the installed baseline and passed real Kubernetes editing/testing. Six resources were added through Dev APIs, old resources/policy preserved, and the repeated plan skipped all six. Remaining service credentials and production import are pending; PR [238](https://github.com/Clean-Lakes/Lake/pull/238) targets develop. The detailed verification record distinguishes successful probes from 217 transport failures and the unverified narrow-window geometry.

PR 238 merged with the user's explicit authorization as `ae5de678ede42553edcd6778ee934d59c1305f7b`; its topic branches were cleaned up. All fourteen configuration entries now exist in Dev with ten passing actual probes. The four Redis servers reject the driver's default HELLO 3; their exact saved credentials passed direct RESP2 AUTH/PING checks. Follow-up work uses `codex/redis-resp2-compat` from that current origin/develop. It changes only the probe's protocol selection; TLS, authentication, cancellation and policy checks remain in place.
