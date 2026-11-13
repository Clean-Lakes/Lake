# TypeScript macOS 0.3.33 release

Date: 2026-11-13. The user requested a formal macOS-only release, then explicitly selected “本次豁免独立评审，全部检查通过后直接发布”. This covers the integration/preparation PRs, develop-to-master production merge and macOS publication. The independent-review exception applies only to this release; it is not an independent approval or permission to bypass CI/server protection. The authorized GitHub account is `yl1664907302`. No admin bypass, direct protected-branch push or auto-merge is used.

## Integrated changes and Dev evidence

Integration PR [#224](https://github.com/Clean-Lakes/Lake/pull/224) merged as `a34f92430cacd31273e22134359dcdd89f6b92cd`; its tree exactly matches validated topic `2116c4718e59279d183a9ea2976d76a523f7174e`. Preparation PR [#225](https://github.com/Clean-Lakes/Lake/pull/225) merged as frozen develop `cd3e7c6273796c9a135e66a1b75fda3733b2dc12`; its tree exactly matches local release-test source `307112a2494dce2d0e3649199423d44edf626167`. Both merged topic branches were cleaned up locally and remotely.

The current heads of source PRs #222 (`f62a11585edf95935e007d164536a53c0c459656`) and #223 (`b81154536f4057954a08f13c11b4ba4aebec5544`) are ancestors of the final integration head. Both PRs were closed as superseded by #224 after this proof; they were not represented as individually merged. Their source branches remain because other worktrees occupy them; their work and files were not removed.

Latest clean signed Dev `52bbc588a6d577512a15a6ce0fb610e2f4e93f42` passed all 817 frontend tests, Web typecheck/build, native navigation, real transport failure/retry and light/dark/narrow checks. See [reconnect validation](../acp-agent-execution/quiet-reconnect-2026-11-13.md). Earlier same-branch ACP/SDK integration, six genuine specialist responses and persistence checks keep their exact tested SHAs in [conversation integration](../acp-agent-execution/pilot-conversation-integration-2026-11-13.md). Application source is identical to the release candidate; VERSION, release notes and validation documents differ.

The release includes managed ACP execution, native/ACP specialist conversation participation, combined summaries only when requested, task reporting, Pilot configuration management, precise resource directory search, structured receipt handling, the user-selected SSH trust policy, specialist task lists and compact navigation. Existing TypeScript parity gaps remain documented. Task reports do not independently verify business outcomes or rewrite historical unknown operations.

## Frozen-candidate validation

`scripts/verify_lake_release.sh` passed on clean `307112a2494dce2d0e3649199423d44edf626167`: Node 24.14.0 typecheck/build, 309 TypeScript source tests (305 pass / four existing conditional skips), 259 SDK/host tests (253 pass / six opt-in skips), complete Go tests and vet, Web typecheck/all 817 tests/build, signed formal desktop package, native update/window executables and all ten macOS installer tests. Separately enabling the pinned real Codex adapter passed all six opt-in integrations against isolated local synthetic Responses services, with no production credentials or business infrastructure.

Additional Dev provenance (19), branch-policy (4), Memory-tooling (6), macOS publisher (8), ADK boundary, backend naming (zero violations), version/platform/link and diff checks passed. Local Go tests are non-race; cloud race results are recorded below.

The candidate's signed SEA passed import-only preparation without a listener/runtime record; authenticated bootstrap/catalog, precise PID/Home/data identity, graceful drain and two starts; preservation of an original marker; and rejection of mixed Dev/production flags before writing. ZIP extraction and readonly DMG mounting passed deep/strict signatures, clean source/version/runtime/backend identity, arm64 and minimum macOS 13.5 checks. Certificate SHA-256 `377ee437dfbfdde4abf3acc055fa5892bd9d0625b762ac3b825091dba3a086e6` matches the prior releases. Candidate backend SHA-256 is `2f83af1fa2d6d54356d08845a93393b723cc62c066dfec5b8a5ef88b6854e2f2`; this is not the final published master binary.

## Production checks and merge

Production PR [#226](https://github.com/Clean-Lakes/Lake/pull/226) passed [verification run 43397674178](https://github.com/Clean-Lakes/Lake/actions/runs/43397674178) at exact frozen head `cd3e7c6273796c9a135e66a1b75fda3733b2dc12`: macOS runtime, all three complete Linux Go race/vet groups and workbench succeeded. Branch-policy passed, no unresolved review thread or changes-requested review remained, and the current user's release-specific review exception was recorded before merging.

It merged using merge commit `4fe9c9a3017f4867eae9b36cf685b95289930d3f`, retaining parents `48ffda34e9d0244d3dd4b42baf89bba95e3baea4` and `cd3e7c6273796c9a135e66a1b75fda3733b2dc12`. Tree `130ee9bb25bbda6546a77fa95086bcd5ac5167e6` exactly equals tested PR merge `120365fb45c7d32d3ed6f7cdecb51fc1143563b7` and the local candidate tree. The merge used no admin flag, auto-merge or direct protected-branch push.

After fast-forwarding local master to exact origin/master, `scripts/build_lake_desktop.sh` rebuilt the clean formal package without installing production. The final packaged SEA and ZIP/DMG passed the same isolated preparation, two-start/drain, identity, mixed-profile, archive, version, runtime, arm64 and persistent-certificate checks. Published backend SHA-256 is `edcccd226c7f1ac7b569500dac1d76a36127b0cf48a9a7b97254882f55e00677`.

The master and develop protection endpoints both returned “Branch not protected” (HTTP 404); server-side enforcement is not represented as enabled. Required local and production-PR gates were still checked. The automatically attached Windows workflow failed in the frontend test “compiled lookup preserves the inspected PATH and never executes discovered programs” with `spawnSync /bin/sh ENOENT`; it is outside this macOS-only release's validation/asset scope, is not called passed, and was not rerun or used to publish a Windows package.

## Published assets

[Lake v0.3.33](https://github.com/Clean-Lakes/Lake/releases/tag/v0.3.33) was published at `2026-11-13T09:23:18Z` as stable/latest, not draft/prerelease, with target_commitish `master`. The immutable tag points to `4fe9c9a3017f4867eae9b36cf685b95289930d3f`. Exactly four macOS assets were downloaded again and matched local bytes, GitHub asset sizes/digests and both checksum files.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Lake-0.3.33-macos-arm64.dmg | 81554901 | `ff142ae25505b135f94bbcecf705d8aba6f5172bf04c975525746f42096f85aa` |
| Lake-0.3.33-macos-arm64.dmg.sha256 | 94 | `eeb092992c3a1c6b12e1a3560cd714a99bdba2fc59c7dd192b7830db06d6b419` |
| Lake-0.3.33-macos-arm64.zip | 68060226 | `6d23b7cdf76a762ab44dcb28da62155e80f286422248aa6b6cae55e3ef65f807` |
| Lake-0.3.33-macos-arm64.zip.sha256 | 94 | `34c52f76e158d69e50e7986621b6406423ad9d9ce11ea38adbcd7d4a4df4880d` |

## Distribution and rollback

Only macOS Apple Silicon arm64 ZIP, DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing identity is retained; Apple Developer ID notarization is not claimed. Package validation uses private isolated temporary Home/data without production credentials. The user's production app was not installed, restarted or pointed at Dev data.

Existing update preparation/readiness rollback remains in force; old clients retain their own installer limits. Stop the backend before restoring compatible application/data backups, preserve operation/security records and do not mix Dev and production data. The immutable release tag points to exact clean master, with stable metadata using target_commitish master. Production history and this evidence are synchronized back through a separate PR to develop.
