# ZCode source snapshot

- Source: https://github.com/zai-org/ZCode
- Commit: `29628c9acdb81b703bbd4080c207a0e7ce5e276e`
- License: Apache-2.0; retain `zcode/LICENSE`, `NOTICE.md`, and `THIRD-PARTY-NOTICES.md`.
- Imported with `git archive` from the official repository, without dependencies or Git metadata.
- Lake builds only the Agent CLI dependency graph. ZCode Desktop, Web, and shared UI are not used by the Lake frontend.
- The imported source is unchanged. Lake's host adapter lives in `lake/zcode/` and uses the public app-server and MCP protocols.

Update this snapshot deliberately, review upstream protocol changes, and rerun the host integration tests before updating the pinned commit.
