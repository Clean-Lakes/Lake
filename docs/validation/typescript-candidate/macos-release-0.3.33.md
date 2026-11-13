# TypeScript macOS 0.3.33 release

Date: 2026-11-13. The user requested a formal release for macOS only. This authorizes the integrated feature/preparation PRs, develop-to-master release PR and production merge, followed by macOS stable publication. It does not remove required checks or the repository's independent-review requirement. No admin bypass, direct protected-branch push or auto-merge is used.

## Integrated changes and Dev evidence

PR [#224](https://github.com/Clean-Lakes/Lake/pull/224) merged as `a34f92430cacd31273e22134359dcdd89f6b92cd`. Its tree exactly matches validated topic head `2116c4718e59279d183a9ea2976d76a523f7174e`; the merged topic's local and remote branches were removed after verification. The original open PRs #222 and #223 and their worktree branches remain intact.

The latest clean signed Dev installation is `52bbc588a6d577512a15a6ce0fb610e2f4e93f42`; the following commit adds validation documents only. All 817 frontend tests, Web typecheck/build, native specialist navigation, actual connection failure/retry and light/dark/narrow presentation passed. See [reconnect validation](../acp-agent-execution/quiet-reconnect-2026-11-13.md). Earlier same-branch ACP/SDK integration, six genuine specialist responses and persistent record checks retain their exact tested SHAs in [integrated conversation validation](../acp-agent-execution/pilot-conversation-integration-2026-11-13.md).

The release includes managed ACP execution, native/ACP specialist conversation participation, explicit-only combined summaries, task reporting, Pilot configuration management, precise resource directory search, structured receipt handling, the user-selected SSH trust policy, specialist task lists and compact navigation. Existing TypeScript parity gaps remain documented. Task reports do not turn historical unknown operations into successful results or independently verified business outcomes.

## Release validation

The preparation changes VERSION, macOS release notes and this record only. Full frozen-candidate release verification, automatic production-PR checks, independent review, exact master packaging and published asset verification are pending at this stage. Results will be appended after completion.

The current master and develop protection endpoints both return “Branch not protected” (HTTP 404); server-side enforcement is not represented as enabled. Local contribution rules, PR-only integration, review and release checks still apply.

## Distribution and rollback

Only macOS Apple Silicon arm64 ZIP, DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing identity is retained; Apple Developer ID notarization is not claimed. No Windows release asset is published. Package validation uses private isolated temporary Home/data without production credentials and does not install or restart the user's production app.

Existing update preparation/readiness rollback remains in force; old clients retain their own installer limits. Stop the backend before restoring compatible application/data backups, preserve operation/security records and do not mix Dev and production data. The immutable release tag must point to exact clean master, with stable metadata using target_commitish master.
