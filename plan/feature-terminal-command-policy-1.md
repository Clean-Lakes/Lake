---
goal: Ask progressively only for state changes and dangerous terminal commands
version: 1
date_created: 2026-10-10
last_updated: 2026-10-10
owner: Lake
status: 'Completed'
tags: [feature, terminal, approval]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Replace the six exact diagnostic templates with server-enforced command risk classification in the independent Web Agent. Ordinary read-only checks such as `vmstat 1 3` run after terminal handoff without a command approval.

## 1. Requirements & Constraints

- **REQ-001**: Recognized literal read-only commands and safe pipelines execute automatically. Terminal ownership still belongs to the user until explicitly transferred.
- **REQ-002**: Changes require one confirmation with target, full command, reason, impact and verification; dangerous commands additionally require typing the target confirmation.
- **SEC-001**: Classify full syntax and arguments on the server, independently of model or client risk claims. Unknown syntax requires confirmation; nested code execution, destruction, privilege and service disruption escalate.
- **SEC-002**: Preserve single-use approvals, terminal/context binding, takeover, strict SSH credentials, no secret logging and no replay.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Enforce risk-aware execution across both specialist collection and proposed follow-up checks.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add shared literal command parsing, risk classification, safe executable rendering and target confirmation. | Yes | 2026-10-10 |
| TASK-002 | Integrate Store, TerminalService, Coordinator and HTTP decisions; auto-start read-only proposals after handoff. Depends on TASK-001. | Yes | 2026-10-10 |

### Implementation Phase 2

- **GOAL-002**: Present progressive confirmation and verify the real flows.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Separate handoff from command approval; skip manual read-only review and escalate dangerous commands with target entry. Depends on TASK-002. | Yes | 2026-10-10 |
| TASK-004 | Run policy, PTY, HTTP and SSH regression tests, build, browser QA and document limits. Depends on TASK-003. | Yes | 2026-10-10 |

## 3. Alternatives

- **ALT-001**: Trusting a model's read-only label cannot enforce approval and is rejected.
- **ALT-002**: A blacklist alone would miss arbitrary writes; literal read-only programs and supported arguments determine automatic execution, with confirmation as the fallback.

## 4. Dependencies

- **DEP-001**: Existing Node 24.14.0 prototype, node-pty, SQLite, React and OpenSSH integration.

## 5. Files

- **FILE-001**: `web-agent/shared/{command-policy,contracts}.ts`.
- **FILE-002**: `web-agent/server/src/{terminal,terminal-specialist,store,index,coordinator}.ts`.
- **FILE-003**: `web-agent/web/src/{App.tsx,api.ts,styles.css}` and policy, terminal and HTTP tests.

## 6. Testing

- **TEST-001**: Classify `vmstat 1 3`, literals and pipelines; reject automatic writes, substitutions, dangerous flags and sensitive paths.
- **TEST-002**: Real PTY checks bypass modified PATH/functions while preserving literal arguments, working directory and recorded command text.
- **TEST-003**: HTTP tests cover automatic collection and bounded follow-up, handoff-only checks, write confirmation, missing/wrong danger confirmation, forged client risk and approval replay.
- **TEST-004**: Existing SSH, ownership, restart, scope and settings tests remain passing; browser checks cover manual read-only, write and danger flows.

## 7. Risks & Assumptions

- **RISK-001**: This is a conservative command policy rather than a universal shell sandbox. Unsupported syntax or programs require review; trusted host binaries and terminal targets remain assumptions.
- **ASSUMPTION-001**: POSIX `command -p` and standard system utilities are available. Local and remote systems may expose different commands; actual exit codes remain evidence.
- **ASSUMPTION-002**: User input into an already-running interactive program remains direct input under user ownership; this policy governs submitted complete commands and Agent execution.

## 8. Related Specifications / Further Reading

[Persistent terminal implementation](feature-terminal-specialist-1.md), [Web Agent README](../web-agent/README.md).

## Verification record (2026-10-10)

Node 24.14.0: type checking, all 28 policy/HTTP/PTY/SSH tests and production Web build passed. Browser QA with an isolated local model and data directory verified handoff-only read checks, manual read-only submission without a dialog, a single change confirmation, and dangerous-operation escalation for both manual and Agent commands. Wrong target text disabled execution, correct target text enabled it; dangerous commands were not executed through the browser. No browser errors were reported. The existing approximately 550 kB bundle advisory remains.
