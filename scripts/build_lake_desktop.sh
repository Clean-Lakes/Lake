#!/bin/sh
# Current Go/React macOS client.
set -eu
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
install_app=0
development_app=0
for lake_argument in "$@"; do
  case "$lake_argument" in
    --install) install_app=1 ;;
    --dev) development_app=1 ;;
    *) echo '用法: scripts/build_lake_desktop.sh [--dev] [--install]' >&2; exit 2 ;;
  esac
done
lake_app_name=Lake
lake_bundle_id=com.cleanlakes.lake.desktop
if [ "$development_app" -eq 1 ]; then
  lake_app_name='Lake Dev'
  lake_bundle_id=com.cleanlakes.lake.desktop.dev
fi
[ "$(uname -s)" = Darwin ] || { echo '此脚本用于 macOS' >&2; exit 1; }
if [ "$development_app" -eq 1 ] && [ "$install_app" -eq 1 ]; then
  python3 scripts/dev_build_origin.py check "$lake_repo_root" "$HOME/Applications/Lake Dev.app/Contents/Resources/build-origin.json"
fi
lake_identity='Lake Local Development Code Signing'
security find-identity -v -p codesigning | grep -Fq "\"$lake_identity\"" || {
  echo '缺少持久签名身份，请先运行 scripts/setup_lake_signing.sh' >&2; exit 1;
}
lake_version=$(cat VERSION)
lake_arch=arm64
[ "${LAKE_DESKTOP_ARCH:-arm64}" = arm64 ] || { echo '当前仅发布 Apple Silicon（M 系列）arm64 包' >&2; exit 2; }
export GOARCH=arm64
export GOOS=darwin CGO_ENABLED=1
export CC="clang -arch $lake_arch"
scripts/build_lake.sh
swift build --package-path client/macos --build-system native -c release --triple "$lake_arch-apple-macosx13.0"
lake_swift_bin=$(swift build --package-path client/macos --build-system native -c release --triple "$lake_arch-apple-macosx13.0" --show-bin-path)
lake_output="$lake_repo_root/dist/macos/$lake_version/$lake_arch"
if [ "$development_app" -eq 1 ]; then lake_output="$lake_output/dev"; fi
mkdir -p "$lake_output"
# Stage outside Desktop/iCloud so Finder attributes cannot invalidate signing.
lake_stage=$(mktemp -d "${TMPDIR:-/tmp}/lake-macos.XXXXXX")
trap 'rm -rf "$lake_stage"' EXIT HUP INT TERM
lake_app="$lake_stage/$lake_app_name.app"
mkdir -p "$lake_app/Contents/MacOS" "$lake_app/Contents/Resources/licenses"
cp "$lake_swift_bin/LakeDesktop" "$lake_app/Contents/MacOS/Lake"
cp bin/lake "$lake_app/Contents/Resources/lake"
if [ "$development_app" -eq 1 ]; then
  python3 scripts/dev_build_origin.py write "$lake_repo_root" "$lake_app/Contents/Resources/build-origin.json"
