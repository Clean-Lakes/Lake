# Official ADK runtime

Lake uses the official `google.golang.org/adk/v2 v2.6.0` with Go `1.26.6`. All interactive model/tool loops now enter the SDK Runner and LlmAgent, including Web/Desktop, stdio, saved workflows, scheduled SRE work, plan generation and specialist questions. The production Go fallback and runtime selector have been removed. Historical `agentRuntime=go` options are normalized to `adk` with migration provenance.

Implementation and acceptance are tracked in [the migration plan](../../plan/refactor-adk-official-runtime-1.md), [entrypoint coverage](../validation/lake-adk-runtime-coverage.json), and [final validation](../validation/lake-adk-runtime-final.json). Earlier phase reports describe their historical snapshots, rather than the final architecture.

## Execution

`internal/ai/adk_driver.go` hosts official LlmAgents and their Runner. `adk_model.go` adapts existing provider protocols, model selection, reasoning, usage and image support. Every role gets its own official LlmAgent and isolated business scope. `adk_sre_workflow.go` compiles the validated DAG into ADK FunctionNodes, dependency edges and JoinNodes. Role serialization and exclusive acts are business ordering constraints; the ADK graph scheduler owns execution, fan-in, cancellation and draining. Successful native Output/NodeInfo events provide durable result reuse across explicit retries. The old model/tool loop and scheduler files have been removed.

SDK ownership sits inside `internal/ai`; `internal/agent/storage` has no AI-domain dependency. This avoids an ai → adapter → ai import cycle and ensures direct CLI/stdio callers cannot accidentally bypass ADK. Scoped Engine objects retain business state, evidence and executor access; they contain no alternative model/tool loop. The former spike runtime and gate survive only in `_test.go` regression fixtures; the spike executable is removed.

ADK's default concurrent execution of tool calls within one response is overridden using the public task-runner hook. Those calls preserve model order so a human answer or terminal adoption affects the following call. Independent role nodes still run concurrently.

ADK 2.6 Workflow AgentNode rewrites its user content, which discards a tool-confirmation response. A public custom-agent wrapper preserves the role LlmAgent's confirmation envelope. A public session-event adapter also emits follow-up confirmations when terminal setup and command execution need separate approvals. Neither adapter imports SDK internals or replays resource execution.

## Persistence and human decisions

Web stores private SDK sessions at `<DataDir>/adk/sessions.sqlite`; standalone engines use `<Engine.Dir>/adk`. GORM uses its public SQLite dialector with Lake's existing `modernc.org/sqlite` driver. This prevents the duplicate `sqlite` driver registration that the initial glebarez adapter caused when the Windows Web store initialized.

Official session state refers to versioned artifacts holding Lake's lossless provider-history projection, including provider-native reasoning blocks. Images are stored as artifacts, with references in SDK events. The local JSON history cache can be reconstructed from the migration index and the canonical SDK projection. Intentional clear, restore, rollback and compaction publish their new projection; they do not undo external effects.

Tools request official RequestConfirmation. Durable bindings include the original call, argument/preview digests, policy and target fingerprints, terminal version, scope, plan/attempt identity and expiry. The client sends only the original ID and decision. Approval consumption and the dispatched operation row share a SQLite transaction. A failed pre-dispatch audit prevents execution. Requests that contain credentials are rejected before SDK persistence and resource execution.

Human questions use official WorkflowAgent `RequestInput` / `ResumeOrRequestInput` checkpoints. Live same-batch execution waits for the answer. After a process crash, the host reconstructs the original question response; other unfinished calls receive an explicit not-executed result and are never silently replayed. SRE specialist questions and approvals retain their original role/attempt IDs and resume through the same Runner. If a process dies between the durable role wait and its SRE business-status projection, recovery reconciles the current plan and original role/attempt before resuming, rather than creating a replacement run. Explicit plan review and manual attestation also have durable RequestInput checkpoints; automatic plan continuation does not fabricate a human review. Frozen probe values, comparison operators, freshness, windows and sample counts are evaluated by the pure `EvaluateSREChecks` function, independently of model wording.

An operation is durably marked dispatched before executor entry. Transport loss or process failure leaves an unknown outcome. Only an exact original command handle can reconcile a live command. Otherwise the UI requires a human verification result and note. This is a dispatch/reconciliation discipline, not a claim of exactly-once effects across arbitrary external systems. Cancellation does not assert that a remote command stopped.

File adapters parse stdout separately from stderr, so SSH connection warnings cannot become file contents, search results or SHA256 fingerprints. Cached fingerprints must be valid SHA256 values; an invalid legacy fingerprint requires a fresh read. File precondition failures before the mutating executor starts are marked not executed. Existing unknown, handle-free file operations with either exact precondition error are reconciled to not executed with append-only evidence, excluding SRE task projections. This repair never retries an operation, infers success, or releases a genuine execution failure.

## Migration, backup and rollback

History import preserves original business files and SDK events, validates call/result pairs, and uses a completion marker before activating an imported session. Incomplete records are explicitly marked unknown. Import never executes a historical call. A failed import remains inactive and can be retried.

Before import, SQLite `VACUUM INTO` produces a consistent private snapshot, including committed WAL content; quick-check, fsync and atomic replacement verify the snapshot. Source JSON is backed up separately. This replaces the plan's initially proposed driver-specific SQLite backup API with SQLite's supported consistent-snapshot operation.

Rollback must use a signed binary compatible with the current schema. Stop and drain all work, preserve the latest operation ledger, and reconcile dispatched/unknown operations first. An old pre-execution snapshot cannot overwrite a ledger containing later effects. An incompatible pre-migration binary must use its own isolated data copy and cannot resume writes against the new database. Dev and release homes and credentials remain separate.

## Verification

Run `python3 scripts/check_adk_runtime_boundary.py`, full Go/race/vet checks, frontend tests/typecheck/build, and the signed Dev build. `.github/workflows/adk-runtime.yml` executes real Linux and Windows SDK, migration and process-recovery tests; macOS CI retains the complete race suite. Use the final validation artifact for actual exit codes, source snapshots, CI links and GUI evidence. A cross-compile is never reported as target-platform execution.
