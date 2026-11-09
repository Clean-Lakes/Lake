# TypeScript macOS 0.3.29 release preparation

Date: 2026-11-09. Clean candidate tested: `7ea6564a5aedbe5107429b353d5e5f726c624b54`. Functional PR [#206](https://github.com/Clean-Lakes/Lake/pull/206) merged into develop as `fc85bf92595cc5cb019b602f59eb8da416d92c95`; this candidate adds only VERSION and macOS release notes. The user explicitly authorized a formal release with the current TypeScript backend and macOS-only assets. This is distribution authorization, not full legacy parity evidence.

## Local results

`scripts/verify_lake_release.sh` completed successfully on this candidate. Its actual checks are recorded separately from the additional tooling checks:

| Check | Result |
| --- | --- |
| Signed TypeScript backend, pinned SDK typecheck and runtime bundle | Passed |
| TypeScript source tests | 245 passed, 4 existing conditional skips (Claude-Mem fixtures / Linux scanner) |
| Bundled runtime integration | 185 passed |
| Full legacy Go compatibility regression (`GOWORK=off go test ./...`) | Passed; no local race claim |
| Full legacy Go vet | Passed |
| Web typecheck and frontend tests | Passed; 768 frontend tests |
| Signed formal desktop build | Passed |
| Native LakeUpdateTests / LakeWindowTests | Passed |
| macOS installer tests | 10 passed |
| Persistent signing identity verification | Passed |
| Additional Dev provenance / publisher / branch-policy / Memory tooling tests | 19 / 8 / 4 / 6 passed |
| ADK runtime boundary / backend naming | Passed; zero naming violations |

Functional Dev testing before the documentation/version-only preparation used `b152f48bd779640e8cbaf607952ff104d1ec2d3a`. It resumed the existing server-statistics task with a real SSH command containing glob/redirection, produced a successful command result, and preserved the original unknown ledger rows unchanged. These observations do not claim the old unknown operation succeeded or that every observed boot was abnormal. Current commands remain subject to current permissions, resource scope, SSH trust, stop and explicit read-only contracts.

## Signed packages and Dev startup

`scripts/build_lake_desktop.sh` built the formal candidate without installing or restarting the production application. Its manifest records the clean candidate SHA above, TypeScript runtime and backend SHA256 `e9c43c40b6d8f1cfe74056958d942beb5386ffb03bf43657ff9ad0bf652263cc`. Deep/strict signature, production bundle identity, 0.3.29 version contract and both archive checksums passed.

The actual signed SEA ran twice against a temporary isolated Home: preparation-only mode created no listener/runtime record; authenticated production bootstrap and catalog API worked; exact Home/data/PID identity, drain and restart passed; mixed Dev/production flags were rejected before creating a Home. An original marker stayed unchanged. ZIP extraction and read-only DMG mounting independently verified signatures, clean candidate provenance, TypeScript and minimum macOS 13.5. No real production Home, secrets or application was used by these fixtures.

After stopping only the old Dev backend through its native menu, `scripts/build_lake_desktop.sh --dev --install` installed `~/Applications/Lake Dev.app`. Its clean manifest records the same candidate and backend SHA256 `09e88c80d0ca7077e5b7f5782adbe9e0649d6a3cb4f4989402652562e0b52ffe`. Bundle ID is `com.cleanlakes.lake.desktop.dev`, version 0.3.29; deep/strict signature passed. Native startup restored the existing 发布专员 channel and its completed reply, five specialists including built-in Pilot 话事人, resource directory and unified composer. The existing light theme/channel stayed selected. This startup review issued no model request or remote command; no new dark-theme claim is made.

## Scope, remaining gates and rollback

Only macOS Apple Silicon arm64 ZIP, DMG and their two SHA-256 files are selected for publication, requiring macOS 13.5+. The persistent Lake Local Development Code Signing certificate is used; Apple Developer ID notarization is not claimed. Windows is outside this release's assets and validation scope.

The TS parity matrix remains unchanged. Attachment/image support, context compression/fallback/file recovery, some Kubernetes/legacy adapters, workflow/schedules, complete security recovery, same-turn supplementation and other-platform gaps remain documented in the release notes. New-scope Memory is disabled by default and old Go Memory is not automatically imported. Historical unknown operations remain unknown; removing the command-history gate does not turn them into successful evidence or automatically replay their call IDs. Other adapters retain their reconciliation contracts.

Before upgrading, finish active work and back up the application's own Home. TS history does not synchronize backward into Go. The updated installer prepares a TS replacement before its readiness deadline and restores the previous application on preparation/readiness failure. Clients at 0.3.27 or earlier still use their old 45-second total installer window; large first imports can require manual ZIP/DMG installation. Stop the backend before restoring a compatible application/data backup; do not mix Dev and production data or delete safety records.

At this preparation commit, production PR automatic branch-policy/workbench, independent review, production merge and exact-master rebuild/publication remain pending. No tag or Release is published by this evidence commit. Final published artifacts must identify the actual merged master commit. Repository branch protection is currently unavailable (GitHub returns 404 for both branches); documentation and local workflow do not substitute for server enforcement.


## Published production result

Release PR [#208](https://github.com/Clean-Lakes/Lake/pull/208) merged with a merge commit at `f9ada8211804d2411984245106b4390a87c22a48`. Its parents are previous production `e810ff3bde3a3ca9a9f7d3401aea127e2103fe69` and frozen develop `b87053c697e774c066b1d6451ce64f0dcb6b0c61`. The final tree equals tested PR merge `51bb4846244c6e6b0df217d3ad1a529b48d04d15` (tree `2bc1122f5b236ae3250c5ffcaf5304cfc22b9e0d`). Required branch-policy and [workbench run 42587143690](https://github.com/Clean-Lakes/Lake/actions/runs/42587143690) passed, including macOS and all three complete Linux Go race/vet groups. Windows failed and was explicitly outside the user's macOS-only release scope; it is not recorded as a pass or published asset.

After the review requirement was explained and the concrete PR/candidate prepared, the user explicitly instructed “直接发布” for this release. That exception is recorded in PR #208 and does not count as an independent review. No admin bypass, direct protected-branch push or skipped required check was used.

`scripts/build_lake_desktop.sh` rebuilt the formal application from clean, exact master. The actual signed SEA passed isolated production preparation with no listener/runtime record, authenticated bootstrap/catalog, exact Home/data/PID identity, drain, restart, preserved original marker and rejection of mixed profiles before Home creation. ZIP extraction and read-only DMG mounting confirmed signature, version, TypeScript, exact master and minimum macOS 13.5; both executables are arm64. Backend SHA256: `3d2df6cd5c0844eaa5737641bf44ae43edc638b9c5a7c9e3290d903f7e376819`. The production application was neither installed nor restarted, and its Home/secrets were not accessed by the validation fixtures.

[Lake v0.3.29](https://github.com/Clean-Lakes/Lake/releases/tag/v0.3.29) published at `2026-11-09T09:09:15Z`, stable/latest with target_commitish master. The immutable Git tag resolves to the exact production commit. Downloaded all four public assets and checked their bytes, sizes, API digests and checksum-file contents against the local signed packages. Exactly four macOS assets are present:

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Lake-0.3.29-macos-arm64.dmg | 79897592 | `952429a188ed6ca0ea2195556488cad67b537f055c839270549a4d37f1346cc3` |
| Lake-0.3.29-macos-arm64.dmg.sha256 | 94 | `3528b754d002c4a86a2a0d7b957973b2b044d39049c50da3e0991350da23d76f` |
| Lake-0.3.29-macos-arm64.zip | 67178912 | `f0b44b0cb842ea8d43cbbad155d92cb3d441252f98397bb089361f81fe233a52` |
| Lake-0.3.29-macos-arm64.zip.sha256 | 94 | `373ef91bfafe38477e40e93cfd5fe79cc89871e7785e61ea2a54cd5d6abbc20d` |

Production history and this evidence are synchronized to develop through a `sync/v0.3.29 -> develop` PR with a merge commit. Published artifacts remain bound to the production commit above; full TS parity remains pending as documented.
