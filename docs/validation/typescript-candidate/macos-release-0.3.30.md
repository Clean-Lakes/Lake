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

This record update changes documentation only. Functional native Dev evidence remains tied to its actual tested source above, rather than claiming a repeated native inspection of version-only changes. Automatic production-PR branch-policy/workbench, independent review and production merge are still pending. The final published build will be rebuilt and package-tested from clean exact merged master. GitHub currently returns 404 for master branch protection; local/documented rules are not server enforcement.

## Distribution, scope and rollback

Only macOS Apple Silicon arm64 ZIP/DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing identity is used; Apple Developer ID notarization is not claimed. No Windows package is built or published for this release. The existing TS parity and default-disabled new Memory scopes are unchanged; see the release notes for remaining limitations.

No production application is installed or restarted during package validation. Tests use isolated temporary Home/data without production credentials. Upgrade with active work finished and an application Home backup; TS history does not synchronize backward into Go. The existing installer prepares replacement data before its readiness check and restores the prior app on failure. Clients at 0.3.27 or earlier retain their old installer deadline and may need manual installation. Stop the backend before restoring compatible app/data backups; never erase ledger records or mix Dev and production data.
