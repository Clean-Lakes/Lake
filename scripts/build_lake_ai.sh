#!/bin/sh
set -eu
lake_ai_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_ai_root"
lake_ai_identity='Lake Local Development Code Signing'
if [ "$(uname -s)" = Darwin ] && ! security find-identity -v -p codesigning | grep -Fq "\"$lake_ai_identity\""; then
  echo '缺少 Lake 本地签名身份；先运行 scripts/setup_lake_signing.sh' >&2
  exit 1
fi
mkdir -p web-agent/dist
lake_ai_tmp=$(mktemp "$lake_ai_root/web-agent/dist/.lake-ai.XXXXXX")
trap 'rm -f "$lake_ai_tmp"' EXIT HUP INT TERM
go build -trimpath -o "$lake_ai_tmp" ./cmd/lake-ai
if [ "$(uname -s)" = Darwin ]; then
  codesign --force --timestamp=none --sign "$lake_ai_identity" --identifier com.cleanlakes.lake.ai "$lake_ai_tmp"
  codesign --verify --strict "$lake_ai_tmp"
fi
mv -f "$lake_ai_tmp" web-agent/dist/lake-ai
printf '已生成 Go AI 服务 web-agent/dist/lake-ai\n'
