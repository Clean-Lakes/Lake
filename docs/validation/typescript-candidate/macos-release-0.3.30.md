# TypeScript macOS 0.3.30 release preparation

Date: 2026-11-09. The user explicitly authorized merging PR #210 into develop and publishing a formal macOS-only release. PR [#210](https://github.com/Clean-Lakes/Lake/pull/210) merged as `1dd2448174dde62c50dd1226b0d3a41c4f993c5a`. Its tree exactly matches reviewed functional/topic head `72f3700a957f67c8620dc11b6e48857310d556aa`; the topic branch was cleaned up after verifying that equality.

## Candidate and functional evidence

This preparation changes VERSION to 0.3.30 and macOS release notes only, plus this validation record. Functional signed Dev source `189a7e5e0f5ca01b58453baf3002e92cd87b9638` passed the real-model local-file task, native light/dark/narrow-window inspection and dual-channel conclusion checks. The PR head adds validation documentation only. Full evidence and its limits are in [the final-report record](final-report-2026-11-09.md). The production screenshot's existing report was not treated as a missing-report reproduction.

The repair uses a single native SDK Stop continuation in the same Worker/root, without new business I/O. It retains original current permissions, task acceptance, ledger and unknown outcomes; normal complete/partial reports and pending input do not request repair. A model that ignores the reminder is reported incomplete. This release does not claim full legacy parity.

## Validation and publication gates

Final candidate release verification, signed packages, isolated production-profile startup, archive checks, automatic production-PR checks and independent review are pending at this initial preparation commit. Tested SHAs and actual outcomes will be recorded after execution. No pending check is claimed as passed. The final published build must be rebuilt from clean exact merged master.

## Distribution, scope and rollback

Only macOS Apple Silicon arm64 ZIP/DMG and their SHA-256 files are selected, requiring macOS 13.5+. The persistent Lake Local Development Code Signing identity is used; Apple Developer ID notarization is not claimed. No Windows package is built or published for this release. The existing TS parity and default-disabled new Memory scopes are unchanged; see the release notes for remaining limitations.

No production application is installed or restarted during package validation. Tests use isolated temporary Home/data without production credentials. Upgrade with active work finished and an application Home backup; TS history does not synchronize backward into Go. The existing installer prepares replacement data before its readiness check and restores the prior app on failure. Clients at 0.3.27 or earlier retain their old installer deadline and may need manual installation. Stop the backend before restoring compatible app/data backups; never erase ledger records or mix Dev and production data.
