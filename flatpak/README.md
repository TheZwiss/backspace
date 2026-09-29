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

`prepare-ci-manifest.mjs` checks that the generated source list exists before
writing or replacing the CI manifest. If it is missing, the error includes the
generator command below. Source paths resolve relative to the output manifest's
directory, not the current working directory, and the generated manifest builds
`.` as its application source, so write the CI manifest at the checkout root.

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

Publishing a release updates the manifest commit, AppStream release and
screenshot URLs, and `node-sources.json` automatically through
`.github/workflows/flatpak-release-metadata.yml`. The AppStream release
description is the first paragraph of the release notes, extracted by
`release-summary.mjs`; notes without one fail the run instead of shipping a
placeholder. The draft release already carries the `# Backspace X.Y.Z` heading,
so the human step is to write that paragraph directly under it. The workflow
builds the exact generated manifest on native x86_64 and aarch64 runners, opens
the metadata pull request only after both builds pass, and that pull request
merges itself once CI passes. Re-run a release by dispatching the workflow with
its tag; the re-run replaces the open pull request's branch. The full sequence,
including what to do when the pull request job fails, is in
`docs/systems/desktop.md` under "Release publishing". The committed
`node-sources.json` stays paired with the pinned release; see
"Release-paired offline sources" below.

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

## Release-paired offline sources

The committed `node-sources.json` belongs to the release commit the manifest
pins, not to the working tree: it is generated from that release's lockfile,
and the published manifest builds only with that pair. The two move together,
and only in the release metadata pull request. Ordinary dependency PRs must not
regenerate or hand-edit `node-sources.json`; the Flatpak workflow builds them
against `node-sources.ci.json`, generated from their own lockfile.

The `Check release pairing` job in `.github/workflows/flatpak.yml` enforces
this on pull requests with `flatpak/sources-pairing.mjs`: it fails when
`flatpak/node-sources.json` changes while the pinned `commit:` in
`io.github.TheZwiss.backspace.yml` stays the same, and passes any change that
moves the pin. Pushes and manual runs have no base to compare against, so that
step skips there. If main ever ends up off this rule, the next release's
metadata pull request regenerates the file and pairs it again.

The same job runs `flatpak/node-sdk-version.mjs` on every run: each reference
to the Node SDK extension in the two Flatpak workflows, this README and
`prepare-ci-manifest.mjs` must name an extension from the manifest's
`sdk-extensions` on its `runtime-version` branch. Moving to a new freedesktop
runtime fails the pull request until all of them move with the manifest.
