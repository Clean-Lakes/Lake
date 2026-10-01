#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
npm exec --yes --package=node@24.14.0 -- node scripts/build_zcode_agent.mjs
scripts/build_lake.sh
