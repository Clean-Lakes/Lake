#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo "发布验收需要 macOS 签名环境" >&2; exit 1; }
scripts/build_lake.sh --typescript
lake_node=$(python3 scripts/prepare_typescript_runtime.py)
PATH="$(dirname "$lake_node"):$PATH"
export PATH
web-agent/node_modules/.bin/tsx --tsconfig runtime/typescript/tsconfig.json --test runtime/typescript/*.test.ts
"$lake_node" --test runtime/typescript/*.test.cjs
mkdir -p assets/web/dist
cp -R web-agent/web/dist/. assets/web/dist/
GOWORK=off go test ./...
GOWORK=off go vet ./...
pnpm --dir web-agent check
pnpm --dir web-agent test:frontend
scripts/build_lake_desktop.sh
swift run --package-path client/macos --build-system native LakeUpdateTests
swift run --package-path client/macos --build-system native LakeWindowTests
python3 scripts/test_lake_macos_installer.py
codesign --verify --strict bin/lake
codesign -dv --verbose=2 bin/lake 2>&1 | rg 'Authority=Lake Local Development Code Signing'
echo "Lake TypeScript/macOS 发布验收通过；完整旧版功能等价另见 parity.json。"
