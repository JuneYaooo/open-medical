#!/bin/sh
set -eu
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)"
APPLICATIONS="${OPEN_MEDICAL_APPLICATIONS:-${HOME}/Applications}"
mkdir -p "$APPLICATIONS"
APPLICATIONS="$(CDPATH= cd -- "$APPLICATIONS" && pwd)"
TARGET="$APPLICATIONS/Open Medical.app"
LAUNCH=yes
if [ "${1:-}" = "--no-launch" ]; then LAUNCH=no; fi
if [ ! -f "$SOURCE/Contents/MacOS/Open Medical" ] || [ ! -f "$SOURCE/Contents/Resources/app/dist/index.html" ]; then
  echo "安装包不完整，原应用未修改。" >&2
  exit 1
fi
if [ "$SOURCE" = "$TARGET" ]; then
  if [ "$LAUNCH" = yes ]; then open "$TARGET"; fi
  exit 0
fi
STAGE="$(mktemp -d "$APPLICATIONS/.open-medical-install.XXXXXX")"
cleanup() {
  if [ ! -e "$TARGET" ] && [ -d "$STAGE/previous.app" ]; then
    mv "$STAGE/previous.app" "$TARGET" || return
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
if ! cp -cR "$SOURCE" "$STAGE/Open Medical.app" 2>/dev/null; then
  rm -rf "$STAGE/Open Medical.app"
  cp -R "$SOURCE" "$STAGE/Open Medical.app"
fi
if [ -e "$TARGET" ]; then mv "$TARGET" "$STAGE/previous.app"; fi
mv "$STAGE/Open Medical.app" "$TARGET"
if [ "$LAUNCH" = yes ]; then open "$TARGET"; fi
