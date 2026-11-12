---
goal: Persist a random available Agent and model when Pilot creates a specialist without explicit choices
version: 1
date_created: 2026-11-12
last_updated: 2026-11-12
owner: Lake
status: 'Completed'
tags: [feature, specialist, model, acp]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-green)

Pilot creates each specialist with one saved execution/model selection. Omitted choices are randomized by the host from configured native models and the ready Codex adapter's compatible model, rather than chosen by the routing model or rerolled on execution.

## 1. Requirements & Constraints

- **REQ-001**: On new explicit or implicit specialist creation, choose an eligible Agent uniformly, then a compatible eligible model uniformly. Honor an explicit Agent, model, or both; fail atomically if no compatible configured combination exists.
- **REQ-002**: Persist the choice in the specialist execution reference; replay of the same admitted creation returns the original receipt. Existing roles, appearance-only updates and frozen Workers never reroll.
- **REQ-003**: Native Workers use the saved provider/model without changing global/Pilot selection. Codex receives the saved model as a process-local override; content-addressed launchers prevent concurrent specialist configurations from overwriting each other.
- **REQ-004**: Pilot can discover eligible execution options and explicitly set a role model; creation replies use the actual saved receipt. Missing choices on update stay unchanged.
- **SEC-001**: Preserve current credentials, model/provider enabled flags, pinned Codex catalog, local authentication, max/reasoning settings, managed tool isolation, exact execution ownership, permissions, Plan and task report rules. Never copy or print credentials.
- **CON-001**: Existing roles without model bindings retain their compatibility defaults. No production action, automatic rerun, full Home/database backup, protected-branch push or PR merge.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Implement eligible choices and actual frozen model execution.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Extend `web-agent/shared/external-agents.ts` with optional model references. Add `runtime/typescript/specialist-execution.ts` for bounded configured native/ready Codex options, explicit constraint validation and Agent-then-model random selection. | ✅ | 2026-11-12 |
| TASK-002 | Update `LakeSuperagent.manage`, `assignmentRoles`, `roleBackend`, `roleExecution` and router entries in `runtime/typescript/superagent.ts`; persist creation choices transactionally, preserve updates/replays, expose a paginated options tool and retain choices in Worker snapshots. Update `super-prompts.ts`. Depends on TASK-001. | ✅ | 2026-11-12 |
| TASK-003 | Bind native runtime model selection to the frozen role in `runtime/typescript/agent.ts`. Pass Codex model through host-owned `ExternalActor`, bind request/resume identities in `acp/service.ts`, and apply compatible process-local overrides with immutable launcher names in `acp/registry.ts`; record observed run model. Depends on TASK-001. | ✅ | 2026-11-12 |

### Implementation Phase 2

- **GOAL-002**: Verify behavior and install the signed Dev update. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Add meaningful eligibility/partial-selection/replay/update/freeze tests in `specialist-execution.test.ts` and `superagent-lifecycle.test.ts`; extend real SDK and pinned real ACP integrations for actual native/Codex model requests and immutable launch configuration. Run complete affected regression, types, bundle, boundary and naming checks. Depends on TASK-002 and TASK-003. | ✅ | 2026-11-12 |
| TASK-005 | Update current architecture/README and validation evidence. Capture fresh private hashes; normally stop Dev, commit clean source, sign/build/install `scripts/build_lake_desktop.sh --dev --install`, verify provenance/signatures, actual UI and original records. Update draft PR #222 against develop, without merging. Depends on TASK-004. | ✅ | 2026-11-12 |

## 3. Alternatives

- **ALT-001**: Letting the model invent a random backend is not durable or restricted to configured combinations; host-side selection supplies the actual saved receipt.
- **ALT-002**: Rerandomizing each task changes the specialist's identity and defeats explicit settings; choose once on role creation.

## 4. Dependencies

- **DEP-001**: Existing admitted human events, `superRoleMutations`, provider metadata/credentials, current Codex readiness probe and pinned compatibility catalog.
- **DEP-002**: Existing task snapshots, public SDK model binding, ACP subprocess guard, persistent signing identity and isolated Lake Dev home.

## 5. Files

- **FILE-001**: Shared execution references, new specialist selection module and SuperAgent role management functions in TASK-001/TASK-002.
- **FILE-002**: Native model binding and ACP types/service/registry in TASK-003, corresponding unit/SDK/ACP integrations in TASK-004.
- **FILE-003**: `agent.md`, `runtime/typescript/README.md`, this plan and `docs/validation/acp-agent-execution/` evidence.

## 6. Testing

- **TEST-001**: Available combinations only, both random draw boundaries, explicit partial choices, duplicate provider names, empty/disabled/incompatible pools and accurate model ownership.
- **TEST-002**: Exact creation replay/restart returns one saved selection; implicit role creation persists it; updates and existing Worker snapshots remain stable.
- **TEST-003**: Real SDK HTTP requests use the saved native model despite global selection changes; pinned Codex requests use its saved model, preserve local max/auth/configuration and managed tool restrictions; changed requested models cannot reuse another external run identity.
- **TEST-004**: Types, runtime/host/ACP/frontend regression, boundary/naming, signed Dev provenance and original user-data hashes pass.

## 7. Risks & Assumptions

- **RISK-001**: Configured/enabled or adapter-reported availability is not proof of a remote account's model entitlement or current network health; actual failure remains visible and never triggers a silent reroll.
- **ASSUMPTION-001**: Random applies to new specialists and unspecified Agent/model only; reasoning remains unchanged. The current verified Codex catalog contains one model and is not expanded by this feature.

## 8. Related Specifications / Further Reading

- [Architecture ownership](../agent.md)
- [Contribution workflow](../docs/development-workflow.md)
- [Codex configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#one-off-overrides-from-the-cli)
- [Task report lifecycle](../docs/security/task-confirmation.md)
