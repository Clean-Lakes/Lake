#!/bin/sh
set -eu
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
mkdir -p bin
lake_identity='Lake Local Development Code Signing'
if [ "$(uname -s)" = Darwin ] && ! security find-identity -v -p codesigning | grep -Fq "\"$lake_identity\""; then
  echo "缺少 Lake 本地签名身份；先运行 scripts/setup_lake_signing.sh" >&2
  exit 1
fi
# Node and pnpm are build tools only. They are never packaged or invoked by lake.
if [ "${LAKE_REUSE_WEB_ASSETS:-0}" != 1 ]; then
  pnpm --dir web-agent build:web
fi
[ -f web-agent/web/dist/index.html ] || { echo '缺少 React 构建产物' >&2; exit 1; }
lake_web_stage=$(mktemp -d "$lake_repo_root/assets/web/.stage.XXXXXX")
lake_build_tmp=$(mktemp "$lake_repo_root/bin/.lake-build.XXXXXX")
trap 'rm -rf "$lake_web_stage"; rm -f "$lake_build_tmp"' EXIT HUP INT TERM
cp -R web-agent/web/dist/. "$lake_web_stage/"
# Generated embedding directory is rebuilt completely; old asset names cannot persist.
rm -rf assets/web/dist
mv "$lake_web_stage" assets/web/dist
lake_version=$(cat VERSION)
go build -trimpath -ldflags "-X main.version=$lake_version" -o "$lake_build_tmp" ./cmd/lake
if [ "$(uname -s)" = Darwin ]; then
  codesign --force --timestamp=none --sign "$lake_identity" --identifier com.cleanlakes.lake "$lake_build_tmp"
  codesign --verify --strict "$lake_build_tmp"
fi
mv -f "$lake_build_tmp" "$lake_repo_root/bin/lake"
echo "已生成 bin/lake：Go HTTP/AI/SQLite/PTY/SSH + 内嵌 React；运行无需 Node.js"
