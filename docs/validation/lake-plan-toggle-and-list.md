# Plan toggle and plan list — local Dev validation

Date: 2026-10-22. Branch: `codex/fix-plan-toggle-refresh`.
Base/head: `2470233f3c58af6fe98d996d0dc95cefed59a598` plus local uncommitted changes.
The base has the same source tree as origin/develop `2b635d06`; it retains installed Dev ancestry.
No push, PR update, merge, or release performed for this iteration.

## Changes

- Plan mode saves an ordered presentation delta without global pending state or a full session refresh.
- The current session menu adds **计划** beside conversation, execution records, and evidence.
- Runtime-accepted plan cards retain durable markers. The plan list reads the full history independently of the recent-card window, newest first. Revisions and later execution preserve historical plans; only the current completed proposal can be executed.

## Checks

- `pnpm check` and signed desktop build (which repeats TypeScript/Vite validation): passed.
- `pnpm test:frontend`: 407/407 passed.
- `go test -race ./internal/ai ./internal/web -run TestPlanMode -count=1`: passed.
- Broader race regressions matching PlanMode, Snapshot, ADKRecovery, Projection, Reasoning, SSE, Configure, Capacity: passed.
- `go vet ./internal/ai ./internal/web`: passed.
- `python3 scripts/check_adk_runtime_boundary.py`: passed.
- `git diff --check`: passed.

## Isolated browser verification

Test home: `/tmp/lake-plan-toggle-20261022/home`, loopback port 51384, synthetic local-machine resource and synthetic plan records. No real model or resource operations were executed.

With an 800 ms delayed mode save: resource buttons stayed enabled, editor stayed editable, duplicate mode submission was blocked, resource/editor/document identities and the draft were preserved, and no extra snapshot request was sent. A simulated 409 left the mode/draft unchanged and allowed retry.

The session menu shows the plan entry. Two historical plans render with titles, creation times, expandable Markdown, and current/history labels. Desktop light and 430 px dark views show no horizontal overflow. Native pointer automation was unreliable during the browser run; DOM event fallback verified the controls after inspecting their state. SSE delivery was additionally tested through a real HTTP subscriber.

## Dev package

Built/installed using `scripts/build_lake_desktop.sh --dev --install` into `~/Applications/Lake Dev.app`.
`codesign --verify --deep --strict` passed. Installed backend and worktree binary match SHA-256:
`02fafb7475c9ef55129fcb714dc1c5cd5938319cef64182afa4ef6dac2a9e493`.

Native window automation repeatedly returned `timeoutReached`; the final native restart and visual acceptance were not verified. The running Dev process predates the final build and must be restarted to load it. Production Lake was not restarted or installed, and release data/secrets were not accessed.

## Follow-up: failed DeepSeek planning turn

The reported Dev session had `conversationMode=plan`; the persisted completed tool calls were read-only investigation. The failed response was discarded before tool dispatch with `invalid or duplicate model tool call`. No raw provider response was retained for that failure, so the exact malformed field cannot be recovered retrospectively.

Fixed Responses stream finalization: complete arguments and late identity metadata from `function_call_arguments.done`, `output_item.done`, and `response.completed` are reconciled before validation. Native history uses the same validated arguments. Conflicting identities, malformed JSON, and duplicate IDs still reject the entire batch. Usage from rejected responses is retained.

Added one bounded regeneration of a rejected tool response per turn, with a distinct prompt-manifest retry record. Already completed tools/history are preserved; invalid calls are not dispatched or persisted as executable history. A second format failure stops normally with a Chinese recovery explanation.

A live `deepseek-flash / openai-response` test exposed a separate recognition failure: a complete tagged plan preceded by “已记录范围” was ignored. Recognition now extracts exactly one explicit plan block, excludes introduction/closing prose, and rejects incomplete, nested, multiple or fenced example blocks. Markdown display hides protocol tags while preserving fenced examples.

Final checks: 408/408 frontend tests; related provider, Responses, Plan mode, question recovery and manifest race regressions; Go vet; ADK runtime-boundary checks; signed desktop build and installation. Live opt-in test `LAKE_PLAN_LIVE_DEV_HOME=~/.lake-dev go test ./internal/web -run ^TestPlanModeLiveClarificationAndProposal$ -count=1 -v` passed in 33.51 s: real provider question → synthetic answer → complete proposal → plan history. It reads Dev model settings/secret files through the normal model loader, runs in a temporary engine/workspace with no real resources, and denies local execution. No user database was accessed.

Latest installed backend SHA-256: `26b81fb33659d8bdf8b1c448c6d613944d226788c98a940f9e2ca1a412a54b7c`. This supersedes the earlier package hash above. Native automation again timed out before window access; the running Dev process has not been restarted. User must fully quit/reopen Lake Dev to load this package. No PR or remote writes were made.

Complete race suite `go test -race ./internal/ai ./internal/web` also passed (ai 117.839 s, web 309.263 s). The final plan-extraction change was subsequently covered by the rerun of Plan mode/provider/manifest regressions (ai 8.188 s, web 3.400 s), the live provider smoke and 408 frontend tests.

