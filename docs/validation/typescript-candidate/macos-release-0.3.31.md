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
