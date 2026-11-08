# TypeScript macOS 0.3.28 release preparation

Date: 2026-11-08. Functional source tested: `59f21211df215965ecadf7c56d4ae1a3d715326b` (clean). Integration base: `b0802ba96bb87ff7c8b66427bd71b7158c9feea0` after authorized PRs #197–#199. The user explicitly requested the current TypeScript backend for this macOS-only release after the Dev-only restriction and incomplete parity were explained. This is a distribution authorization, not full parity evidence.

## Local results

| Check | Result |
| --- | --- |
| Pinned SDK TypeScript typecheck and runtime bundle | Passed |
| TS source tests (`tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts`) | 211 passed, 4 existing external integration skips |
| Bundled runtime integration (`node --test runtime/typescript/*.test.cjs`) | 175 passed |
| React tests (`pnpm --dir web-agent test:frontend`) | 762 passed |
| Installer (`python3 scripts/test_lake_macos_installer.py`) | 9 passed, including production preparation, missing Home, migration failure/timeout and rollback |
| Native LakeUpdateTests / LakeWindowTests | Passed |
| Dev preflight/provenance tests | 19 passed |
| Memory compatibility tooling / branch policy tests | 6 / 4 passed |
| Backend naming / ADK boundary / shell syntax / diff whitespace | Passed |
| Legacy Go race regression at the unchanged integration base | All packages passed across the initial full run and the rerun of assets/web, cmd/lake and internal/web after staging generated embedded web assets; initial invocation itself failed setup for those packages |
| Legacy Go vet at integration base | Passed |

## Signed application validation

`scripts/build_lake_desktop.sh --dev --install` installed only Lake Dev with its original isolated Home. Manifest: version 0.3.28, TypeScript, clean source above, backend SHA256 `abad7471037ae9986b3229bb08536624567ea0353fa49f7bb1ecc76f47ffa285`. Deep/strict signature verification passed. Native UI opened, restored the existing specialist/history, showed Pilot as the built-in 话事人, and preserved latest-round and expandable previous executions. No model request or cloud operation was issued by this UI review. The light theme and previous specialist channel remain selected.

`scripts/build_lake_desktop.sh` built the formal bundle without installing or restarting production. Manifest: same clean source, backend SHA256 `7a58f1ca8239bcee4f44f92b60521f40f02dd6f869f8a947048ba9c61cf6b44a`. Deep/strict signature verification, version contract `Lake 0.3.28 TypeScript`, production bundle ID/runtime and both archive checksums passed. A temporary isolated Home exercised the actual signed SEA twice: production bootstrap and exact lifecycle identity, catalog API, authenticated drain, restart, preparation-only mode with no listener/runtime record, preserved original marker, and rejection of mixed identities before creating a Home. These fixtures never use real production data.

The isolated production migration integration preserves the original public settings, private credential file and both legacy databases, imports stable identities/history idempotently, and performs zero model calls or historical operation replay. Preparation exits before Workers, Watchdog, queue or Memory services start. This does not prove migration of every real production history.

## Remaining gates and rollback

The parity report remains deliberately unchanged: 133 pending UI operations, 20 domains awaiting full parity, cutover allowed false. Current capability gaps and update boundaries are stated in the release notes; publication does not mark these as verified. Original databases, Security and unknown-operation gates remain authoritative. TS history does not synchronize backward into Go.

The new installer can prepare a TS replacement before its UI readiness deadline. Updates initiated by 0.3.27 or older run their old installer and retain the old 45-second total deadline; unusually large first imports may roll back and require manual ZIP/DMG installation. No legacy installer is retroactively upgraded.

Production PR automatic checks, independent review, merge and exact-master rebuild/publication remain pending at this document's preparation point. No release/tag is published by this evidence commit. Final package provenance must identify the actual merged master SHA.

## Production PR infrastructure follow-up

Preparation PR #200 merged into develop as `b896c49288849ae3a7e964e944c6ffeb60dfc5d3`; its tree matches the recorded preparation head. Release PR #201 targets master from same-repository develop. The first macOS workbench run was cancelled before any step: GitHub reported `macos-14-arm64-us-default is not supported` (run 42488245003). The follow-up changes only its runner to the officially documented standard `macos-15`, retaining all checks and PR-only triggers. No cancellation is counted as a pass; production review and the new automatic checks remain required.

The signed SEA Mach-O `LC_BUILD_VERSION` reports `minos 13.5` (`xcrun vtool -show-build bin/lake`). The follow-up also aligns the desktop deployment target, LSMinimumSystemVersion and current release documentation to macOS 13.5, replacing the previous inaccurate 13.0 package declaration. Native library tests remain independent of the packaged Node runtime.

## Unready replacement cleanup

Functional follow-up `05fa57ea6e14c8edc6c99cd6f4fbc5aa96436554` registers a newly spawned, owned backend PID in the existing update receipt immediately after Process.run, before waiting for migration/health/UI readiness. Previously App wrote it only after Backend.start succeeded, leaving older installers without a PID to terminate on first-import timeout. Reused independent services are not registered as owned. Native build, LakeUpdateTests and LakeWindowTests passed. Installer tests now pass 10/10, including an unready replacement process which is actually terminated on rollback; original data remains intact. The user explicitly directed proceeding without waiting for independent review and excluding Windows from this macOS release; those instructions are recorded in PR #201 and do not count as an independent review or a Windows pass.

## Verification platform separation

macOS workbench run 42488511860 failed in two legacy Go fixtures: the archived-task Router test exceeded the existing production 90-second invocation deadline after making a real provider request (161.39 seconds including setup); the 35-read SRE fixture reached batch 29 but exceeded the existing 45-second test wait (48.19 seconds total). Original results remain failures. The same integrated source completed the Linux full Go regression in run 42488511838 (14:14:18–14:19:11 UTC). No production timeout, fixture assertion or test count is changed.

The follow-up runs the exact full Go race/vet command on Linux as legacy compatibility, keeps TS source/runtime/frontend/native/installer verification on macOS, and makes required workbench aggregate both jobs with explicit success checks, including failures/skips. Current macOS production bundles contain no Go backend. This retains coverage without pretending the failed legacy macOS fixture passed; complete legacy Go-on-macOS performance parity remains unverified. Windows remains outside the user-selected release scope.
