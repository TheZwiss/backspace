# Flatpak packaging

The root manifest builds Backspace from a pinned source commit for x86_64 and
aarch64 using the Electron BaseApp. All pnpm packages, Electron binaries, and
native dependency archives are declared in `node-sources.json`, so compilation
runs without network access. Flatpak, rather than Electron's built-in updater,
owns upgrades of this installation.

## Build and install locally

The published manifest deliberately builds the latest released tag. To test
changes in the current checkout, generate the ignored CI manifest first. It
replaces only the pinned application source with the current directory:

```sh
node flatpak/prepare-ci-manifest.mjs
flatpak-builder --user --install-deps-from=flathub --install --force-clean \
  build-flatpak io.github.TheZwiss.backspace.ci.yml
flatpak run io.github.TheZwiss.backspace
```

Release tags update the manifest commit, AppStream release and screenshot URLs,
and `node-sources.json` automatically through `.github/workflows/release.yml`.
To regenerate the offline source list manually after changing `pnpm-lock.yaml`:

```sh
flatpak run --filesystem="$PWD" --command=flatpak-node-generator \
  org.flatpak.Builder \
  --electron-node-headers \
  --node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08 \
  -o "$PWD/flatpak/node-sources.json" pnpm "$PWD/pnpm-lock.yaml"
```

To build a single-file bundle after the first command, export the local
repository created by `flatpak-builder`:

```sh
flatpak build-bundle ~/.local/share/flatpak/repo Backspace.flatpak \
  io.github.TheZwiss.backspace
```

The manifest intentionally does not expose the host home directory or all host
devices. Network, audio, DRI graphics, notifications, and the status notifier
are enabled because they are core desktop-client features. Camera access and
PipeWire screen capture go through the desktop portals.
Global keybind behavior is desktop-dependent: X11 supports the bundled native
hook, which is rebuilt against the bundled Electron headers, while Wayland
compositors may restrict global input observation. Activity detection follows
the same platform limits as global keybinds; it is not disabled merely because
the app is packaged as Flatpak. Electron's current start-at-login integration
does not work across the sandbox boundary, so the client hides that setting;
use the desktop environment's autostart settings instead.
