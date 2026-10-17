#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
pnpm --dir web-agent install --frozen-lockfile
scripts/build_lake.sh
