#!/bin/sh
# Current Go/React macOS client. Archived Electron: build_lake_legacy_desktop.sh.
set -eu
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
install_app=0
if [ "${1:-}" = "--install" ] && [ "$#" -eq 1 ]; then install_app=1
elif [ "$#" -ne 0 ]; then echo '用法: scripts/build_lake_desktop.sh [--install]' >&2; exit 2; fi
[ "$(uname -s)" = Darwin ] || { echo '此脚本用于 macOS' >&2; exit 1; }
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
mkdir -p "$lake_output"
# Stage outside Desktop/iCloud so Finder attributes cannot invalidate signing.
lake_stage=$(mktemp -d "${TMPDIR:-/tmp}/lake-macos.XXXXXX")
trap 'rm -rf "$lake_stage"' EXIT HUP INT TERM
lake_app="$lake_stage/Lake.app"
mkdir -p "$lake_app/Contents/MacOS" "$lake_app/Contents/Resources/licenses"
cp "$lake_swift_bin/LakeDesktop" "$lake_app/Contents/MacOS/Lake"
cp bin/lake "$lake_app/Contents/Resources/lake"
cp client/macos/Resources/install-update.sh "$lake_app/Contents/Resources/"
cp LICENSE-APACHE "$lake_app/Contents/Resources/licenses/Lake-APACHE"
cp web-agent/THIRD_PARTY_NOTICES.md "$lake_app/Contents/Resources/"
cp web-agent/licenses/* "$lake_app/Contents/Resources/licenses/"
cat > "$lake_app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.cleanlakes.lake.desktop</string>
<key>CFBundleName</key><string>Lake</string>
<key>CFBundleDisplayName</key><string>Lake</string>
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
codesign --force --timestamp=none --sign "$lake_identity" --identifier com.cleanlakes.lake.desktop "$lake_app"
codesign --verify --deep --strict "$lake_app"
"$lake_app/Contents/Resources/lake" --version
lake_name="Lake-$lake_version-macos-$lake_arch"
ditto --norsrc -c -k --keepParent "$lake_app" "$lake_output/$lake_name.zip"
(cd "$lake_output" && shasum -a 256 "$lake_name.zip" > "$lake_name.zip.sha256")
mkdir "$lake_stage/dmg"
ditto --norsrc "$lake_app" "$lake_stage/dmg/Lake.app"
ln -s /Applications "$lake_stage/dmg/Applications"
hdiutil create -quiet -volname "Lake $lake_version" -srcfolder "$lake_stage/dmg" -format UDZO -ov "$lake_output/$lake_name.dmg"
(cd "$lake_output" && shasum -a 256 "$lake_name.dmg" > "$lake_name.dmg.sha256")
lake_builds="$HOME/Library/Application Support/Lake/builds"
mkdir -p "$lake_builds"
lake_saved_app="$lake_builds/Lake-$lake_version-$lake_arch-$(date +%Y%m%d-%H%M%S)-$$.app"
ditto --norsrc "$lake_app" "$lake_saved_app"
codesign --verify --deep --strict "$lake_saved_app"
# Desktop/iCloud can add Finder attributes after signing. Keep the runnable app outside it.
if [ -e "$lake_output/Lake.app" ] || [ -L "$lake_output/Lake.app" ]; then rm -rf "$lake_output/Lake.app"; fi
ln -s "$lake_saved_app" "$lake_output/Lake.app"
echo "已构建 $lake_output/Lake.app 与 ZIP/DMG 安装包"
if [ "$install_app" -eq 1 ]; then
  lake_install="$HOME/Applications/Lake.app"
  mkdir -p "$HOME/Applications"
  if [ -e "$lake_install" ]; then
    mv "$lake_install" "$HOME/Applications/Lake.backup.$(date +%Y%m%d-%H%M%S)-$$.app"
  fi
  ditto --norsrc "$lake_app" "$lake_install"
  codesign --verify --deep --strict "$lake_install"
  echo "已安装 $lake_install"
fi
