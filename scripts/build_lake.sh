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

lake_agent_node=${LAKE_AGENT_NODE:-$(command -v node)}
"$lake_agent_node" agent/scripts/check-runtime.mjs
lake_node_directory=$(dirname "$lake_agent_node")
export PATH="$lake_node_directory:$PATH"
if [ "${LAKE_AGENT_REUSE_UI:-0}" = 1 ]; then
  "$lake_agent_node" agent/scripts/build.mjs --reuse-ui
else
  "$lake_agent_node" agent/scripts/build.mjs
fi
"$lake_agent_node" agent/scripts/verify-release.mjs
lake_release_path=$("$lake_agent_node" --input-type=module -e 'import {readFileSync} from "node:fs";const value=JSON.parse(readFileSync("agent/dist/release.json","utf8"));if(!/^lake-agent-runtime\/releases\/0\.0\.1-[a-f0-9]{64}$/.test(value.path))process.exit(1);process.stdout.write(value.path);')

lake_build_tmp=$(mktemp "$lake_repo_root/bin/.lake-build.XXXXXX")
trap 'rm -f "$lake_build_tmp"' EXIT HUP INT TERM
go build -ldflags "-X main.agentRelease=$lake_release_path" -o "$lake_build_tmp" ./cmd/lake
if [ "$(uname -s)" = Darwin ]; then
  codesign --force --timestamp=none --sign "$lake_identity" \
    --identifier com.cleanlakes.lake "$lake_build_tmp"
  codesign --verify --strict "$lake_build_tmp"
fi
mv -f "$lake_build_tmp" "$lake_repo_root/bin/lake"
echo "已生成 bin/lake 与独立 TypeScript Agent runtime"
