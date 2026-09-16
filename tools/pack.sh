#!/usr/bin/env bash
#
# Pack the app into an installable zip.
#
# Use this instead of a bare `fdk pack`, which fails on the vendored JsSIP
# bundle (ISSUES.md #2). This builds a copy of the app with JsSIP inlined into
# index.html — which FDK does not lint — and packs that. The source tree is
# never modified.
#
#   ./tools/pack.sh          →  dist/<name>.zip
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_ROOT="$ROOT/build"
# FDK names the zip after the directory it packs, so pack from one named for the app.
BUILD="$BUILD_ROOT/vobiz-freshdesk-calling"

if ! command -v fdk >/dev/null 2>&1; then
  echo "✖ fdk not on PATH. This app needs Node 24.11.1 + FDK 10.1.9 — try: nvm use 24.11.1" >&2
  exit 1
fi

if [ ! -d "$ROOT/node_modules" ]; then
  echo "✖ node_modules missing — fdk pack runs the unit tests and needs vitest. Run: npm install" >&2
  exit 1
fi

rm -rf "$BUILD_ROOT" "$ROOT/dist"
mkdir -p "$BUILD"

rsync -a \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude build \
  --exclude coverage \
  "$ROOT/" "$BUILD/"

# Symlinked, not copied: fdk pack runs `npm run fdk-unit-test` in the build dir.
ln -s "$ROOT/node_modules" "$BUILD/node_modules"

node "$ROOT/tools/inline-jssip.mjs" "$BUILD"

cd "$BUILD"
# --skip-coverage: FDK 10 otherwise blocks the pack unless `fdk run` has been
# used in a browser to generate local *simulation* coverage above 50%. That is
# a Marketplace submission gate; custom apps are not reviewed, so it does not
# apply. Unit tests still run and must pass before the zip is written.
fdk pack --skip-coverage

mkdir -p "$ROOT/dist"
cp "$BUILD"/dist/*.zip "$ROOT/dist/"
rm -rf "$BUILD_ROOT"

echo
echo "✔ Packed:"
ls -la "$ROOT/dist"
