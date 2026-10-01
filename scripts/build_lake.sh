#!/bin/sh
set -eu

lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
mkdir -p bin

if [ "$(uname -s)" != Darwin ]; then
  go build -o bin/lake ./cmd/lake
  exit 0
fi

lake_identity='Lake Local Development Code Signing'
if ! security find-identity -v -p codesigning | grep -Fq "\"$lake_identity\""; then
  echo "缺少 Lake 本地签名身份；先运行 scripts/setup_lake_signing.sh" >&2
  exit 1
fi

lake_build_tmp=$(mktemp "$lake_repo_root/bin/.lake-build.XXXXXX")
trap 'rm -f "$lake_build_tmp"' EXIT HUP INT TERM
go build -o "$lake_build_tmp" ./cmd/lake
codesign --force --timestamp=none --sign "$lake_identity" \
  --identifier com.cleanlakes.lake "$lake_build_tmp"
codesign --verify "$lake_build_tmp"
mv -f "$lake_build_tmp" "$lake_repo_root/bin/lake"
echo "已编译并签名 bin/lake"
