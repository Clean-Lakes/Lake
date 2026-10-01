#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "发布验收需要 macOS 签名环境" >&2; exit 1; }
scripts/build_lake_desktop.sh
export PATH="$PWD/bin/zcode:$PWD/third_party/zcode/node_modules/.bin:$PATH"
GOWORK=off go test ./...
GOWORK=off go vet ./...
(cd client/desktop && GOWORK=off go test ./... && GOWORK=off go vet ./...)
pnpm --dir third_party/zcode --filter @zcode/lake test
pnpm --dir third_party/zcode exec tsx --test apps/zcode-cli/packages/lake/test/native-remote.test.ts
npm --prefix client/desktop/frontend test
npm --prefix client/desktop/frontend run build
pnpm --dir third_party/zcode typecheck
pnpm --dir third_party/zcode/apps/zcode-cli typecheck
pnpm --dir third_party/zcode --filter @zcode/lake lint
pnpm --dir third_party/zcode architecture:check -- --changed
codesign --verify --strict bin/lake
codesign -dv --verbose=2 bin/lake 2>&1 | rg 'Authority=Lake Local Development Code Signing'
echo "Lake 发布验收通过。上游完整 CLI lint 的历史超长文件另行记录。"