## Follow-up: keep plan bodies out of chat

Conversation entries containing a plan are projected to a compact plan reference before transcript grouping, preview summaries or Markdown rendering. The complete canonical text is preserved for the plan list. Streaming opening-tag fragments and incomplete/failed drafts also remain out of chat; ordinary clarification and fenced protocol examples retain their normal rendering. Chat shows generation/saved/incomplete state plus a keyboard-accessible “查看计划列表” button. Execute/revise controls live in the explicit review view.

Complete tagged legacy plan cards remain reviewable from the full plan history without granting execution authority or creating a current ProposedPlan.

Checks: 413/413 frontend tests, including every streamed prefix and full transcript output; Plan mode/legacy-history race regressions in ai/web; TypeScript/Vite signed desktop build; Go vet; ADK boundary; diff check. A real isolated backend and a synthetic gated streaming provider verified that plan text and protocol tags never entered the chat DOM during generation or after completion. Clicking the reference opened the full persisted plan and its review controls. Desktop light/dark and 430 px dark views were visually inspected with no horizontal overflow. Final signed artifact was restarted in the isolated home and chat/list navigation rechecked. Browser task 6 finished; all fixture servers stopped after validation.

Latest Dev backend SHA-256: `af39d431bedd1d6fa32c70b5b035b1b5120627c69d9e70e509cf98e6bef94625`. Built and installed with `scripts/build_lake_desktop.sh --dev --install`; app signature verification passed. Native Dev restart remains a manual acceptance step because native automation was unavailable in this session. No production installation, PR update or remote write.


## Follow-up: dedicated session plans page

The session menu now opens a durable `?session=<id>&view=plans` route with a dedicated session-scoped page, title and return-to-conversation button. This page mounts neither the conversation transcript nor the composer. Inactive sessions also expose the Plan entry. Returning preserves the current draft and conversation position; refresh and browser history preserve the plans route.

Checks: TypeScript check and 416/416 frontend tests passed, including route serialization, page scope, loading/error states and exclusion of a different session's snapshot. Isolated browser verification covered menu navigation, return with preserved draft, browser back, reload, opening an inactive empty session without leaking the previous session's plans, and returning to the original three-plan history. Desktop light/dark and 430 px dark layouts were inspected with no horizontal overflow. Browser task 7 finished after verification; the isolated backend was stopped.

Built and installed using `scripts/build_lake_desktop.sh --dev --install`. `codesign --verify --deep --strict` and `git diff --check` passed. Latest installed backend SHA-256: `70572fa947fad3811975fae7f63069b4eaf34b7009a66187ab52d439c9904aea`. Native Dev still requires a full quit/reopen to load the installed package because native automation timed out. No production installation, PR update or remote write.


## Follow-up: make the list visible before opening details

The plans page now starts with a clearly titled saved-plan list. Each full-width button shows the title, time, latest/history/confirmation status and a detail affordance. No plan body or execution control is mounted until a record is selected. Details provide an explicit return-to-list action; keyboard focus moves to the selected view and the list reading position is restored on return.

Checks: TypeScript check, 417/417 frontend tests, signed Dev build/install, codesign deep/strict verification and diff check passed. Isolated browser task 8 verified three visible records with no body text, selection of the current proposal, keyboard selection of a historical plan without execution controls, return to all records and reload back to the list. Narrow 430 px dark layout has no horizontal overflow.

Native automation was available for this iteration. Fully quit the old Lake Dev through its UI, launched the newly installed app, then opened the actual reported session via its saved-plan reference. The native page visibly shows “计划列表”, one saved migration plan, its time/status and “查看详情”; no body is expanded. This supersedes the earlier manual-restart limitation. Production Lake was not launched or changed. No model or resource operation was executed.

Tested HEAD remains `2470233f3c58af6fe98d996d0dc95cefed59a598` plus uncommitted changes. Latest installed backend SHA-256: `264c22d50835a350895b215ab367852811ab382b2d0ea3ec185d5cc665394253`. No PR update or remote write.


## PR preparation

2026-10-22: fetched origin and confirmed `origin/develop` remains `2b635d06`. Created `codex/fix-plan-history-and-review` from that integration commit, carrying the validated working changes without the previous local Dev-build merge ancestry. The previous HEAD and integration base have identical source trees; no application source changed during PR preparation. The PR head records the exact submitted source; native acceptance above used that source before commit, with backend hash `264c22d50835a350895b215ab367852811ab382b2d0ea3ec185d5cc665394253`.

Final pre-PR checks: `go test -race ./internal/ai ./internal/web -run 'Test(PlanMode|Responses|Provider|PromptManifest)' -count=1` passed (ai 4.967 s, web 3.887 s); Go vet, ADK runtime boundary and diff check passed. Frontend remains 417/417 passed, with successful signed Dev installation and native list acceptance from this iteration. This PR targets develop only and does not authorize merge or production release.
