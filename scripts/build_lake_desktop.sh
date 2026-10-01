#!/bin/sh
set -eu

lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"

install_app=0
if [ "${1:-}" = "--install" ] && [ "$#" -eq 1 ]; then
  install_app=1
elif [ "$#" -ne 0 ]; then
  echo "用法: scripts/build_lake_desktop.sh [--install]" >&2
  exit 2
fi

if [ "$(uname -s)" != Darwin ]; then
  echo "此脚本用于 macOS" >&2
  exit 1
fi

scripts/build_lake.sh
npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs
swift scripts/generate_lake_icon.swift client/desktop/build/appicon.png

wails_cli="$(go env GOPATH)/bin/wails"
if [ ! -x "$wails_cli" ]; then
  echo "缺少 Wails CLI；运行 go install github.com/wailsapp/wails/v2/cmd/wails@v2.15.0" >&2
  exit 1
fi

staging_dir=$(mktemp -d)
trap 'rm -rf "$staging_dir"' EXIT HUP INT TERM
mkdir -p "$staging_dir/client/desktop" "$staging_dir/cmd/lake"
# Reinstall frontend dependencies in staging. Synced Desktop folders can contain
# placeholder copies in node_modules that stall copying or confuse TypeScript.
rsync -a --exclude='/build/bin/' --exclude='/frontend/node_modules/' "$lake_repo_root/client/desktop/" "$staging_dir/client/desktop/"
# Match repository layout for the JSON action catalog shared by Go and React.
cp "$lake_repo_root/cmd/lake/activity_tools.json" "$staging_dir/cmd/lake/activity_tools.json"
(cd "$staging_dir/client/desktop" && "$wails_cli" build -clean)

app_path="$staging_dir/client/desktop/build/bin/LakeDesktop.app"
resource_path="$app_path/Contents/Resources"
mkdir -p "$resource_path"
cp "$lake_repo_root/bin/lake" "$resource_path/lake"
cp -R "$lake_repo_root/bin/zcode" "$resource_path/zcode"
mkdir -p "$resource_path/licenses"
cp "$lake_repo_root/docs/third-party-notices.md" "$resource_path/third-party-notices.md"
cp "$lake_repo_root/docs/licenses/"* "$resource_path/licenses/"
cp "$lake_repo_root/LICENSE-APACHE" "$resource_path/licenses/lake-LICENSE-APACHE"
cp "$lake_repo_root/client/desktop/frontend/BEUI_LICENSE" "$resource_path/licenses/beui-LICENSE"
# Module-cache licenses may be read-only; the private staged copies need write
# permission for xattr cleanup before the application is signed.
chmod u+w "$resource_path/licenses/"*
xattr -cr "$app_path"

lake_identity='Lake Local Development Code Signing'
# Sign the bundled Node and Mach-O native modules with the same persistent
# identity before signing the outer app. Other platform assets are data files.
python3 - "$resource_path/zcode" "$lake_identity" <<'PY'
import pathlib,subprocess,sys
root=pathlib.Path(sys.argv[1])
for path in sorted(root.rglob('*')):
    if not path.is_file():
        continue
    if path.name != 'node' and path.suffix not in ('.node','.dylib'):
        continue
    kind=subprocess.check_output(['file','-b',str(path)],text=True)
    if 'Mach-O' in kind:
        subprocess.run(['codesign','--force','--timestamp=none','--sign',sys.argv[2],str(path)],check=True)
PY
codesign --force --timestamp=none --sign "$lake_identity" \
  --identifier com.cleanlakes.lake "$resource_path/lake"
codesign --force --timestamp=none --sign "$lake_identity" \
  --identifier com.cleanlakes.desktop "$app_path"
codesign --verify --deep --strict "$app_path"

build_dir="$HOME/Library/Application Support/Lake/builds"
mkdir -p "$build_dir"
build_path="$build_dir/Lake-$(date +%Y%m%d-%H%M%S)-$$.app"
ditto --norsrc "$app_path" "$build_path"
xattr -cr "$build_path"
codesign --force --timestamp=none --sign "$lake_identity" \
  --identifier com.cleanlakes.desktop "$build_path"
codesign --verify --deep --strict "$build_path"
echo "已构建 $build_path"

if [ "$install_app" -eq 1 ]; then
  install_path="$HOME/Applications/Lake.app"
  mkdir -p "$HOME/Applications"
  if [ -e "$install_path" ]; then
    backup_path="$HOME/Applications/Lake.backup.$(date +%Y%m%d-%H%M%S)-$$.app"
    mv "$install_path" "$backup_path"
    echo "原应用已保留在 $backup_path"
  fi
  ditto --norsrc "$build_path" "$install_path"
  xattr -cr "$install_path"
  codesign --force --timestamp=none --sign "$lake_identity" \
    --identifier com.cleanlakes.desktop "$install_path"
  codesign --verify --deep --strict "$install_path"
  echo "已安装 $install_path"
fi

# Keep only the verified replacement. A failed build or install never removes
# the previous usable output.
for old_build in "$build_dir"/Lake-*.app; do
  [ -d "$old_build" ] || continue
  [ "$old_build" != "$build_path" ] || continue
  rm -rf -- "$old_build"
done
