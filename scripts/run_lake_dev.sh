#!/bin/sh
# Fast Go/React iteration: a signed backend, no native rebuild or ZIP/DMG.
# Quit Lake Dev first. Open the installed Dev app after this server is ready;
# it reuses this Home's healthy runtime. This terminal owns the backend lifetime.
set -eu
[ "$#" -eq 0 ] || { echo '用法: scripts/run_lake_dev.sh（先正常退出 Lake Dev）' >&2; exit 2; }
[ "$(uname -s)" = Darwin ] || { echo '此入口用于 macOS Lake Dev' >&2; exit 1; }
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
python3 scripts/dev_run_preflight.py
python3 scripts/dev_build_origin.py check "$lake_repo_root" "$HOME/Applications/Lake Dev.app/Contents/Resources/build-origin.json"
# Do not inherit release paths, tokens or a stale Vite origin.
unset LAKE_HOME LAKE_WEB_DATA_DIR LAKE_WEB_TOKEN LAKE_WEB_DEV_ORIGIN LAKE_WEB_START_OPEN
(cd web-agent && corepack pnpm build:web)
LAKE_REUSE_WEB_ASSETS=1 scripts/build_lake.sh
python3 scripts/dev_build_origin.py write "$lake_repo_root" "$lake_repo_root/bin/lake-dev-run-origin.json"
echo 'Dev 后端就绪后可打开 ~/Applications/Lake Dev.app；此终端负责后端，Ctrl+C 正常停止。'
exec "$lake_repo_root/bin/lake" web --home "$HOME/.lake-dev" --port 0
