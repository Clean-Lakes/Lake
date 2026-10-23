# Ordinary conversation command availability — 2026-10-23

Installed Dev validation source: `9eb4ca82b40fbf4d541b08a0b7f6e468e2423f14` plus the working-tree changes to native operation dispatch, duplicate-call reporting and their regression tests. No real remote commands, trust decisions or operation-outcome records were changed during validation.

The standalone PR is based on `eb4d90028b1c2e0b870475f44445f5613b185bba` (`develop`) and contains only this command-availability fix. PR #75's pending UI/session-navigation/SSH-trust changes are excluded. The PR body records the independently tested commit SHA and regression results; the installed Dev acceptance below was performed with those pending changes present as well.

- Removed the session-wide unknown/dispatched operation barrier. A historical unfinished operation no longer blocks a different command, including another change on the same target. Each new command still follows current scope, target and approval controls.
- The durable invocation guard and an exact unfinished tool/arguments/target match prevent accidental replay, including when recovery regenerates a call ID. Historical unknown outcomes are preserved; new successful commands cannot settle them. SRE task-level continuation rules remain unchanged.
- Full `go test ./internal/ai -count=1` passed (40.862s). Related command availability, approval acceptance/rejection, duplicate invocation, concurrent approval, exact-handle reconciliation and process-crash recovery tests passed under `-race` (8.915s). The web restart-warning regression passed (0.812s).
- `go vet ./internal/ai ./internal/web`, `python3 scripts/check_adk_runtime_boundary.py` and `git diff --check` passed. Frontend TypeScript/Vite build passed; no frontend source changed in this iteration.
- Built and installed only Lake Dev through `scripts/build_lake_desktop.sh --dev --install`, using the persistent local signing identity. The final build reused those freshly built unchanged web assets. Installed backend hash matches the signed source build; deep strict application signature verification passed. Normally quit and relaunched Lake Dev, using its existing isolated `~/.lake-dev` home. Production app, credentials and data were untouched.

The initial broad removal exposed a crash-recovery replay regression. The final implementation retains the exact-command guard, and the original process-crash test passes unchanged. No failing regression was deleted or relaxed to complete this change.
