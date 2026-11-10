# Status island current-turn ownership

Date: 2026-11-10. Base develop: `5f46b0e2bf8867fd9cb16178e2ec7114d81d6116`. The user reported that Pilot still displayed “已暂停” after a new specialist task had finished.

## Diagnosis and behavior

Read-only inspection of the installed production snapshot confirmed the current Pilot reply was completed and the latest specialist task was completed. The same snapshot still exposed an older paused inline task, with a different originRootTurnId. `workGoalPresentation` correctly rejected that historical root, but the separate `superTaskHeaderPresentation` fallback did not check ownership and reintroduced the pause label. Production data, tasks, approvals and infrastructure were not changed during inspection.

The header now supplies its selected snapshot to the task projection. Router task overrides require the exact session and a nonempty matching root; foreign project/session tasks and unidentified roots cannot supply a pause or legacy token-limit notice. A selected Worker or role channel can still show its actual canonical pause after its reply has ended. Real managed reply activity takes priority, including when a paused/blocked canonical goal remains during a resumed invocation. Existing project-worker aggregation, waiting states, offline static feedback and completion remain in place. Goal presentation also refuses a missing root rather than matching two undefined values.

This changes presentation only. No task, operation, acceptance, report, lease, permission, deadline, history or backend projection is rewritten. It does not globally turn paused tasks into completed tasks or infer acceptance from the final message.

## Local verification

Clean functional source / installed Dev SHA: `fcbba3e3f7b298fcdab8a302a3fc0c98f4a90a89`. Pinned Node 24.14.0 Web typecheck and all 773 frontend tests passed. Five new regression cases render the shared badge using the actual header precedence and cover old inline task residue, current real pause, live reply/approval priority, sibling execution/completion/offline transitions, missing roots and foreign ownership. Existing Worker budget-pause cases retain their original pause behavior using correctly scoped snapshots. `git diff --check` passed.

`scripts/build_lake_desktop.sh --dev --install` completed; deep/strict bundle signature verification passed. The installed manifest records TypeScript, clean source above and backend SHA256 `f262f040b83d93fc2c18de7aeca63b8811478121a579ad4581649de7eac9b88a`. The signed desktop build rebuilt Web assets. No backend/Go/native execution code, CSS, geometry or persisted schema changed; full SDK/Go/race/native-installer suites were not repeated for this frontend-only state projection. No new dark/narrow geometry validation is claimed.

## Real-model native Dev reproduction

The existing configured real model (`gpt-6.1-terra`) used a new Dev-only project “状态岛轮次验证 2026-11-10” (`693efe6b-9ad8-4e57-878d-c2b90db038bc`). Both local fixtures were explicitly fictional. No Shell, SSH, database, MCP, network target, file mutation or native child was used.

- A explicitly asked Pilot to personally read an incomplete investigation fixture and submit its genuinely incomplete result. Actual Read + work_finish(partial) created paused inline task `pilot_task_6af102ec52987f37e3ae7b8fd3b433f5`. Its origin matched the current Router root; native Lake Dev displayed “已暂停”.
- B explicitly retained A and created a distinct specialist task `st_e26cb6f41fb079dcab5d637fe95abef7`. Actual Read + work_wait(20 seconds) + work_finish returned the fixture version `1.2.3-QA`, with host acceptance pass. Both fixture hashes were unchanged.
- B left the Router snapshot carrying A's paused task/root while its actual current root advanced. This reproduces the production snapshot mismatch without fabricating a stored status. Native Lake Dev displayed “处理中” during the new reply/delegation and “已结束” after B's actual completion, including the real specialist report. A remained paused with its original root. The QA project is retained and visible in Dev for review.

Existing untracked duplicate files found on Desktop were temporarily preserved in an exact-path Git stash to obtain a clean build. They are restored byte-for-byte after validation and are not included in this PR. Their contents are not silently discarded or added to the release.

This ordinary fix PR targets develop. No new production release, installation or restart is performed by this status-display fix; 0.3.31 remains the previously published version.