fi
cp client/macos/Resources/install-update.sh "$lake_app/Contents/Resources/"
cp web-agent/web/src/workbenchLayout.js "$lake_app/Contents/Resources/workbench-layout.js"
cp LICENSE-APACHE "$lake_app/Contents/Resources/licenses/Lake-APACHE"
cp web-agent/THIRD_PARTY_NOTICES.md "$lake_app/Contents/Resources/"
cp web-agent/licenses/* "$lake_app/Contents/Resources/licenses/"
cat > "$lake_app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$lake_bundle_id</string>
<key>CFBundleName</key><string>$lake_app_name</string>
<key>CFBundleDisplayName</key><string>$lake_app_name</string>
<key>CFBundleExecutable</key><string>Lake</string>
<key>CFBundleShortVersionString</key><string>$lake_version</string>
<key>CFBundleVersion</key><string>$lake_version</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleIconFile</key><string>Lake.icns</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
EOF
swift scripts/generate_lake_icon.swift "$lake_stage/icon.png"
lake_iconset="$lake_stage/Lake.iconset"
mkdir "$lake_iconset"
for lake_size in 16 32 128 256 512; do
  sips -z "$lake_size" "$lake_size" "$lake_stage/icon.png" --out "$lake_iconset/icon_${lake_size}x${lake_size}.png" >/dev/null
  lake_double=$((lake_size * 2))
  sips -z "$lake_double" "$lake_double" "$lake_stage/icon.png" --out "$lake_iconset/icon_${lake_size}x${lake_size}@2x.png" >/dev/null
done
iconutil -c icns "$lake_iconset" -o "$lake_app/Contents/Resources/Lake.icns"
chmod -R u+w "$lake_app"
xattr -cr "$lake_app"
codesign --force --timestamp=none --sign "$lake_identity" --identifier "$lake_bundle_id" "$lake_app"
codesign --verify --deep --strict "$lake_app"
"$lake_app/Contents/Resources/lake" --version
lake_name="Lake-$lake_version-macos-$lake_arch"
if [ "$development_app" -eq 1 ]; then lake_name="$lake_name-dev"; fi
ditto --norsrc -c -k --keepParent "$lake_app" "$lake_output/$lake_name.zip"
(cd "$lake_output" && shasum -a 256 "$lake_name.zip" > "$lake_name.zip.sha256")
mkdir "$lake_stage/dmg"
ditto --norsrc "$lake_app" "$lake_stage/dmg/$lake_app_name.app"
ln -s /Applications "$lake_stage/dmg/Applications"
hdiutil create -quiet -volname "$lake_app_name $lake_version" -srcfolder "$lake_stage/dmg" -format UDZO -ov "$lake_output/$lake_name.dmg"
(cd "$lake_output" && shasum -a 256 "$lake_name.dmg" > "$lake_name.dmg.sha256")
lake_builds="$HOME/Library/Application Support/Lake/builds"
if [ "$development_app" -eq 1 ]; then lake_builds="$HOME/Library/Application Support/Lake Dev/builds"; fi
mkdir -p "$lake_builds"
lake_saved_app="$lake_builds/$lake_app_name-$lake_version-$lake_arch-$(date +%Y%m%d-%H%M%S)-$$.app"
ditto --norsrc "$lake_app" "$lake_saved_app"
codesign --verify --deep --strict "$lake_saved_app"
# Keep only the newest build so repeated iterations cannot fill the disk.
# Skip any build another dist/ symlink still points at.
for lake_old_build in "$lake_builds"/*.app; do
  [ -d "$lake_old_build" ] || continue
  [ "$lake_old_build" = "$lake_saved_app" ] && continue
  if find "$lake_repo_root/dist" -type l -lname "$lake_old_build" -print -quit 2>/dev/null | grep -q .; then continue; fi
  rm -rf "$lake_old_build"
done
# Desktop/iCloud can add Finder attributes after signing. Keep the runnable app outside it.
if [ -e "$lake_output/$lake_app_name.app" ] || [ -L "$lake_output/$lake_app_name.app" ]; then rm -rf "$lake_output/$lake_app_name.app"; fi
ln -s "$lake_saved_app" "$lake_output/$lake_app_name.app"
echo "已构建 $lake_output/$lake_app_name.app 与 ZIP/DMG 安装包"
if [ "$install_app" -eq 1 ]; then
  lake_install="$HOME/Applications/$lake_app_name.app"
  mkdir -p "$HOME/Applications"
  lake_install_stage="$HOME/Applications/.$lake_app_name-install-$$.app"
  lake_install_backup="$HOME/Applications/$lake_app_name.backup.$(date +%Y%m%d-%H%M%S)-$$.app"
  ditto --norsrc "$lake_app" "$lake_install_stage"
  codesign --verify --deep --strict "$lake_install_stage"
  "$lake_install_stage/Contents/Resources/lake" --version >/dev/null
  if [ -e "$lake_install" ]; then mv "$lake_install" "$lake_install_backup"; fi
  if ! mv "$lake_install_stage" "$lake_install" || ! codesign --verify --deep --strict "$lake_install"; then
    if [ -e "$lake_install" ]; then mv "$lake_install" "$lake_install_stage.failed"; fi
    if [ -e "$lake_install_backup" ]; then mv "$lake_install_backup" "$lake_install"; fi
    echo "安装失败，已恢复原应用" >&2
    exit 1
  fi
  # A verified replacement is installed; this transaction's rollback app is obsolete.
  if [ -e "$lake_install_backup" ]; then rm -rf "$lake_install_backup"; fi
  echo "已安装 $lake_install"
fi
