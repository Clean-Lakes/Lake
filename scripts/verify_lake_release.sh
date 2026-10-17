#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "发布验收需要 macOS 签名环境" >&2; exit 1; }
scripts/build_lake.sh
GOWORK=off go test ./...
GOWORK=off go vet ./...
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
scripts/build_lake_desktop.sh
codesign --verify --strict bin/lake
codesign -dv --verbose=2 bin/lake 2>&1 | rg 'Authority=Lake Local Development Code Signing'
echo "Lake Go/React 发布验收通过。"
