#!/bin/sh
set -eu
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
install_app=0
if [ "${1:-}" = "--install" ] && [ "$#" -eq 1 ]; then install_app=1
elif [ "$#" -ne 0 ]; then echo "用法: scripts/build_lake_desktop.sh [--install]" >&2; exit 2; fi
[ "$(uname -s)" = Darwin ] || { echo "此脚本用于 macOS" >&2; exit 1; }
lake_identity='Lake Local Development Code Signing'
scripts/build_lake.sh
npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs
export PATH="$lake_repo_root/bin/zcode:$lake_repo_root/third_party/zcode/node_modules/.bin:$PATH"
export ZCODE_TARGET_OS=darwin
export ZCODE_TARGET_ARCH=arm64
export ZCODE_ENV=production
export ZCODE_PREVIEW_IDENTITY=0
export ZCODE_ENABLE_MAC_SIGN=0
# Original runtime assets, renderer, Main, Host and native workflow implementation.
# Cross-platform remote assets may be prepared separately; local builds use the same native preparation.
pnpm --dir third_party/zcode install --frozen-lockfile --ignore-scripts
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node third_party/zcode/node_modules/electron/install.js
pnpm --dir third_party/zcode --filter @zcode/desktop prepare:runtime-assets
pnpm --dir third_party/zcode --filter @zcode/desktop build:no-runtime-assets
swift scripts/generate_lake_icon.swift third_party/zcode/packages/desktop/build/icon.png
lake_iconset=$(mktemp -d)/lake.iconset
mkdir -p "$lake_iconset"
for lake_size in 16 32 128 256 512; do
  sips -z "$lake_size" "$lake_size" third_party/zcode/packages/desktop/build/icon.png --out "$lake_iconset/icon_${lake_size}x${lake_size}.png" >/dev/null
  lake_double=$((lake_size * 2))
  sips -z "$lake_double" "$lake_double" third_party/zcode/packages/desktop/build/icon.png --out "$lake_iconset/icon_${lake_size}x${lake_size}@2x.png" >/dev/null
done
iconutil -c icns "$lake_iconset" -o third_party/zcode/packages/desktop/build/icon.icns
rm -rf "$(dirname "$lake_iconset")"
pnpm --dir third_party/zcode/packages/desktop exec electron-builder --config electron-builder.config.js --mac --arm64 --dir
built_app_path="$lake_repo_root/third_party/zcode/packages/desktop/dist/mac-arm64/LAKE.app"
[ -d "$built_app_path" ] || { echo "原生 LAKE 应用未生成" >&2; exit 1; }
# Desktop/iCloud may re-add Finder attributes while signing; stage outside it first.
build_dir="$HOME/Library/Application Support/LAKE/builds"
mkdir -p "$build_dir"
build_path="$build_dir/LAKE-$(date +%Y%m%d-%H%M%S)-$$.app"
ditto --norsrc "$built_app_path" "$build_path"
app_path="$build_path"
resource_path="$app_path/Contents/Resources"
node scripts/verify_lake_native_runtime.mjs "$app_path"
ELECTRON_RUN_AS_NODE=1 "$app_path/Contents/MacOS/LAKE" scripts/verify_lake_native_runtime.mjs "$app_path"
cp "$lake_repo_root/bin/lake" "$resource_path/lake"
mkdir -p "$resource_path/licenses"
cp "$lake_repo_root/docs/third-party-notices.md" "$resource_path/third-party-notices.md"
cp "$lake_repo_root/docs/licenses/"* "$resource_path/licenses/"
cp "$lake_repo_root/LICENSE-APACHE" "$resource_path/licenses/lake-LICENSE-APACHE"
chmod -R u+w "$app_path"
xattr -cr "$app_path"
python3 scripts/sign_lake_native.py "$app_path" "$lake_identity"
codesign --verify --deep --strict "$app_path"
# Verify the signed launcher resolves the installed runtime, without loading
# real provider preferences or user data.
smoke_home=$(mktemp -d)
if ! LAKE_HOME="$smoke_home" "$resource_path/lake" --help >/dev/null; then
  rm -rf "$smoke_home"
  echo "安装包 CLI 启动验收失败" >&2
  exit 1
fi
rm -rf "$smoke_home"
echo "已构建原生客户端 $build_path"
if [ "$install_app" -eq 1 ]; then
  install_path="$HOME/Applications/Lake.app"
  mkdir -p "$HOME/Applications"
  if [ -e "$install_path" ]; then
    backup_path="$HOME/Applications/Lake.backup.$(date +%Y%m%d-%H%M%S)-$$.app"
    mv "$install_path" "$backup_path"
    echo "原应用已保留在 $backup_path"
  fi
  ditto --norsrc "$build_path" "$install_path"
  codesign --verify --deep --strict "$install_path"
  echo "已安装 $install_path"
fi
