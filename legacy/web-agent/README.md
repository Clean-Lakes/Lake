# Archived Node backend

This directory preserves the previous TypeScript HTTP server, SQLite/PTY/SSH bridge, regression fixtures, and Node release scripts as migration evidence. The active Go implementation is `internal/web/`; AI is `internal/ai/`. These files are excluded from the active package, build, and executable. Historical imports refer to the original `web-agent/` layout and are not maintained as a runnable fallback.

`LAKE_WEB_AI_RUNTIME=legacy` and `LAKE_AI_BACKEND` no longer select production runtimes. The signed `bin/lake` runs the Go backend directly and embeds the React assets.
