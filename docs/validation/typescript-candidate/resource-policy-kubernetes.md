# Resource connection policy and Kubernetes compatibility

2026-11-17. This increment fixes connection configuration and explicit connection tests in the TypeScript runtime. It does not migrate the complete Security policy-management surface or Kubernetes Agent query/action tools.

## Resulting behavior

- Confirmed legacy projects with matching recovery identity and explicit unrestricted management/probe rules can create, edit and test service connections. Unsupported policy modes, malformed/unconfirmed policies, deny/ask, unsupported limits and stale identities stay closed. Scoped tests require an exact resource identity.
- The original policy record and ResourceIDs are preserved byte-for-byte. Creating a connection does not add that ID to an execution boundary, approve a Worker, replay an operation or replace the Security authority.
- Kubernetes connection forms now create/edit/test with endpoint/token or an uploaded embedded YAML/JSON kubeconfig. Public responses contain metadata and validated version results; secret content remains in the selected private Home.
- Native HTTP/TLS validates embedded CA, client key/certificate and server name, respects explicit TLS settings and bounded deadlines, cancels real I/O, rejects redirects and sanitizes errors. Credential plugins, external files, proxies, impersonation, aliases, duplicate names/keys, multiple documents and excessive inputs are rejected.
- Saving never connects. Tests neither persist draft credentials nor claim overall service health. Existing credential references and IDs survive metadata edits.

## Local verification

All runtime JavaScript/TypeScript checks used the prepared Node 24.14.0 runtime. Current code was tested with:

- TypeScript backend typecheck and runtime bundle, including the pinned YAML 2.9.1 license notice.
- Kubernetes and existing service integration regressions: 32 passed; the additional legacy metric/database/cache adapter case also passed separately (one test, no skips/failures).
- Complete runtime CJS suite: 303 passed, six pre-existing conditional skips, zero failures (309 tests).
- Complete TypeScript unit suite: 359 passed, four pre-existing conditional skips, zero failures (363 tests).
- Frontend: 949 passed, zero skips/failures; TypeScript check and Vite production build passed. The existing large-chunk warning remains.
- `GOWORK=off go test ./internal/security ./internal/kubernetes ./internal/web` passed; local non-race validation.
- `GOWORK=off go vet ./internal/security ./internal/kubernetes ./internal/web` passed.
- `scripts/check_adk_runtime_boundary.py`, `scripts/check_backend_naming.py` and `git diff --check` passed.

The tests exercise actual local HTTP, HTTPS with client certificates, real MySQL/PostgreSQL protocol fixtures and an isolated Redis server. They also verify policy changes during I/O, cancellation, credential privacy and cleanup, cross-project refusal, parser rejection and no networking on save.

## Dev and production integration

The installed Dev currently records clean source `3e5f73e9c01d82681fac5a7a5cfe4dfec8023349` from the separate specialist-followup branch. The feature branch is based on `origin/develop@a847fe0e2352b6c0f44af1dde2b67bb4e9780079`. Its direct installation is correctly refused by the Dev provenance guard. Real Dev validation must preserve that installed source baseline in a separate local integration checkout; do not weaken or bypass the guard and do not add unrelated feature changes to this ordinary PR.

The user's fourteen proxy-backed service/cluster entrances will be imported through the active authenticated APIs after signed Dev validation, using exact endpoint matching and independent credential storage. The prior 99 SSH entrances and their scene directories are retained. Connection credentials must come from actual saved or remote service configuration; the user-provided SSH password is not a database-password default.

No production application replacement, PR merge, tag, release or publication is recorded by the local checks above. Integration/install/import receipts and exact tested commits are appended after the corresponding operations occur.

### Signed Dev verification

The tested feature commit is `8c4c43c26f8128ab7bbface4aa15fee570988bc1`. Local integration commit `60b2d26e80e78e1b4e3f1617186975610eddc9ff` contains both that feature and the previously installed `3e5f73e9` baseline. The ordinary PR does not include those unrelated specialist changes. The integration checkout remains retained because the installed Dev records its provenance.

After confirming no running sessions/goals and only disconnected terminals, the native **停止内核并退出** action stopped Dev normally. `scripts/build_lake_desktop.sh --dev --install` completed signature verification, transactional legacy import and installation. The installed build-origin manifest is clean, records the integration SHA, and its binary SHA-256 matches. The launched TypeScript lifecycle reports `~/.lake-dev`, independently of the running production Home.

