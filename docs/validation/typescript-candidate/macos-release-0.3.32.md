# TypeScript macOS 0.3.32 release

Date: 2026-11-10. The user explicitly requested publishing the status-island fix as a formal release, retaining the established macOS-only / current-TypeScript scope and instruction to publish directly without further confirmation. This covers the fix/preparation PRs, develop-to-master production PR and merge, macOS stable publication and history/evidence synchronization. The standing no-more-questions instruction is recorded as the independent-review exception for this release, not an independent approval or authority to skip required CI/server protection. No admin bypass, direct protected-branch push or auto-merge is used.

## Integrated fix and Dev evidence

PR [#218](https://github.com/Clean-Lakes/Lake/pull/218) merged as `8395e28d9ccc1db2f4c7fdd616c1a277f41a4bd0`; its tree exactly matches validated topic head `c54ef62960f3937a07ddbe5cd0920edcb778b652`. The topic branch was cleaned up after verification. This preparation changes VERSION to 0.3.32, macOS release notes and this record only.

Clean functional Dev `fcbba3e3f7b298fcdab8a302a3fc0c98f4a90a89` passed Web typecheck, all 773 frontend tests, signed build/install and native real-model verification. In a new fictional-record project, a genuine partial inline result remained paused while a distinct specialist task completed. The current Router root advanced without clearing that old task; native status changed “已暂停 → 处理中 → 已结束”. See [current-turn verification](status-island-current-turn-2026-11-10.md). No production task/history or infrastructure was changed by that test.

The fix affects frontend presentation only: exact Router session/root ownership and actual managed reply activity decide the badge. Original task, operation, approval, acceptance and other runtime state remain intact. It does not turn historical pauses into successful tasks. Existing TypeScript parity gaps remain documented in the release notes.

## Release validation

Release preparation [#219](https://github.com/Clean-Lakes/Lake/pull/219) merged as clean frozen candidate `3f3b88ecddff89a7444e6b9bcd21e0da0aa8bd34`; its tree matched preparation head `1a7b24447f8608c5e5c21730727c165d2474d567` exactly. Production PR [#220](https://github.com/Clean-Lakes/Lake/pull/220) used a merge commit, `48ffda34e9d0244d3dd4b42baf89bba95e3baea4`, retaining both parents and exactly matching the tested merge tree `4eeb87fc6095f2a94d1d07102139e6fc3abb4f1f` (CI merge `f9fb88841a72a16ea8b9594a2f8e348e56d666a2`).

The frozen candidate passed `scripts/verify_lake_release.sh`: pinned Node 24.14.0 TypeScript typecheck, 251 source tests with four existing conditional skips, all 208 SDK tests, complete Go tests and vet, Web check/all 773 tests/build, formal signed desktop build, native update/window checks and ten installer tests. Additional Dev provenance (19), publisher (8), branch policy (4), Memory tool (6), ADK boundary, backend naming (zero matches) and diff checks passed. Candidate backend SHA-256 was `4a38e286d68073dd415bfa047f04a628df83874830bdfca72e7c7a3369833144`.

[Production verification run 42762223350](https://github.com/Clean-Lakes/Lake/actions/runs/42762223350) completed successfully for the exact frozen head: macOS runtime, all three Linux Go race/vet groups (ai/web/remaining) and the workbench aggregator. Branch-policy run 42762223501 and the latest PR branch-policy checks also passed; review threads had no unresolved entries. The master protection API returned HTTP 404, so server-side protection was not represented as enabled and local/premerge gates were explicitly checked. The optional Windows job failed and was excluded from this authorized macOS-only release; it was not called passed or rerun.

After production merge, `scripts/build_lake_desktop.sh` rebuilt the formal package from exact clean master `48ffda34e9d0244d3dd4b42baf89bba95e3baea4` without installing/restarting production. Its TypeScript backend SHA-256 is `dcf53a4ed14a516f90f523f0bbdfe97e6f0afc1cfc6f33ab1255d046f6db4100`. Signed SEA tests verified import-only preparation with no listener/runtime record, authenticated bootstrap/catalog, accurate PID/Home/data identity, graceful drain and two starts, unchanged original marker and rejection of mixed production/Dev flags before writing. ZIP extraction and readonly DMG mounting verified deep/strict signatures, clean source provenance, version/runtime, matching backend hashes, arm64 binaries and macOS 13.5 minimum. The persistent signing certificate matches 0.3.31 (certificate SHA-256 `377ee437dfbfdde4abf3acc055fa5892bd9d0625b762ac3b825091dba3a086e6`).

## Published assets

[Lake v0.3.32](https://github.com/Clean-Lakes/Lake/releases/tag/v0.3.32) was published at `2026-11-10T05:55:48Z` as stable/latest, not draft/prerelease, with target_commitish `master`. The immutable tag points to exact production `48ffda34e9d0244d3dd4b42baf89bba95e3baea4`. Exactly four macOS assets were downloaded again and matched local bytes, GitHub asset digests/sizes and both checksum files:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Lake-0.3.32-macos-arm64.dmg | 80166957 | `3d8c5aa9a7618cac946e8f5ed592930cf204f2298177fa2e9f54093721933b2c` |
| Lake-0.3.32-macos-arm64.dmg.sha256 | 94 | `6d6a5db2130a677a63be775a34dfe71e5ed1d868ed3e1192de841194ea83903a` |
| Lake-0.3.32-macos-arm64.zip | 67175159 | `bd37e81b3f03c1547cf6ae2e42a8624de4d8b73d713d7c7d14645b547af068a4` |
| Lake-0.3.32-macos-arm64.zip.sha256 | 94 | `9d56cc80ac7271887338a92cba864e90cdf6ff47db6636d622d946f1b16f56e3` |

## Distribution and rollback

Only macOS Apple Silicon arm64 ZIP, DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing certificate is used; Apple Developer ID notarization is not claimed. No Windows release assets are built/published. No new data migration, credential copy or change to default-disabled new Memory scopes is introduced.

Package tests use private temporary Home/data without production credentials. They do not install/restart the production app or operate on its data. Existing update preparation/readiness rollback remains; old clients retain their own installer limits. Stop the backend before restoring compatible application/data backups, preserve operation/security records and do not mix Dev and production data. The final immutable release tag must point to exact clean master and stable metadata must use target_commitish master.

The five preexisting Desktop duplicate files are preserved in an exact-path stash for clean package provenance and restored byte-for-byte at the end; they are not added to this release.
