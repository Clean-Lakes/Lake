# Third-party notices

The Go backend uses the pinned modules in repository `go.mod` / `go.sum`: pgx, go-sql-driver/mysql, go-sqlite3, creack/pty (MIT), hinshun/vt10x (MIT), golang.org/x/image, x/crypto, x/text, x/sync and x/sys (BSD), plus mvdan.cc/sh/v3 v3.12.0 (BSD-3-Clause) for shell syntax analysis. Corresponding license files are in `licenses/`.

The embedded React frontend uses React (MIT), xterm.js (MIT), react-markdown (MIT), remark-gfm (MIT), jsdiff (BSD-3-Clause) and their locked transitive packages. Exact frontend versions are in `pnpm-lock.yaml`. Node/Vite/TypeScript/pnpm are build tools and are not shipped as runtime dependencies.

HexHub 5.4.1 extracted prompt constants and reconstructed contracts are reverse-engineering evidence. The Go implementation is rebuilt Lake source. See `docs/hexhub-ai/provenance.json`.
