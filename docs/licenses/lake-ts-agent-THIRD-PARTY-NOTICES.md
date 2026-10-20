# Third-party notices

Historical attribution for the retired Lake TypeScript Agent. Its source and runtime package are no longer distributed by current Lake builds. The original notice below is retained for provenance; references to package directories and the lockfile describe the historical distribution. Current distributed licenses are listed in `web-agent/THIRD_PARTY_NOTICES.md` at the repository root.

Lake Agent 0.0.1 uses protocol, validation, persistence and UI libraries. Its Agent loop and specialist runtime are implemented in this repository.

Runtime dependencies: Node.js 24.14.0 (MIT and bundled third-party licenses), SQLite (public domain), fs-ext 2.1.1 (MIT), ssh2 1.17.0 (MIT), node-postgres/pg 8.16.3 (MIT), Zod 4.3.6 (MIT), yaml 2.9.0 (ISC).

Browser dependencies: React and React DOM 19.1.0 (MIT), xterm.js 5.5.0 and addon-fit 0.10.0 (MIT). Build tools include TypeScript 5.9.3 (Apache-2.0), tsx 4.22.0 (MIT), Vite 7.0.0 and plugin-react 5.0.0 (MIT).

Full notices and license texts for the distributed dependency files are retained in their package directories. Node's full bundled license text is distributed as licenses/Node-LICENSE.txt, copied from the verified official 24.14.0 archive. The lockfile records transitive dependencies. No ZCode or Tianshu Agent runtime source is included in this implementation.