On 2026-11-17, the active authenticated Dev API created six missing resources: PostgreSQL 30532 in 南京公司/新k8s集群, StarRocks 9030 in 韦二/数据库, VictoriaMetrics 9986 in 韦二 and 9989 in 鑫隆, and Kubernetes 9981 in 隆泰 and 9982 in 韦二. Project resource count changed from 151 to 157. All prior resources remained equal, the preserved legacy policy bytes had the same digest before/after, and the service endpoint duplicate audit was empty. A second import plan reported **zero creates and six skips**.

Initial real probes passed for VictoriaMetrics 9986 and both Kubernetes endpoints (v1.17.4). PostgreSQL 30532, StarRocks 9030 and VictoriaMetrics 9989 encountered transport timeouts/failures. The same period showed 50% ICMP loss and 1578 ms latency from the local cluster node to 217; these observations do not certify continuous service availability. No failed probe is recorded as a successful connection.

The native Dev Kubernetes editor restored endpoint/auth/namespace/TLS/timeout, kept secrets empty, and completed explicit testing and save. With 217's delayed responses, a 30-second draft test succeeded with v1.17.4 and the imported 隆泰 resource was intentionally saved at configuration revision 2 with timeout 30. Light/dark dialog, input focus and selected AppSelect menu clipping were visually checked; the original follow-system theme was restored. Narrow-window geometry was not verified because the attempted native resize did not change the window bounds.

The combined integration checkout ran Kubernetes, existing service and specialist-followup regressions: **38 passed, three pre-existing conditional Codex cases skipped, zero failures**. The full application build passed. No model call, Worker grant, policy deletion or historical operation replay was used for these checks.

Resource import continues for the remaining credential-backed entrances. [PR 238](https://github.com/Clean-Lakes/Lake/pull/238) targets develop; merging and production installation still require the repository's explicit authorization.

### Redis compatibility follow-up

The user authorized PR 238's merge; it merged as `ae5de678ede42553edcd6778ee934d59c1305f7b`, with identical trees and both topic refs cleaned up. Dev now contains all fourteen requested service entrances, grouped by scene, with resource count 165. Ten actual probes pass, including the Jushan cluster using its existing CA and client certificate with an IP SAN verified against the server certificate. The four Redis entrances rejected the pinned client's default `HELLO 3`; a private diagnostic using the same actual credentials and RESP2 authenticated and returned PONG on all four.

The follow-up explicitly selects RESP2 for connection probes. This uses ordinary AUTH, optional SELECT and PING, retaining explicit ACL usernames, TLS, deadlines and policy checks. [Redis documents HELLO as introduced in 6.0](https://redis.io/docs/latest/commands/hello/); the pinned client supports explicit protocol selection. No server configuration or credentials are changed.

A new RESP2-only wire regression failed on the prior implementation (HTTP 502 instead of 200), then passed with the protocol selection. It verifies password-only and named-user AUTH, rejection of wrong credentials, no PING after failed authentication, no stored draft credentials and no credential echo. The existing real isolated Redis test remains. Backend typecheck/bundle and all **34 Kubernetes/service integration tests passed, with no skips or failures**. Signed Dev verification of this follow-up is recorded after installation.

Signed daily Dev `497a7f6c89f247f103cc82856cda35c45eeb069f` installed and restarted normally; its clean manifest and binary digest matched. Repeated API imports reported **zero creates / fourteen skips**, project count 165, no changed prior resources, no duplicate service endpoints and the same preserved policy digest. Eleven distinct imported entrances have passed the actual Dev API test, including the RESP2 Weier Redis. The three Jushan Redis entrances passed direct RESP2 authentication/PING with exact source credentials, but subsequent Dev probes encountered timeout/upstream resets alongside other Jushan transports; those failed observations remain failed and do not establish continuous availability.

The native Kubernetes form and selected AppSelect menu were also visually checked at the minimum narrow window width (1700 physical pixels / approximately 850 points), with visible focus/corner clipping; the window was restored afterward. This closes the earlier unverified narrow-window item without changing resource configuration.

Clean 0.3.34 preparation `ca6431dc4a25686a0b5b40698bcde628775be5f3` produced a signed Dev package. An isolated Home smoke test used the actual packaged SEA to save/test Kubernetes and a RESP2-only Redis fixture, observed exactly AUTH/SELECT/PING, verified PID/Home identity, and drained normally. Package backend SHA-256: `14e4d8008ffdbe020ee159f871541f9c2ec78bb2c989d35f1d217325b658ac99`. This package was not installed over daily Dev or production.
