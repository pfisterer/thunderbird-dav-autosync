#!/bin/sh
# Packs addon/ into dist/dav-autosync-<version>.xpi.
# Reproducible: fixed file order and timestamps, so the same sources always give the same XPI (ATN compares the upload with a build from source).
set -eu
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./addon/manifest.json').version")
OUT="$PWD/dist/dav-autosync-$VERSION.xpi"
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
mkdir -p dist
rm -f "$OUT"
cp -R addon/. "$STAGE/"
find "$STAGE" -name '.*' -exec rm -rf {} +
find "$STAGE" -exec touch -h -t 202001010000 {} +
(cd "$STAGE" && find . -type f | sed 's#^\./##' | LC_ALL=C sort | TZ=UTC zip -q -X -D -@ "$OUT")
echo "dist/dav-autosync-$VERSION.xpi"
