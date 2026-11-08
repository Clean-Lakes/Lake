#!/bin/sh
# Compatibility entry for the isolated TypeScript Dev artifact.
set -eu
exec sh "$(dirname "$0")/build_lake_typescript.sh" --candidate "$@"
