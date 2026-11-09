# TypeScript macOS 0.3.31 release

Date: 2026-11-09. The user explicitly requested publishing the repaired version immediately without another confirmation. The existing macOS-only / current-TypeScript scope remains in effect. This authorizes the repair PR merge, release preparation, develop-to-master production PR/merge and macOS stable publication for 0.3.31. The user also explicitly directs proceeding without another independent-review question; this is a current release-specific exception to the documented review requirement, not an independent review, reuse of an earlier exception or permission to bypass required CI/server protection. No admin bypass, direct protected-branch push or auto-merge is authorized or used.

## Integrated changes and Dev evidence

PR [#214](https://github.com/Clean-Lakes/Lake/pull/214) merged as `48284ec1ea05056fd1549e077509a94d38c07274`. Its tree exactly matches validated topic head `5c2126a6dfa89f30a3f96f0bc0e9869a423248f3`; the topic branch was cleaned up after verification. This preparation changes VERSION to 0.3.31, macOS release notes and this record only.

Clean functional Dev `b4ca4b28ef2fca282996560e96ba0fce52e85bf9` includes both Pilot permission inheritance and concise final conclusions. The signed build/install, real-model one-paragraph reply (91 characters), explicit detailed-report exception and identical Pilot/channel deliveries passed. Earlier same-PR real-model automatic-on/off command execution and native approval behavior passed on `930eea08c455ad43ba9575aaf7d3c0bf0a5aa7f5`. Full evidence: [permissions](pilot-operation-permissions-2026-11-09.md) and [concise conclusions](concise-final-summary-2026-11-09.md). Historical production messages and pending approvals were not changed. No real infrastructure access was used by the fictional-record/local-print fixtures.

The shared Pilot category switches govern files, commands, database reads, MCP and Skills. Explicit deny, current resource/connection/credential/SSH trust, Plan/read-only, cancellation, generations, deadlines, Memory and host acceptance remain separate checks. A short conclusion is model communication guidance; there is no truncation, extra summarizer or inferred task success. The existing TypeScript parity limitations remain in the release notes.

## Release validation

Clean version/source candidate tested: `322ac3642c0844848cf0f917e752c8f107f1f77d`. `scripts/verify_lake_release.sh` completed successfully. TypeScript typecheck (pinned Node 24.14.0), 251 source tests / four existing conditional skips, all 208 SDK integrations, complete legacy Go compatibility and vet, Web typecheck / 768 tests / production build, signed formal desktop build, native update/window executables and all ten macOS installer tests passed. Additional Dev provenance / publisher / branch-policy / Memory tooling suites passed 19 / 8 / 4 / 6 tests. ADK boundary, backend naming (zero violations) and diff checks passed. Local Go here is non-race; automatic Linux race partitions are checked in the production PR.

The candidate manifest records TypeScript, 0.3.31, clean source above and backend SHA256 `b997f1884811bf734298e397918f846615b0bcacee7a25ccbe8c35e64b641253`. The actual signed SEA passed isolated preparation-only (no runtime record/listener), authenticated bootstrap/catalog, exact PID/Home/data identity, graceful drain, two starts, preserved original marker and rejection of conflicting profile flags before writing. ZIP extraction and read-only DMG mounting independently passed deep/strict signing, version/runtime/source and minimum-macOS checks; checksums match.

This update changes validation documentation only. Automatic production-PR branch-policy/workbench, the exact merged master build and public download verification are still pending at this stage; results are appended after completion. GitHub's master protection API reports “Branch not protected” (404); documentation/local rules are not server enforcement. Required release checks are still run and are not bypassed.

## Distribution and rollback

Only Apple Silicon arm64 ZIP, DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing certificate is used; Apple Developer ID notarization is not claimed. No Windows package is built or published. New Memory accumulation/use scopes remain default-disabled; no credentials are copied from production to Dev.

Package tests use isolated temporary Home/data and no production credentials. The installed production application is not replaced or restarted during validation. Existing update preparation/readiness rollback remains in force; old clients retain their own installer limits. Stop the backend before restoring compatible application/data backups; do not erase operation/security records or mix Dev and production data. The asset tag remains bound to exact clean master, and stable update metadata uses target_commitish master.

## Production checks and merge

Preparation PR [#215](https://github.com/Clean-Lakes/Lake/pull/215) merged as `c92f106e513c1b8b0ce2d20160ed91e4d41363cd`, with the exact prepared topic tree. That frozen develop source was rebuilt as a clean signed formal package and passed the same SEA/profile/restart and ZIP/DMG identity/signature checks. Intermediate backend SHA256: `6fe250c0fb88e5bdc95a06ba8e234a895a30b7507a5043bec3065c1ede9616da`; it is not the published master binary.

Production PR [#216](https://github.com/Clean-Lakes/Lake/pull/216) passed branch-policy and [workbench run 42626872587](https://github.com/Clean-Lakes/Lake/actions/runs/42626872587), including macOS and all three complete Linux Go race/vet partitions. Windows failed and is explicitly outside this macOS-only release's validation and asset scope; it is not counted as passed. No required release check was skipped or weakened. The current user instruction to publish without another question is recorded above as a release-specific independent-review exception, not an independent approval.

The production PR merged using a merge commit at `7d14a56131a259604dcf269d60fc9b07b470ff06`, with parents `f57491c259828a06062eaadfb61e0f923c5f6fef` and frozen develop above. Its tree `c7426bda61994d9c6cbac054992c669694c626b1` equals the actual CI PR merge `0eb5c39ebc128a92df104ad727743ff659c63fb5`. Before merging, exact source/base refs, successful check conclusions and zero unresolved review threads were rechecked. No direct protected-branch push, admin bypass or auto-merge was used.

## Published result

Local master was fast-forwarded to exact origin/master and remained clean. `scripts/build_lake_desktop.sh` rebuilt the formal application without installation. The final actual signed SEA passed isolated preparation-only (no runtime listener), authenticated bootstrap/catalog, exact PID/Home/data identity, graceful drain, two starts, preserved original marker and conflicting-profile rejection. ZIP extraction and read-only DMG mounting passed version/runtime/source, minimum macOS and deep/strict signature checks. The signing certificate matches 0.3.30. Published backend SHA256: `5f45024cf170355ed08305949306cf5a50bf68fde6d3b4f9fc6d90623d262734`.

[Lake v0.3.31](https://github.com/Clean-Lakes/Lake/releases/tag/v0.3.31) published at `2026-11-09T14:08:09Z`, stable/latest with target_commitish master. The immutable tag points to exact production commit `7d14a56131a259604dcf269d60fc9b07b470ff06`. All four published assets were downloaded and their byte hashes, API digests, sizes and checksum-file contents matched the signed local packages. No Windows assets are present. Neither the installed production app nor its data/credentials were used or restarted by these isolated tests.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Lake-0.3.31-macos-arm64.dmg | 80166773 | `3e316a5335d120c07550442ba48ab0bf07fe8100c22e5f63843660c1231054b8` |
| Lake-0.3.31-macos-arm64.dmg.sha256 | 94 | `157e3bce762628f40ae28b64fe392b0dd81fd089fd5e90cf7542edb8d97d0b7c` |
| Lake-0.3.31-macos-arm64.zip | 67175006 | `697da5e6d76245fb8908caf67c4cc484fe980ce0c08638ca9399e8705e26d4a1` |
| Lake-0.3.31-macos-arm64.zip.sha256 | 94 | `330020f91cf0558c9eec5a6aabfc1e1f63bbf24b3f0e11b4b6e34fc433f29c06` |

Production ancestry and this evidence return to develop through the `sync/v0.3.31 -> develop` PR using a merge commit. The released assets stay bound to the unchanged master/tag; full TS parity limitations remain unchanged.
