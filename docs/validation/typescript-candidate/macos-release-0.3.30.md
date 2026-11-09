# TypeScript macOS 0.3.30 release preparation

Date: 2026-11-09. The user explicitly authorized merging PR #210 into develop and publishing a formal macOS-only release. PR [#210](https://github.com/Clean-Lakes/Lake/pull/210) merged as `1dd2448174dde62c50dd1226b0d3a41c4f993c5a`. Its tree exactly matches validated functional/topic head `72f3700a957f67c8620dc11b6e48857310d556aa`; the topic branch was cleaned up after verifying that equality.

## Candidate and functional evidence

This preparation changes VERSION to 0.3.30 and macOS release notes only, plus this validation record. Functional signed Dev source `189a7e5e0f5ca01b58453baf3002e92cd87b9638` passed the real-model local-file task, native light/dark/narrow-window inspection and dual-channel conclusion checks. The PR head adds validation documentation only. Full evidence and its limits are in [the final-report record](final-report-2026-11-09.md). The production screenshot's existing report was not treated as a missing-report reproduction.

The repair uses a single native SDK Stop continuation in the same Worker/root, without new business I/O. It retains original current permissions, task acceptance, ledger and unknown outcomes; normal complete/partial reports and pending input do not request repair. A model that ignores the reminder is reported incomplete. This release does not claim full legacy parity.

## Validation and publication gates

Clean version/source candidate tested: `ea9b2cd830c713fbc09196817b4d0a3528dca449`. `scripts/verify_lake_release.sh` completed successfully:

| Check | Result |
| --- | --- |
| Signed TS backend and pinned SDK typecheck | Passed |
| TypeScript source tests | 251 passed, 4 existing conditional skips |
| Bundled real SDK integration tests | 188 passed |
| Complete legacy Go compatibility and vet | Passed; local non-race test, CI race run separately pending |
| Web typecheck, frontend suite and production assets | Passed; 768 frontend tests |
| Signed formal desktop build | Passed |
| Native update and window test executables | Passed |
| macOS installer tests | 10 passed |
| Dev provenance / publisher / branch policy / Memory tooling | 19 / 8 / 4 / 6 passed |
| ADK boundary / backend naming / whitespace | Passed; zero naming violations |

The formal candidate uses TypeScript, version 0.3.30 and clean source provenance above. Backend SHA256: `0c2d2bb126ddfcce14c0324efed8638b98bc6950814ae8efd9928b4e067b798d`. The actual signed SEA passed isolated preparation-only with no runtime record/listener, authenticated bootstrap/catalog, exact PID/Home/data identity, graceful drain, two starts and preservation of the original marker. Conflicting Dev/production flags were rejected before creating the requested Home. ZIP extraction and read-only DMG mounting independently passed deep/strict signature, version, runtime, minimum macOS and source checks; both archive checksums match.

This record update changes documentation only. Functional native Dev evidence remains tied to its actual tested source above, rather than claiming a repeated native inspection of version-only changes. At this preparation stage, automatic production-PR branch-policy/workbench, independent review and production merge were still pending. Final production checks and the explicit review exception are recorded below. GitHub currently returns 404 for master branch protection; local/documented rules are not server enforcement.

## Distribution, scope and rollback

Only macOS Apple Silicon arm64 ZIP/DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing identity is used; Apple Developer ID notarization is not claimed. No Windows package is built or published for this release. The existing TS parity and default-disabled new Memory scopes are unchanged; see the release notes for remaining limitations.

No production application is installed or restarted during package validation. Tests use isolated temporary Home/data without production credentials. Upgrade with active work finished and an application Home backup; TS history does not synchronize backward into Go. The existing installer prepares replacement data before its readiness check and restores the prior app on failure. Clients at 0.3.27 or earlier retain their old installer deadline and may need manual installation. Stop the backend before restoring compatible app/data backups; never erase ledger records or mix Dev and production data.


## Frozen integration and production checks

The frozen develop candidate `bda98fbc4ad98fd1a12f2e6e852ced6f164c7d2c` was independently rebuilt as a clean signed formal package (without installation). The same actual SEA preparation/start/drain/restart checks and ZIP/DMG identity/signature checks passed. Its backend SHA256 was `342f8f2f95a295c84abf70358235b290ac85353f59f54885957a0a03030d49be`; this intermediate candidate is not confused with the published master package.

Release PR [#212](https://github.com/Clean-Lakes/Lake/pull/212) passed branch-policy and [workbench run 42607394908](https://github.com/Clean-Lakes/Lake/actions/runs/42607394908), including macOS and all three complete Linux Go race/vet partitions. Windows failed and is explicitly outside this macOS-only release's validation/asset scope; it is not counted as passed. No required check was skipped or weakened.

After the current repository review rule and concrete PR #212 were presented, the user explicitly replied “直接发” for this 0.3.30 release. This is recorded as the current independent-review exception, not an independent review or reuse of the previous release's exception. No admin bypass, direct protected-branch push or auto-merge was used.

The release merged with a merge commit at `f57491c259828a06062eaadfb61e0f923c5f6fef`, with parents `f9ada8211804d2411984245106b4390a87c22a48` and `bda98fbc4ad98fd1a12f2e6e852ced6f164c7d2c`. Its tree `af9644612f56b9971f8f1d99d19412cb562f63ec` equals the actual CI PR merge `de07a01ff690d74882ef40371f93557fffcb41b8`. Local master was fast-forwarded/created at exact origin/master and remained clean for the final build.

## Published result

The final formal application was rebuilt from clean exact master `f57491c259828a06062eaadfb61e0f923c5f6fef` using `scripts/build_lake_desktop.sh`, then passed deep/strict signing, arm64/version/runtime/source identity, isolated preparation-only, exact PID/Home/data bootstrap/catalog, graceful drain/restart, unchanged original marker, conflicting-profile rejection and ZIP/DMG archive checks. Backend SHA256: `f0645c9fb2dc6036419670f3fb2f6d55728724d70f4f67ad2ae86c9415dce86b`. Production application/data and credentials were not used by the fixtures; the installed production app was neither replaced nor restarted.

[Lake v0.3.30](https://github.com/Clean-Lakes/Lake/releases/tag/v0.3.30) published at `2026-11-09T11:38:31Z`, stable/latest with target_commitish master. The immutable tag points to the exact production commit above. All four public assets were downloaded and their byte hashes, API digests, sizes and checksum-file contents verified against the signed local packages. There are no Windows release assets.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| Lake-0.3.30-macos-arm64.dmg | 80160093 | `66fff222fb9411d34395bf54d39eb618939d56645d62867ed6b477a8eefbe653` |
| Lake-0.3.30-macos-arm64.dmg.sha256 | 94 | `5b8ccd648e4d21efc0f943c1abc1e4f685ea18f1d090c251aa779a9a7d87b342` |
| Lake-0.3.30-macos-arm64.zip | 67174059 | `9f3230115f6045dc7abbd9d5c20021c79896b361722f2b3de863ebf0a2e3e384` |
| Lake-0.3.30-macos-arm64.zip.sha256 | 94 | `350492fa403adf611ea5710a6c1bf03da253cbd01c2e10dbc171d08e5d3dc027` |

Production history and this record return to develop through a `sync/v0.3.30 -> develop` PR with a merge commit. Published assets stay bound to the immutable master commit; full TS parity and the existing release-note limitations remain unchanged.
