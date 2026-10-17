---
goal: Add a terminal specialist with persistent local and SSH shells, user takeover and per-action approval
version: 1
date_created: 2026-10-10
last_updated: 2026-10-10
owner: Lake
status: 'Completed'
tags: [feature, terminal, specialist, ssh]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Implement persistent terminals in the independent `web-agent/` prototype and dispatch a terminal specialist before host/log analysis.

## 1. Requirements & Constraints

- **REQ-001**: Local and SSH terminals preserve working directory and exported variables across commands; output, connection state and command outcomes belong to the work session.
- **REQ-002**: The main agent dispatches the terminal specialist to collect evidence, including sessions with no recorded commands.
- **REQ-003**: Users can take control during an Agent command and supply interactive input; no further Agent input is accepted after takeover.
- **SEC-001**: Only fixed server-owned diagnostic commands may execute automatically while an Agent owns the terminal. Every other Agent command needs a single-use approval bound to terminal and shell context version.
- **SEC-002**: SSH uses explicit host/user/port, strict known-host checking, file credentials under `~/.lake/secrets/`, and no Keychain or private-key content reads by Lake.
- **CON-001**: Reuse node-pty and the system OpenSSH client; restart marks all lost processes disconnected and in-flight results unknown without replay.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Provide persistent execution and safe connection metadata.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Extend `shared/contracts.ts` and migrate `server/src/store.ts` for SSH resources, connecting state, terminal output and approval context. | Yes | 2026-10-10 |
| TASK-002 | Replace `server/src/terminal.ts` command-scoped processes with persistent PTYs, framed results, bounded output, SSH startup, input, resizing, interruption and takeover. Depends on TASK-001. | Yes | 2026-10-10 |

### Implementation Phase 2

- **GOAL-002**: Connect specialist orchestration, API and browser controls.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Add `server/src/terminal-specialist.ts`; integrate `Coordinator.runTurn` and approval follow-up. Limit collection to three commands and validate resource IDs in the executor. Depends on TASK-002. | Yes | 2026-10-10 |
| TASK-004 | Extend `server/src/index.ts`, `web/src/api.ts`, `App.tsx` and `TerminalPane.tsx` with SSH creation, ownership, interactive input and persistent-terminal display. Depends on TASK-002. | Yes | 2026-10-10 |
| TASK-005 | Run type checking, integration tests and Web build; update `web-agent/README.md` with usage and verified limitations. Depends on TASK-003 and TASK-004. | Yes | 2026-10-10 |

## 3. Alternatives

- **ALT-001**: Separate SSH library would add an authentication stack; use OpenSSH with an explicit configuration instead.
- **ALT-002**: Free-form model classification of read-only commands cannot enforce approval; fixed diagnostic templates determine automatic execution.

## 4. Dependencies

- **DEP-001**: Node 24.14.0, pnpm 10.33.4 and installed node-pty native module.
- **DEP-002**: OpenSSH client and a trusted host entry plus private file credential for remote targets.

## 5. Files

- **FILE-001**: `web-agent/server/src/{terminal,terminal-specialist,coordinator,store,index}.ts` and `shared/contracts.ts`.
- **FILE-002**: `web-agent/web/src/{App,TerminalPane}.tsx`, `api.ts`, tests and README.

## 6. Testing

- **TEST-001**: Real local PTY integration verifies state persistence, streaming, interactive input, interruption and ownership exclusion.
- **TEST-002**: SSH fixture verifies real authenticated transport and persistent remote state; invalid host/key configuration and authentication failure never fall back to local execution.
- **TEST-003**: Mock-model HTTP tests verify initial collection, evidence, fixed diagnostic enforcement, single-use/stale approval rejection and user takeover.
- **TEST-004**: Existing model settings, event replay, session scope, deletion and restart tests remain passing.

## 7. Risks & Assumptions

- **RISK-001**: A user-approved command can exit or replace the shell; such results become unknown and the terminal is disconnected rather than replayed.
- **RISK-002**: PTY framing is a command-completion mechanism, not an authentication boundary against a malicious remote host.
- **ASSUMPTION-001**: Remote targets provide a POSIX `/bin/sh` and `stty`; SSH passwords and host-key enrollment are outside this change.

## 8. Related Specifications / Further Reading

[Product proposal](product-lake-web-agent-v1.md), [OpenSSH manual](https://man.openbsd.org/ssh), [OpenSSH configuration](https://man.openbsd.org/ssh_config).

## Verification record (2026-10-10)

Node 24.14.0: type checking, all 22 tests and production Web build passed. A real temporary OpenSSH server verified remote state persistence and rejection of an untrusted host. Browser QA verified persistent local state across commands and refresh, and the terminal drawer in the conversation. Only isolated data and synthetic SSH credentials were used; no live remote resource was contacted. Vite reports the existing large-bundle advisory (approximately 544 kB JS before gzip).
