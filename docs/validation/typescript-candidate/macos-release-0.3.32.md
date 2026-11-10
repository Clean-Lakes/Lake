# TypeScript macOS 0.3.32 release

Date: 2026-11-10. The user explicitly requested publishing the status-island fix as a formal release, retaining the established macOS-only / current-TypeScript scope and instruction to publish directly without further confirmation. This covers the fix/preparation PRs, develop-to-master production PR and merge, macOS stable publication and history/evidence synchronization. The standing no-more-questions instruction is recorded as the independent-review exception for this release, not an independent approval or authority to skip required CI/server protection. No admin bypass, direct protected-branch push or auto-merge is used.

## Integrated fix and Dev evidence

PR [#218](https://github.com/Clean-Lakes/Lake/pull/218) merged as `8395e28d9ccc1db2f4c7fdd616c1a277f41a4bd0`; its tree exactly matches validated topic head `c54ef62960f3937a07ddbe5cd0920edcb778b652`. The topic branch was cleaned up after verification. This preparation changes VERSION to 0.3.32, macOS release notes and this record only.

Clean functional Dev `fcbba3e3f7b298fcdab8a302a3fc0c98f4a90a89` passed Web typecheck, all 773 frontend tests, signed build/install and native real-model verification. In a new fictional-record project, a genuine partial inline result remained paused while a distinct specialist task completed. The current Router root advanced without clearing that old task; native status changed “已暂停 → 处理中 → 已结束”. See [current-turn verification](status-island-current-turn-2026-11-10.md). No production task/history or infrastructure was changed by that test.

The fix affects frontend presentation only: exact Router session/root ownership and actual managed reply activity decide the badge. Original task, operation, approval, acceptance and other runtime state remain intact. It does not turn historical pauses into successful tasks. Existing TypeScript parity gaps remain documented in the release notes.

## Release validation

Version-candidate full verification, automatic production-PR branch-policy/workbench, exact clean master package checks and public asset byte verification are recorded after they complete. This initial record does not count pending checks as passed.

## Distribution and rollback

Only macOS Apple Silicon arm64 ZIP, DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing certificate is used; Apple Developer ID notarization is not claimed. No Windows release assets are built/published. No new data migration, credential copy or change to default-disabled new Memory scopes is introduced.

Package tests use private temporary Home/data without production credentials. They do not install/restart the production app or operate on its data. Existing update preparation/readiness rollback remains; old clients retain their own installer limits. Stop the backend before restoring compatible application/data backups, preserve operation/security records and do not mix Dev and production data. The final immutable release tag must point to exact clean master and stable metadata must use target_commitish master.

The five preexisting Desktop duplicate files are preserved in an exact-path stash for clean package provenance and restored byte-for-byte at the end; they are not added to this release.
