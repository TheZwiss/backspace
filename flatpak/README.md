# Flatpak packaging

The root manifest builds Backspace from a pinned source commit for x86_64 and
aarch64 using the Electron BaseApp. All pnpm packages, Electron binaries, and
native dependency archives are declared in `node-sources.json`, so compilation
runs without network access. Flatpak, rather than Electron's built-in updater,
owns upgrades of this installation.

## Build and install locally

Install `flatpak-builder` and add Flathub, then run from the repository root:

```sh
flatpak-builder --user --install-deps-from=flathub --install --force-clean \
  build-flatpak com.backspace.desktop.yml
flatpak run com.backspace.desktop
```

When `pnpm-lock.yaml` changes, regenerate the offline source list:

```sh
flatpak run --filesystem="$PWD" --command=flatpak-node-generator \
  org.flatpak.Builder \
  --node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08 \
  -o "$PWD/flatpak/node-sources.json" pnpm "$PWD/pnpm-lock.yaml"
```

To build a single-file bundle after the first command, export the local
repository created by `flatpak-builder`:

```sh
flatpak build-bundle ~/.local/share/flatpak/repo Backspace.flatpak \
  com.backspace.desktop
```

The manifest intentionally does not expose the host home directory. Network,
audio, camera/device, graphics, PipeWire screen capture, notifications, and the
status notifier are enabled because they are core desktop-client features.
Global keybind behavior is desktop-dependent: X11 supports the bundled native
hook, while Wayland compositors may restrict global input observation. The
Flatpak sandbox also prevents Electron's current start-at-login integration and
host process scanning from working; use your desktop's autostart settings if
needed, and expect activity presence to remain unavailable in this build.
