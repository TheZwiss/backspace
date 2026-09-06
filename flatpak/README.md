# Flatpak packaging

The root manifest builds Backspace from a pinned source commit for x86_64 and
aarch64 using the Electron BaseApp. All pnpm packages, Electron binaries, and
native dependency archives are declared in `node-sources.json`, so compilation
runs without network access. Flatpak, rather than Electron's built-in updater,
owns upgrades of this installation.

## Build and install locally

The published manifest builds a pinned release with its matching committed
`flatpak/node-sources.json`. To build that release on Linux:

```sh
flatpak-builder --user --install-deps-from=flathub --install --force-clean \
  build-flatpak io.github.TheZwiss.backspace.yml
flatpak run io.github.TheZwiss.backspace
```

To test the current checkout, generate a separate offline source list and CI
manifest. Install Flatpak Builder and the pinned Node SDK extension first:

```sh
flatpak remote-add --user --if-not-exists flathub \
  https://dl.flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub org.flatpak.Builder \
  org.freedesktop.Sdk.Extension.node24//25.08
```

Run these commands again after changing `pnpm-lock.yaml`. Generation needs
network access; the subsequent compilation runs offline. The generated manifest
uses the current directory and `flatpak/node-sources.ci.json`; both generated
files are ignored by Git.

```sh
flatpak run --filesystem="$PWD" --command=flatpak-node-generator \
  org.flatpak.Builder \
  --electron-node-headers \
  --node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08 \
  -o "$PWD/flatpak/node-sources.ci.json" pnpm "$PWD/pnpm-lock.yaml"
node flatpak/prepare-ci-manifest.mjs
flatpak-builder --user --install-deps-from=flathub --install --force-clean \
  build-flatpak io.github.TheZwiss.backspace.ci.yml
flatpak run io.github.TheZwiss.backspace
```

Release tags update the manifest commit, AppStream release and screenshot URLs,
and `node-sources.json` automatically through `.github/workflows/release.yml`.
That workflow builds the exact generated manifest on native x86_64 and aarch64
runners and opens the metadata pull request only after both builds pass.
Ordinary dependency PRs must not regenerate the committed `node-sources.json`
from their working-tree lockfile: it belongs to the pinned release. Release
generation remains a maintainer/automation step and uses the release lockfile.

The Flatpak CI workflow generates `node-sources.ci.json` automatically from the
checked-out lockfile before building on both x86_64 and aarch64. Contributors on
Windows or macOS can update dependencies and submit the lockfile normally,
without installing Flatpak or committing generated sources. Generation failures
appear in the named generation step before the offline build starts.

To build a single-file bundle after either build above, export the local
repository created by `flatpak-builder`:

```sh
flatpak build-bundle ~/.local/share/flatpak/repo Backspace.flatpak \
  io.github.TheZwiss.backspace
```

The manifest intentionally does not expose the host home directory or the
unrestricted system bus. Network, audio, host devices (for direct webcam
access), DRI graphics, notifications, and the status notifier are enabled
because they are core desktop-client features. System-bus access is limited to
UPower so Chromium can observe battery state. PipeWire screen capture goes
through the desktop portals.
Global keybind behavior is desktop-dependent: X11 supports the bundled native
hook, which is rebuilt against the bundled Electron headers. Wayland uses the
GlobalShortcuts portal and requires a supporting desktop backend and user consent.
The first visit to Keybinds registers all available actions; subsequent launches
restore registration from the portal. Assign, change or remove shortcuts in the
system settings under Backspace. The app displays a read-only list and allows
retrying a denied/closed session. Browser/X11 local bindings are ignored on
Wayland, including when its portal backend is unavailable. No extra Flatpak bus
permission is required. Activity detection follows
the same platform limits as global keybinds; it is not disabled merely because
the app is packaged as Flatpak. Electron's current start-at-login integration
does not work across the sandbox boundary, so the client hides that setting;
use the desktop environment's autostart settings instead.
