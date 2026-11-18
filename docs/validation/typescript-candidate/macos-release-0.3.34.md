# macOS 0.3.34 resource connection release candidate

2026-11-17. The user requested fixes for legacy service configuration/Kubernetes and fourteen additional scene-grouped connections in both release and Dev. PR [238](https://github.com/Clean-Lakes/Lake/pull/238) was explicitly authorized and merged as `ae5de678ede42553edcd6778ee934d59c1305f7b`; identical-tree verification and topic cleanup completed. This document does not claim authorization for a production release PR, production merge or installation.

## Candidate scope

The candidate prepares VERSION 0.3.34 and macOS release notes through an ordinary develop PR, including the Redis RESP2 follow-up `cda2f38613316c9a144e970b2db85d37e2fd4751`. Compared with the installed production 0.3.33 source `4fe9c9a3017f4867eae9b36cf685b95289930d3f`, the develop batch also includes scoped external MCP/Pilot channels (PR 232), specialist/result presentation (PRs 233–235) and official Codex App Server integration (PR 236). It is a batch promotion, not an isolated protected-branch hotfix. Open PR 237 is not included in this candidate.

The connection changes adapt only proven legacy management permissions, support Kubernetes credential/configuration/version testing, and select RESP2 for Redis probes. They do not delete policies, expand old Worker resource ceilings, replay unknown operations, provide complete Security management/recovery, or implement Kubernetes Agent query/action tools. Release notes preserve these limits.

## Validation before production authorization

- Feature `8c4c43c2` passed backend typecheck/bundle, 303 CJS and 359 TypeScript source tests (existing conditional skips recorded separately), all 949 frontend tests/typecheck/build, affected Go tests/vet and boundary/naming checks. The additional legacy adapter regression passed separately.
- Redis follow-up `cda2f386` passed typecheck/bundle and all 34 Kubernetes/service integration tests with no skips/failures. Its new RESP2-only wire regression failed before the change and verifies exact password-only/ACL AUTH, SELECT/PING and wrong-credential rejection without persisting draft secrets.
- Signed daily Dev integration `497a7f6c89f247f103cc82856cda35c45eeb069f` preserves previously installed source `3e5f73e9`, plus the merged connection fixes and Redis follow-up. It is clean; installed binary digest matches the build-origin manifest. Daily Dev's additional unmerged specialist baseline is retained locally and is not silently included in this candidate.
- Fourteen connection entries have been added through authenticated Dev APIs with exact endpoint matching and scene placement. Prior resources and policy bytes were preserved. Subsequent observations and duplicate audit are recorded in the connection validation document; private source files/credentials are not committed.

Clean preparation `ca6431dc4a25686a0b5b40698bcde628775be5f3` built a signed 0.3.34 Dev package. The packaged SEA's isolated-Home smoke test passed bootstrap, exact PID/Home/runtime identity, Kubernetes create/test, RESP2-only Redis create/test (AUTH/SELECT/PING only) and normal drain. Deep/strict signature and manifest/binary digest verification passed. Backend SHA-256: `14e4d8008ffdbe020ee159f871541f9c2ec78bb2c989d35f1d217325b658ac99`. Subsequent preparation changes are validation/plan documents only.

Daily Dev's fourteen imports are idempotent: repeated runs report 0 creates/14 skips, count 165, unchanged prior resources/policy and no duplicate service endpoints. Eleven actual API probes passed across the observed attempts. Three Jushan Redis resources have valid directly tested RESP2 credentials but later Dev probes encounter transport resets/timeouts; no continuous network/service health is claimed. Native light/dark and narrow-window form/menu/focus clipping checks were completed and preferences/window restored.

Production-PR CI results are appended when performed. Daily Dev and production retain their separate Homes and credentials. No production process has been restarted or application replaced during preparation.

## Promotion and rollback

After explicit authorization, merge the preparation PR to develop, verify its exact head, then create a same-repository develop-to-master PR. Require the branch-policy/workbench checks and an independent release review under `docs/development-workflow.md`; any user-requested exception must be explicit for this release and cannot bypass server protection. Recheck the candidate if develop changes.

After an authorized merge, verify the merge commit/tree, use the signed build script from clean production source and perform an authorized local production installation. Before replacing the running production app, inspect active work, stop through the normal lifecycle, and preserve private application/Home rollback copies. Register the fourteen connections through the new authenticated production API, using independent private credential files and exact deduplication. Verify probes, retained resources and unchanged policy bytes before reporting completion.

Distribution/publication is a separate operation. No public tag, GitHub Release or release-asset publishing action is part of the local installation preparation above.
