#!/bin/bash
# ============================================================
# Backspace — Electron Installer Build Script
# ============================================================
# Builds Electron installers for all platforms/architectures
# (macOS, Windows, Linux × arm64, x64) and copies the user-
# distributable artifacts into packages/desktop/installers/.
#
# Usage:
#   ./electronbuild.sh
# ============================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$REPO_ROOT/packages/desktop"
DIST_DIR="$DESKTOP_DIR/dist-electron"
INSTALLERS_DIR="$DESKTOP_DIR/installers"

if [ ! -d "$DESKTOP_DIR" ]; then
  echo "Error: $DESKTOP_DIR not found" >&2
  exit 1
fi

echo "==> Building Electron installers (mac/win/linux × arm64/x64)..."
cd "$DESKTOP_DIR"
pnpm build:all

echo "==> Copying installers to $INSTALLERS_DIR"
mkdir -p "$INSTALLERS_DIR"
rm -f "$INSTALLERS_DIR"/*.dmg \
      "$INSTALLERS_DIR"/*.exe \
      "$INSTALLERS_DIR"/*.AppImage \
      "$INSTALLERS_DIR"/*.deb \
      "$INSTALLERS_DIR"/*.zip

shopt -s nullglob
copied=0
for ext in dmg exe AppImage deb zip; do
  for f in "$DIST_DIR"/*."$ext"; do
    cp "$f" "$INSTALLERS_DIR/"
    copied=$((copied + 1))
  done
done
shopt -u nullglob

if [ "$copied" -eq 0 ]; then
  echo "Error: no installer artifacts found in $DIST_DIR" >&2
  exit 1
fi

echo "==> Done. $copied installer(s) in $INSTALLERS_DIR:"
ls -lh "$INSTALLERS_DIR" | awk 'NR>1 {printf "    %-40s %s\n", $9, $5}'
