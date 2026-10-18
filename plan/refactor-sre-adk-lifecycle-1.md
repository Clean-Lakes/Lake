---
goal: Use ADK graph scheduling and durable node results for SRE execution
version: 1
date_created: 2026-10-18
last_updated: 2026-10-18
owner: Lake
status: Completed
tags: [refactor, sre, adk, lifecycle]
---
# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

Replace the custom SRE scheduling loop with ADK graph execution. Retain business plans, resource constraints, permissions, evidence, operation reconciliation and acceptance checks. Existing public status fields become compatibility projections, never a second scheduling authority.

## 1. Requirements & Constraints

- **REQ-001**: ADK schedules dependencies, fan-in, concurrency, failure cancellation and peer draining.
- **REQ-002**: Reuse successful ADK node outputs from the same immutable plan run; do not use a mutable Lake completed/running map.
- **REQ-003**: Preserve role serialization, exclusive action steps, operation identity, permission checks and recovery acceptance.
- **REQ-004**: Centralize attempt lifecycle classification from execution outcomes; distinguish cancellation, waiting, business failure and unknown operation outcomes.
- **SEC-001**: Never replay a successful write or bypass an unresolved operation, and never print credentials.
- **CON-001**: Preserve existing worktree changes, public JSON compatibility, signed builds and Dev/release isolation.
- **PAT-001**: Use installed google.golang.org/adk/v2 v2.6.0 graph, JoinNode and SessionService interfaces.

## 2. Implementation Steps

### Implementation Phase 1

- **GOAL-001**: Audit and replace the SRE scheduler. No dependency on later phases.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Inspect internal/ai/adk_sre_workflow.go, sre_orchestrator.go, adk_recovery.go and installed ADK workflow source; record ownership boundaries. | Yes | 2026-10-18 |
| TASK-002 | Compile SREPlanRevision dependencies and business role/action ordering into ADK edges and JoinNodes in internal/ai/adk_sre_workflow.go; delete custom goroutines, channel draining and mutable scheduler maps. | Yes | 2026-10-18 |

### Implementation Phase 2

- **GOAL-002**: Use durable ADK results and consolidate lifecycle projection. Depends on GOAL-001.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-003 | Load successful node outputs from the plan run's ADK session and reuse them on explicit retry. Import historical completed business attempts only for migration and proven reused actions. Remove completed-map scheduling from StartSRETask. | Yes | 2026-10-18 |
| TASK-004 | Centralize SRE attempt outcome projection and run completion; preserve actual cancellations and business acceptance failures separately from model completion. | Yes | 2026-10-18 |

### Implementation Phase 3

- **GOAL-003**: Verify runtime behavior and deliver a signed Dev build. Depends on GOAL-002.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Extend internal/ai/sre_scheduler_test.go with native event persistence, restart/retry reuse, dependency ordering, action exclusivity, failure draining and cancellation cases; run relevant and full backend race tests and frontend checks. | Yes | 2026-10-18 |
| TASK-006 | Update docs/sre-collaboration.md and validation evidence; build scripts/build_lake_desktop.sh --dev --install, verify signing and launch Lake Dev when no turn is active. Build installed and verified; native reload deferred because the final readiness check found an active user turn. | Yes | 2026-10-18 |

## 3. Alternatives

- **ALT-001**: Keep NewDynamicNode around a manual scheduler; rejected because ADK cannot own graph dependency and concurrency scheduling inside that loop.
- **ALT-002**: Delete business operation state; rejected because ADK cancellation cannot prove the outcome of a remote operation.

## 4. Dependencies

- **DEP-001**: Installed ADK Go v2.6.0 and its persisted SessionService; no dependency upgrade.

## 5. Files

- **FILE-001**: internal/ai/adk_sre_workflow.go: graph compilation, runner and durable output reuse.
- **FILE-002**: internal/ai/sre_orchestrator.go and SRE lifecycle helper: business projection and removal of duplicate scheduler state.
- **FILE-003**: internal/ai/sre_scheduler_test.go and related SRE regression tests.
- **FILE-004**: docs/sre-collaboration.md and docs/validation/lake-sre-adk-lifecycle.json.

## 6. Testing

- **TEST-001**: Independent roles overlap; same-role steps serialize; action nodes run exclusively; fan-in runs only after every dependency succeeds.
- **TEST-002**: Failure and external cancellation stop dependencies and drain peers before returning.
- **TEST-003**: Reopening a persisted ADK session reuses successful node output; failed work can be explicitly retried; a successful reused action is not dispatched again.
- **TEST-004**: Existing operation, approval, recovery and acceptance checks remain effective; interruption does not introduce an automatic composer panel.

## 7. Risks & Assumptions

- **RISK-001**: Legacy run records may predate ADK node events. A bounded compatibility import must preserve proven successful business results without treating unknown operations as complete.
- **RISK-002**: Additional role/action ordering can introduce cycles unless compiled in a validated topological order.
- **ASSUMPTION-001**: Public status fields remain for UI and old records as projections; operation facts and task acceptance remain Lake business responsibilities.

## 8. Related Specifications / Further Reading

- [SRE collaboration](../docs/sre-collaboration.md)
- [ADK graph workflows](https://adk.dev/graphs/)
- [ADK dynamic workflows](https://adk.dev/graphs/dynamic/)
