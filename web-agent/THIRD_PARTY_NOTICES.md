# Third-party notices

The Go backend uses the pinned modules in repository `go.mod` / `go.sum`: pgx, go-sql-driver/mysql, go-sqlite3, creack/pty (MIT), hinshun/vt10x (MIT), golang.org/x/image, x/crypto, x/text, x/sync and x/sys (BSD), github.com/syndtr/goleveldb v1.0.0 and github.com/golang/snappy v1.0.0 (BSD-3-Clause) for read-only HexHub import, plus mvdan.cc/sh/v3 v3.12.0 (BSD-3-Clause) for shell syntax analysis. Corresponding license files are in `licenses/`.

The embedded React frontend uses React (MIT), xterm.js (MIT), react-markdown (MIT), remark-gfm (MIT), jsdiff (BSD-3-Clause), Lucide React (ISC, with MIT-licensed Feather-derived icons) and their locked transitive packages. Exact frontend versions are in `pnpm-lock.yaml`. Node/Vite/TypeScript/pnpm are build tools and are not shipped as runtime dependencies.

HexHub 5.4.1 extracted prompt constants and reconstructed contracts are reverse-engineering evidence. The Go implementation is rebuilt Lake source. See `docs/hexhub-ai/provenance.json`.

Provider brand SVGs are vendored from [Lobe Icons](https://github.com/lobehub/lobe-icons), `@lobehub/icons-static-svg` v1.95.1 (MIT). Source paths and hashes are recorded in `web/public/providers/provenance.json`; the upstream license is included as `licenses/lobe-icons-MIT`. Brand names and logos remain the property of their respective owners.

MCP client connections use the [official Go MCP SDK](https://github.com/modelcontextprotocol/go-sdk) v1.8.0 (Apache-2.0/MIT transition, upstream LICENSE retained in `licenses/go-github.com_modelcontextprotocol_go-sdk-v1.8.0-LICENSE`), google/jsonschema-go (MIT), segmentio encoding/asm (MIT), yosida95/uritemplate (BSD-3-Clause), and golang.org/x/oauth2 and x/time (BSD-3-Clause). Their upstream license files are included in `licenses/`. Exact versions are pinned in `go.mod` / `go.sum`.

Agent execution uses the official Google ADK Go `google.golang.org/adk/v2` v2.6.0 and `google.golang.org/genai` v1.74.0 (Apache-2.0). Durable sessions use GORM v1.31.2 and the official gorm.io/driver/sqlite v1.6.0 dialector (MIT), with the modernc pure-Go SQLite implementation and its upstream notices. The compiled Go runtime module inventory, exact versions, and bundled upstream license/NOTICE filenames are recorded in `licenses/go-runtime-modules.json`. These notices include ADK's Google Cloud, OpenTelemetry, protobuf/gRPC and other transitive runtime dependencies.
