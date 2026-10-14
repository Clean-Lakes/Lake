#!/bin/sh
# All paths are passed as argv; none are interpolated into shell source.
set -eu
parent_pid=$1
backend_pid=$2
staged=$3
target=$4
backup=$5
work=$6
version=$7
opener=$8
ready_limit=${9:-45}
lake_home=${10:-}
lake_data=${11:-}
receipt="$work/ready"
log="$work/install.log"
exec >>"$log" 2>&1
restore() {
  if [ -f "$receipt.pid" ]; then
    failed_pid=$(cat "$receipt.pid")
    case "$failed_pid" in ''|*[!0-9]*) ;; *) kill "$failed_pid" 2>/dev/null || true ;; esac
    sleep 2
  fi
  if [ -f "$receipt.backend" ]; then
    failed_backend=$(cat "$receipt.backend")
    case "$failed_backend" in ''|*[!0-9]*) ;; *) kill "$failed_backend" 2>/dev/null || true ;; esac
    sleep 3
  fi
  if [ -e "$backup" ]; then
    if [ -e "$target" ]; then mv "$target" "$work/failed.app"; fi
    mv "$backup" "$target"
    if [ -n "$lake_home" ]; then
      "$opener" -n "$target" --args --lake-home "$lake_home" --lake-data "$lake_data" || true
    else
      "$opener" -n "$target" || true
    fi
  fi
  printf '%s\n' '更新失败，已恢复原版本。' > "$work/error"
}
# A bounded wait avoids replacing an app whose backend still has the DB open.
count=0
while kill -0 "$parent_pid" 2>/dev/null || { [ "$backend_pid" -gt 0 ] && kill -0 "$backend_pid" 2>/dev/null; }; do
  count=$((count + 1))
  if [ "$count" -ge 30 ]; then
    printf '%s\n' '旧应用未退出，更新未安装。' > "$work/error"
    exit 1
  fi
  sleep 1
done
trap 'restore' HUP INT TERM
if ! mv "$target" "$backup"; then
  printf '%s\n' '应用目录不可写，更新未安装。' > "$work/error"
  exit 1
fi
if ! mv "$staged" "$target"; then restore; exit 1; fi
if [ -n "$lake_home" ]; then
  if ! "$opener" -n "$target" --args --lake-update-receipt "$receipt" --lake-home "$lake_home" --lake-data "$lake_data"; then restore; exit 1; fi
else
  if ! "$opener" -n "$target" --args --lake-update-receipt "$receipt"; then restore; exit 1; fi
fi
count=0
while [ "$count" -lt "$ready_limit" ]; do
  if [ -f "$receipt" ] && [ "$(cat "$receipt")" = "$version" ]; then
    # The replacement has opened its UI/backend and confirmed this exact version.
    # Only now is the rollback bundle obsolete. Mark completion before cleanup so
    # the replacement can retry cleanup after interruption or filesystem failure.
    trap - HUP INT TERM
    printf '%s\n' "$version" > "$work/complete"
    if [ "$(dirname "$backup")" != "$(dirname "$target")" ] || [ "$backup" = "$target" ] || [ "$work" = / ]; then
      printf '%s\n' '更新成功，但旧包清理路径无效。' > "$work/error"
      exit 0
    fi
    if rm -rf "$backup"; then
      rm -rf "$work"
    fi
    exit 0
  fi
  count=$((count + 1))
  sleep 1
done
restore
exit 1
