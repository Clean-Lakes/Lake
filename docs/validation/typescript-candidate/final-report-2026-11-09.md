# Investigation files and chat conclusions

Date: 2026-11-09. Base: develop `10fe87866c25a63a85c5c2266c906bab03b53bfc`. The user requested restoring the Desktop repository first, then fixing the case where the agent only appends an investigation file without delivering a chat conclusion.

## Repository restoration

`~/Desktop/Lake` was absent; the source Git repository and history remained intact in Codex's local repository. Restored a real independent checkout at `/Users/lingyunxieqing/Desktop/Lake`, using copied Git objects (no shared object dependency or symlink), the authorized GitHub origin and current develop. Work continues on `codex/specialist-final-summary`. Other Desktop files were untouched; no credential or application data was copied.

## Behavior

After real operations in the current ordinary task, the SDK's native Stop hook detects the missing business report and continues the same product turn once. Its existing history contains the actual observations and file edits; no second model/tool loop, replacement Worker, file-content scanner or inferred acceptance is added. The model must submit the actual findings and remaining uncertainty via `work_finish.summary`; a log-file acknowledgement or path does not replace the chat conclusion.

That continuation exposes only report submission, existing-output retrieval, existing-child controls and progress bookkeeping. A handler guard also rejects new business I/O before its host invocation. It cannot append a file again, issue a new command or create a child while repairing the reply. Later admitted turns regain their usual tool capability. Current permissions, Memory qualifications, original generation, cancellation and deadlines still apply.

Successful or partial reports already submitted do not request another model step. Explicit plans, pending human input and stopped/stale workers do not use this repair. Original task/operation/acceptance rows are not changed by the request for a report. Completed and partial submissions still pass through the original ledger; a provider that ignores the one reminder receives a visible incomplete-report notice, never a fabricated conclusion or successful acceptance.

## Evidence and limits

The production application was inspected read-only without restarting it or sending a model request/remote command. The screenshot's existing task already contains a `work_finish` summary; it is not claimed as a reproduction of a missing report, and its history was not rewritten. The separate file-only path was reproduced with the real SDK and an isolated controlled provider.

The SDK fixture reads an existing investigation file, appends one observation through the real Edit tool, and first returns only a file acknowledgement. It verifies one native continuation, one public report in both Pilot and the specialist channel, a single file append, the original SDK root and one Worker. Completed, partial and deliberately uncooperative-provider cases cover successful delivery, preserved incomplete acceptance and a bounded explicit failure. This is controlled-provider integration evidence, not a real remote investigation or proof of its diagnosis.

Initial local checks passed: TypeScript typecheck; 255 source tests (251 passed, four existing conditional skips); all 188 bundled runtime tests; ADK boundary, backend naming and whitespace checks. Pending-input, explicit-plan, original-generation, stopped-worker and already-submitted partial-report regressions passed. Signed Dev build and native/real-model verification are pending at this preparation point. No production build, installation or new Release is authorized by this fix request.


## Header and first native check

The user's follow-up requests removing the header enclosure. The Lake/Dev/search row now has no painted border or background, with its existing controls and search hover/keyboard focus retained. Web typecheck passed; final light/dark/narrow native review is pending.

A signed clean Dev build from `f6d7a17fb7d91f4e33b13f1443c3973ffcd8333c` (backend SHA256 `a3e1ba9de2962aa305b3f3c1ae251cc04b275bd9a6413c644c5a34295f1dbc9b`) ran the configured real model in an independent Dev-only project. Read/Edit appended a fixture marker exactly once, work_finish submitted actual text, and Pilot plus the specialist channel contained the same conclusion; native UI displayed it. No Shell, remote resource or child was used. The report correctly preserved uncertainty but incorrectly treated the already-completed specialist handoff as unfinished work and selected partial. The original report is retained. The Worker prompt now explicitly identifies the structured assignment as the completed handoff and confines its deliverable to business findings; final real-model recheck is pending. Source 255 (251 passed / 4 existing conditional skips) and all 188 bundled tests passed again after that prompt change.
