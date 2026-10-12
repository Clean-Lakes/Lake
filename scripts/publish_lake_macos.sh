#!/bin/sh
# Apple Silicon only; use the SAME persistent signing identity for every release.
set -eu
lake_repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$lake_repo_root"
[ "$(git branch --show-current)" = master ] || { echo '请从 master 发布' >&2; exit 1; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { echo '请先提交发布代码' >&2; exit 1; }
git fetch origin refs/heads/master:refs/remotes/origin/master
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] || { echo '请先将当前 master 推送到 origin/master' >&2; exit 1; }
lake_version=$(cat VERSION)
lake_artifacts="$lake_repo_root/dist/macos/$lake_version"
for lake_arch in arm64; do
  lake_name="Lake-$lake_version-macos-$lake_arch"
  (cd "$lake_artifacts/$lake_arch" && shasum -a 256 -c "$lake_name.zip.sha256" && shasum -a 256 -c "$lake_name.dmg.sha256")
  codesign --verify --deep --strict "$lake_artifacts/$lake_arch/Lake.app"
done
# target_commitish MUST remain master; clients reject main/preview releases.
if ! gh auth status >/dev/null 2>&1; then
  exec python3 scripts/stage_lake_macos_release.py
fi
if ! gh release view "v$lake_version" --repo Clean-Lakes/Lake >/dev/null 2>&1; then
  gh release create "v$lake_version" --repo Clean-Lakes/Lake --target master --draft --title "Lake v$lake_version" --notes-file client/macos/RELEASE_NOTES.md
fi
gh release upload "v$lake_version" --repo Clean-Lakes/Lake --clobber \
  "$lake_artifacts/arm64/"*.zip "$lake_artifacts/arm64/"*.zip.sha256 \
  "$lake_artifacts/arm64/"*.dmg "$lake_artifacts/arm64/"*.dmg.sha256
gh api -X PATCH "repos/Clean-Lakes/Lake/git/refs/tags/v$lake_version" -f sha="$(git rev-parse HEAD)" -F force=false
gh release edit "v$lake_version" --repo Clean-Lakes/Lake --target master --draft=false --latest --notes-file client/macos/RELEASE_NOTES.md
