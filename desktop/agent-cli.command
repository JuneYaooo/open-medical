#!/bin/sh
set -eu
APP="$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)"
export ELECTRON_RUN_AS_NODE=1
exec "$APP/Contents/MacOS/Open Medical" "$APP/Contents/Resources/app/scripts/workspace-cli.mjs" "$@"
