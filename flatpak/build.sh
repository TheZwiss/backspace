#!/bin/sh

set -eu

PNPM="node $PWD/flatpak-pnpm/bin/pnpm.cjs"

# Every dependency and Electron archive is supplied by node-sources.json.
# These variables keep package lifecycle scripts inside those offline caches.
export ELECTRON_CACHE="$PWD/flatpak-node/cache/electron"
export npm_config_cache="$PWD/flatpak-node/cache"
export npm_config_offline=true

# Install only the desktop workspace and its dependency closure. The lockfile
# remains the source of truth and pnpm fails if any generated source is missing.
$PNPM --filter @backspace/desktop... install --offline --frozen-lockfile
$PNPM --filter @backspace/desktop run build:ts

case "$FLATPAK_ARCH" in
  x86_64)
    electron_builder_arch=x64
    unpacked_dir=linux-unpacked
    ;;
  aarch64)
    electron_builder_arch=arm64
    unpacked_dir=linux-arm64-unpacked
    ;;
  *)
    echo "Unsupported Flatpak architecture: $FLATPAK_ARCH" >&2
    exit 1
    ;;
esac

$PNPM --filter @backspace/desktop exec electron-builder \
  --linux --dir "--$electron_builder_arch"

install -d "$FLATPAK_DEST/backspace"
cp -a "packages/desktop/dist-electron/$unpacked_dir/." "$FLATPAK_DEST/backspace/"

# Flatpak owns application updates; /app is an immutable deployment.
rm -f "$FLATPAK_DEST/backspace/resources/app-update.yml"

install -D -m 755 backspace "$FLATPAK_DEST/bin/backspace"
install -D -m 644 com.backspace.desktop.desktop \
  "$FLATPAK_DEST/share/applications/com.backspace.desktop.desktop"
install -D -m 644 com.backspace.desktop.metainfo.xml \
  "$FLATPAK_DEST/share/metainfo/com.backspace.desktop.metainfo.xml"

for size in 16 32 48 64 128 256 512; do
  install -D -m 644 \
    "packages/desktop/build/icons/${size}x${size}.png" \
    "$FLATPAK_DEST/share/icons/hicolor/${size}x${size}/apps/com.backspace.desktop.png"
done
