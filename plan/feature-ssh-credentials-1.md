---
goal: SSH password login and local key directory selection
version: 1
date_created: 2026-10-11
last_updated: 2026-10-11
owner: Lake
status: 'Completed'
tags: [feature, ssh, credentials, go, react]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Support password authentication and user-selected local SSH keys in the existing persistent terminal and progressive authorization flow.

## 1. Requirements & Constraints

- **REQ-001**: Add password/key authentication selection to React resource creation. Browse ~/.ssh or an explicitly entered directory, exposing key filenames only.
- **REQ-002**: Copy only a selected private key into Lake secrets. Store passwords and optional key passphrases as private files; SQLite and HTTP responses contain references only.
- **REQ-003**: Reuse terminal authorization, close and recreate behavior for both authentication methods.
- **SEC-001**: Preserve strict known_hosts verification; validate ownership and file permissions; never print real keys/passwords or read Keychain.
- **CON-001**: Build bin/lake exclusively through scripts/build_lake.sh. No added runtime dependency.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Extend SSH credential handling and local directory API.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Extend internal/web/ssh.go and model.go with password/key configuration, bounded local key listing/import and private credential references. Add authenticated server.go route. | ✅ | 2026-10-11 |
| TASK-002 | Use the signed binary as OpenSSH askpass helper in cmd/lake/main.go and internal/web/terminal.go; transmit only credential reference environment variables and redact authentication secrets. Depends on TASK-001. | ✅ | 2026-10-11 |

### Implementation Phase 2

- **GOAL-002**: Expose authentication and local key selection.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Update web-agent/shared/contracts.ts, web/src/api.ts and App.tsx with password/key inputs, directory loading and optional key passphrase; clear secrets after save/close. Depends on TASK-001. | ✅ | 2026-10-11 |

### Implementation Phase 3

- **GOAL-003**: Verify and deliver signed local service.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add internal/web/ssh_credentials_test.go for listing/import security, persistence, password and encrypted-key OpenSSH authentication against isolated SSH fixtures, negative credentials and trust failure. Depends on TASK-001 and TASK-002. | ✅ | 2026-10-11 |
| TASK-005 | Run Go race/vet and React checks, signed build and browser form checks; restart idle production service and record validation. Depends on TASK-003 and TASK-004. | ✅ | 2026-10-11 |

## 3. Alternatives

- **ALT-001**: Adding sshpass was rejected to avoid another runtime dependency and command-line secrets.
- **ALT-002**: Replacing the entire OpenSSH PTY implementation was rejected because existing trusted-host and terminal lifecycle behavior can be reused.

## 4. Dependencies

- **DEP-001**: Existing OpenSSH, Go binary, private-file storage and authenticated HTTP endpoints.

## 5. Files

- **FILE-001**: internal/web/ssh.go, model.go, terminal.go, server.go and ssh_credentials_test.go; internal/ai/ssh_auth.go, types.go, runtime.go, services.go, engine.go; cmd/lake/main.go and cmd/lake-ai/main.go.
- **FILE-002**: web-agent/shared/contracts.ts, web/src/api.ts, App.tsx; docs/validation/lake-ssh-credentials.md.

## 6. Testing

- **TEST-001**: Synthetic directory lists only valid private key files, rejects insecure files and paths, and imports only selected keys with 0600 permissions.
- **TEST-002**: Synthetic password and encrypted-key SSH servers authenticate through real OpenSSH PTYs; bad credentials/unknown host fail without fallback.
- **TEST-003**: HTTP/catalog/SQLite contain no credential material; frontend clears typed secrets; signed binary builds and runtime passes.

## 7. Risks & Assumptions

- **RISK-001**: Password authentication may be disabled by a remote server; failures are bounded and do not weaken host verification.
- **ASSUMPTION-001**: Local directory means the computer running Lake. User-selected keys are copied once into private Lake storage.

## 8. Related Specifications / Further Reading

[Lake rules](../AGENTS.md)

[Session permissions](feature-session-permissions-1.md)

[OpenSSH askpass](https://man.openbsd.org/ssh#SSH_ASKPASS_REQUIRE)
