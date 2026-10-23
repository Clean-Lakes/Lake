# Lake Dev local validation — 2026-10-23

Validation source: `ffe9e0d1b6cc96b6556324038d5e0673d4b017ab` plus the session-navigation, SSH-trust and typography changes subsequently committed for this PR. The PR records the resulting commit SHA. Validation ran before that commit; only this validation note changed afterward. No release installation or production-data changes.

The PR also includes the installed Dev typography, centered search and pointer/keyboard focus changes not yet present in `develop`. Their earlier acceptance evidence is recorded in `lake-codex-screenshot-calibration.md`, `lake-two-text-styles.md`, `lake-focus-and-compact-toolbar.md` and `lake-centered-search.md`. The final frontend regression and signed Dev build below include these changes together.

## Delivered behavior

- Reasoning scale labels have proportional line height, 6px track separation and additional bottom clearance. Queued messages inherit the current UI typography.
- Project conversations support persistent pinned/ordinary groups, grip dragging within/between groups, menu pin/unpin and keyboard movement. Stale revisions and foreign or private-terminal targets are rejected. Sorting preserves activity timestamps and messages.
- Structured SSH file operations enter the existing host-fingerprint decision before authentication. Accepting allows the read; rejecting performs no authentication or read and creates no PTY. SSH exit 255 is classified conservatively instead of uniformly implying credential failure. Existing host-trust and operation-approval rules remain in force.

## Checks

- Frontend: TypeScript check, production build and all 423 frontend tests passed. Isolated browser fixture exercised menu pinning, drag reordering, cross-group moves, keyboard focus, dark mode and failed-save feedback.
- Backend: full `go test ./internal/web -count=1` passed (152.800s); full `go test ./internal/ai -count=1` passed (35.961s). Related SSH/navigation tests also passed under `-race`; `go vet ./internal/ai ./internal/web` and ADK runtime-boundary checks passed.
- SSH reproduction used no credentials: the configured forwarding ports for the sampled targets accepted TCP. Strict OpenSSH verification for the `.69` resource exited 255 with host-key verification failure, rather than authentication rejection. `.21` had a Dev trust record; `.69` and `.141` did not. No real host fingerprint was accepted and no failed remote command was retried.
- Built and installed using `scripts/build_lake_desktop.sh --dev --install`, persistent local code signing, Node 24 and Go toolchain. Restarted only `~/Applications/Lake Dev.app`. Installed signature, binary SHA match, backend health and presence of the new runtime trust bridge were verified. Native UI showed the pinned category, grip controls and pin menu.

The global prompt remains unchanged. Its golden snapshots passed after keeping the repair in the SSH connection path. Production profile and trust records were not copied into Dev.
