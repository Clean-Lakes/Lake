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
- Kubernetes and existing service integration regressions: 32 passed before the additional legacy metric/database/cache adapter case; the additional case is checked separately below.
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
