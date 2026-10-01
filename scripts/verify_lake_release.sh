#!/bin/sh
set -eu

lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"

if [ "$(uname -s)" != Darwin ]; then
  echo "发布验收需要 macOS 签名与 Wails 构建环境" >&2
  exit 1
fi

echo "[1/8] 根模块测试与静态检查"
go test ./...
go vet ./...

echo "[2/8] 桌面 Go 模块测试与静态检查"
(cd client/desktop && go test ./...)
(cd client/desktop && go vet ./...)

echo "[3/8] Web 事件测试与前端构建"
(cd client/web && npm ci && npm test && npm run build)

echo "[4/8] 桌面时间线测试与前端构建"
(cd client/desktop/frontend && npm ci && npm test && npm run build)

echo "[5/8] 签名 Lake CLI"
scripts/build_lake.sh
codesign --verify --strict bin/lake

echo "[6/8] 构建并验证桌面应用（仅输出到 Application Support/Lake/builds，不安装）"
scripts/build_lake_desktop.sh

echo "[7/8] 数据迁移样本与安全回归"
go test ./lake/store -run 'TestMigrationFixturesV1ThroughV16|TestFailedUpgradeKeepsRestorableV15Snapshot|TestV17RepairsLegacyEventColumnAndKeepsConversation' -count=1
LAKE_ZCODE_INTEGRATION=1 go test ./lake/zcode ./cmd/lake -run 'TestSource' -count=1

echo "[8/8] 核对签名身份"
codesign -dv --verbose=2 bin/lake 2>&1 | grep -F 'Authority=Lake Local Development Code Signing'
echo "Lake 发布验收通过"
