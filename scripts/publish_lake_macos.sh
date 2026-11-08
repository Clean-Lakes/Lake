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
# GitHub drafts do not create a Git tag. Create it explicitly before creating
# or resuming the draft; an existing release tag must never be moved.
lake_release_commit=$(git rev-parse HEAD)
if lake_tag_object=$(gh api "repos/Clean-Lakes/Lake/git/ref/tags/v$lake_version" --jq '.object | [.type, .sha] | join(" ")' 2>/dev/null); then
  lake_tag_type=${lake_tag_object%% *}
  lake_tag_commit=${lake_tag_object#* }
  if [ "$lake_tag_type" = tag ]; then
    lake_tag_object=$(gh api "repos/Clean-Lakes/Lake/git/tags/$lake_tag_commit" --jq '.object | [.type, .sha] | join(" ")')
    lake_tag_type=${lake_tag_object%% *}
    lake_tag_commit=${lake_tag_object#* }
  fi
  [ "$lake_tag_type" = commit ] && [ "$lake_tag_commit" = "$lake_release_commit" ] || {
    echo '发布标签不指向当前生产提交；未移动标签或上传资产' >&2; exit 1;
  }
else
  gh api -X POST repos/Clean-Lakes/Lake/git/refs -f "ref=refs/tags/v$lake_version" -f "sha=$lake_release_commit" >/dev/null
fi
if ! gh release view "v$lake_version" --repo Clean-Lakes/Lake >/dev/null 2>&1; then
  gh release create "v$lake_version" --repo Clean-Lakes/Lake --verify-tag --target master --draft --title "Lake v$lake_version" --notes-file client/macos/RELEASE_NOTES.md
fi
gh release upload "v$lake_version" --repo Clean-Lakes/Lake --clobber \
  "$lake_artifacts/arm64/"*.zip "$lake_artifacts/arm64/"*.zip.sha256 \
  "$lake_artifacts/arm64/"*.dmg "$lake_artifacts/arm64/"*.dmg.sha256
gh release edit "v$lake_version" --repo Clean-Lakes/Lake --target master --draft=false --latest --notes-file client/macos/RELEASE_NOTES.md
