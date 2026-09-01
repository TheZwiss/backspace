#!/bin/sh

set -eu

PNPM="node $PWD/flatpak-pnpm/bin/pnpm.cjs"

# Every dependency and Electron archive is supplied by node-sources.json.
# These variables keep package lifecycle scripts inside those offline caches.
export ELECTRON_CACHE="$PWD/flatpak-node/cache/electron"
export npm_config_cache="$PWD/flatpak-node/cache"
export npm_config_offline=true

# electron-rebuild otherwise looks in ~/.electron-gyp and attempts a network
# download. The generator creates one extracted Electron headers tree alongside
# the Node SDK entry, whose include directory is a symlink into the SDK.
electron_headers_dir=""
for candidate in "$PWD"/flatpak-node/cache/node-gyp/*; do
  [ -d "$candidate" ] || continue
  [ -L "$candidate/include" ] && continue
  if [ -n "$electron_headers_dir" ]; then
    echo "Expected exactly one Electron headers directory" >&2
    exit 1
  fi
  electron_headers_dir="$candidate"
done
if [ -z "$electron_headers_dir" ]; then
  echo "Electron headers are missing from node-sources.json" >&2
  exit 1
fi
export npm_config_nodedir="$electron_headers_dir"

# Install only the desktop workspace and its dependency closure. The lockfile
# remains the source of truth and pnpm fails if any generated source is missing.
$PNPM --filter @backspace/desktop... install --offline --frozen-lockfile
$PNPM --filter @backspace/desktop run build:ts

# Preserve the module electron-rebuild compiled from source. The shared
# afterPack hook intentionally discards host build artifacts for cross-platform
# release jobs, so the Flatpak build restores its target-native result below.
uiohook_native_module="$(find "$PWD/node_modules/.pnpm" \
  -path '*/uiohook-napi/build/Release/uiohook_napi.node' -print -quit)"
if [ -z "$uiohook_native_module" ]; then
  echo "electron-rebuild did not produce uiohook_napi.node" >&2
  exit 1
fi

case "$FLATPAK_ARCH" in
  x86_64)
    electron_builder_arch=x64
    node_prebuild_arch=x64
    unpacked_dir=linux-unpacked
    ;;
  aarch64)
    electron_builder_arch=arm64
    node_prebuild_arch=arm64
    unpacked_dir=linux-arm64-unpacked
    ;;
  *)
    echo "Unsupported Flatpak architecture: $FLATPAK_ARCH" >&2
    exit 1
    ;;
esac

$PNPM --filter @backspace/desktop exec electron-builder \
  --linux --dir "--$electron_builder_arch"

packaged_uiohook="packages/desktop/dist-electron/$unpacked_dir/resources/app.asar.unpacked/node_modules/uiohook-napi"
rm -rf "$packaged_uiohook/prebuilds"
install -D -m 755 "$uiohook_native_module" \
  "$packaged_uiohook/prebuilds/linux-$node_prebuild_arch/uiohook-napi.node"

install -d "$FLATPAK_DEST/backspace"
cp -a "packages/desktop/dist-electron/$unpacked_dir/." "$FLATPAK_DEST/backspace/"

# Flatpak owns application updates; /app is an immutable deployment.
rm -f "$FLATPAK_DEST/backspace/resources/app-update.yml"

install -D -m 755 backspace "$FLATPAK_DEST/bin/backspace"
install -D -m 644 io.github.TheZwiss.backspace.desktop \
  "$FLATPAK_DEST/share/applications/io.github.TheZwiss.backspace.desktop"
install -D -m 644 io.github.TheZwiss.backspace.metainfo.xml \
  "$FLATPAK_DEST/share/metainfo/io.github.TheZwiss.backspace.metainfo.xml"

for size in 16 32 48 64 128 256 512; do
  install -D -m 644 \
    "packages/desktop/build/icons/${size}x${size}.png" \
    "$FLATPAK_DEST/share/icons/hicolor/${size}x${size}/apps/io.github.TheZwiss.backspace.png"
done
