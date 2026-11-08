#!/bin/sh
# Signed TypeScript runtime; --candidate retains the isolated Dev artifact.
set -eu
lake_binary=lake
if [ "${1:-}" = --candidate ]; then lake_binary=lake-ts; shift; fi
[ "$#" -eq 0 ] || { echo "用法: scripts/build_lake_typescript.sh [--candidate]" >&2; exit 2; }
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
lake_identity='Lake Local Development Code Signing'
if [ "$(uname -s)" = Darwin ] && ! security find-identity -v -p codesigning | grep -Fq "\"$lake_identity\""; then
  echo '缺少 Lake 本地签名身份；先运行 scripts/setup_lake_signing.sh' >&2
  exit 1
fi
python3 scripts/check_backend_naming.py
lake_node=$(python3 scripts/prepare_typescript_runtime.py)
PATH="$(dirname "$lake_node"):$PATH"
export PATH
if [ "${LAKE_REUSE_WEB_ASSETS:-0}" != 1 ]; then pnpm --dir web-agent build:web; fi
[ -f web-agent/web/dist/index.html ] || { echo '缺少 React 构建产物' >&2; exit 1; }
"$lake_node" third_party/agent-sdk/node_modules/typescript/bin/tsc -p runtime/typescript/tsconfig.json
"$lake_node" runtime/typescript/build.mjs
if [ "$(uname -s)" = Darwin ]; then
  lake_pty_arch=$("$lake_node" -p process.arch)
  for lake_pty_file in pty.node spawn-helper; do
    lake_pty_path="$lake_repo_root/bin/lake-runtime/native/node-pty/prebuilds/darwin-$lake_pty_arch/$lake_pty_file"
    codesign --force --timestamp=none --sign "$lake_identity" "$lake_pty_path"
    codesign --verify --strict "$lake_pty_path"
  done
fi
"$lake_node" --experimental-sea-config bin/lake-sea.json
lake_build_tmp=$(mktemp "$lake_repo_root/bin/.lake-ts-build.XXXXXX")
trap 'rm -f "$lake_build_tmp"' EXIT HUP INT TERM
cp "$lake_node" "$lake_build_tmp"
chmod 755 "$lake_build_tmp"
if [ "$(uname -s)" = Darwin ]; then
  if codesign -d "$lake_build_tmp" >/dev/null 2>&1; then codesign --remove-signature "$lake_build_tmp"; fi
  pnpm --dir third_party/agent-sdk exec postject "$lake_build_tmp" NODE_SEA_BLOB "$lake_repo_root/bin/lake-sea.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 --macho-segment-name NODE_SEA
  codesign --force --timestamp=none --sign "$lake_identity" --identifier com.cleanlakes.lake "$lake_build_tmp"
  codesign --verify --strict "$lake_build_tmp"
else
  pnpm --dir third_party/agent-sdk exec postject "$lake_build_tmp" NODE_SEA_BLOB "$lake_repo_root/bin/lake-sea.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
fi
mv -f "$lake_build_tmp" "$lake_repo_root/bin/$lake_binary"
"$lake_repo_root/bin/$lake_binary" --version
echo "已生成已签名 TypeScript 后端 bin/$lake_binary"
