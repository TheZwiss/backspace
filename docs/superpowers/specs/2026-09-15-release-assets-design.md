# Release assets: naming, count and the Downloads table

Date: 2026-09-15. Status: approved in chat, pending implementation.

## Problem

The GitHub release page for 1.3.0 lists 22 assets sorted alphabetically. The
names carry no platform (`Backspace-1.3.0-arm64.deb`, `-arm64.dmg`,
`-arm64.exe` sit next to each other), Windows is somewhere in the middle
although it is the most used platform, and the architecture suffixes differ
per format (`x64`, `x86_64`, `amd64`). A visitor cannot tell at a glance which
file is theirs.

## Facts the design rests on

- GitHub sorts release assets by name, case-insensitively, with no other
  control. Verified against the Electron release page (`SHASUMS256.txt` sorts
  after `mksnapshot-*`). With plain platform names the order is therefore
  linux, mac, win. No natural name changes that; only a numbered prefix or a
  word that happens to sort before "linux" would, and both are rejected as
  gimmicks that land in every user's Downloads folder.
- The per-arch Windows installers (`-x64.exe`, `-arm64.exe`) exist only
  because the `artifactName` pattern contains `${arch}`. electron-builder's
  `NsisTarget.finishBuild` then builds the universal installer plus one per
  arch. `nsis.buildUniversalInstaller: false` builds only the per-arch ones.
- electron-updater already picks the per-arch file on Windows:
  `Provider.findFile` prefers the entry whose URL contains `process.arch`
  (`x64` or `arm64`). That is why `-x64.exe` had 32 downloads on 1.3.0 and the
  universal exe had 2.
- The mac `.zip` targets serve only Squirrel.Mac auto-update, which is off:
  ad-hoc signed builds resolve to `manual` update capability
  (`docs/systems/desktop.md`, "Update capability"). electron-builder accepts a
  dmg-only mac publish (`PublishManager` requires dmg *or* zip).
- `${os}` expands to `win`, `mac`, `linux`. `${arch}` for x64 is hardwired by
  `builder-util` to `x86_64` for AppImage and `amd64` for deb, and stays `x64`
  elsewhere. A per-job `${env.NAME}` in `linux.artifactName` could force
  `x64` on both Linux legs (they are separate matrix jobs), but the Debian and
  AppImage spellings are what their users expect, so keeping `x86_64`/`amd64`
  is a choice, not a constraint.

## Decisions

1. **Names:** `artifactName: "${productName}-${version}-${os}-${arch}.${ext}"`.
2. **Windows:** `nsis.buildUniversalInstaller: false`. Two installers,
   `-win-x64.exe` and `-win-arm64.exe`, no universal one.
3. **macOS:** `mac.target: [dmg]`. The `zip` target returns the day a Developer
   ID makes Squirrel updates possible; say so in a config comment.
4. **Release notes:** the `create-release` job writes the draft body with a
   Downloads table in Windows, Linux, macOS order. Jannis writes "What's new"
   above it before publishing, as today.
5. **Desktop tab:** offers per-arch Windows builds with arch detection and a
   picker, the way it does for Linux.

## Resulting asset list (16 instead of 22)

```
Backspace-1.4.0-linux-amd64.deb
Backspace-1.4.0-linux-arm64.AppImage
Backspace-1.4.0-linux-arm64.deb
Backspace-1.4.0-linux-x86_64.AppImage
Backspace-1.4.0-mac-arm64.dmg
Backspace-1.4.0-mac-arm64.dmg.blockmap
Backspace-1.4.0-mac-x64.dmg
Backspace-1.4.0-mac-x64.dmg.blockmap
Backspace-1.4.0-win-arm64.exe
Backspace-1.4.0-win-arm64.exe.blockmap
Backspace-1.4.0-win-x64.exe
Backspace-1.4.0-win-x64.exe.blockmap
latest-linux-arm64.yml
latest-linux.yml
latest-mac.yml
latest.yml
```

Blockmaps and `latest*.yml` cannot go: electron-updater reads them. The dmg
blockmaps are unused while mac updates are manual; the only switch that skips
them (`dmg.writeUpdateInfo: false`) also drops `latest-mac.yml`, which a
manual-mode mac still fetches to raise its "update available" notice
(`packages/desktop/src/main.ts`, `checkForUpdates`). So they stay.

## Downloads table in the release body

Written by `create-release` in `.github/workflows/release.yml`, from `$TAG`,
before any asset exists (the draft is invisible until published, so the
temporary 404s do not matter). Markdown:

```
## Downloads

| Platform | Download |
|---|---|
| Windows x64 | [Backspace-1.4.0-win-x64.exe](.../download/v1.4.0/Backspace-1.4.0-win-x64.exe) |
| Windows arm64 | [Backspace-1.4.0-win-arm64.exe](...) |
| Linux AppImage x86_64 | [Backspace-1.4.0-linux-x86_64.AppImage](...) |
| Linux AppImage arm64 | [Backspace-1.4.0-linux-arm64.AppImage](...) |
| Linux deb amd64 | [Backspace-1.4.0-linux-amd64.deb](...) |
| Linux deb arm64 | [Backspace-1.4.0-linux-arm64.deb](...) |
| macOS Apple Silicon | [Backspace-1.4.0-mac-arm64.dmg](...) |
| macOS Intel | [Backspace-1.4.0-mac-x64.dmg](...) |

The `.blockmap` and `latest*.yml` files are read by the auto-updater and are not meant to be downloaded by hand.
```

The URL base is `https://github.com/<repo>/releases/download/<tag>/`. The
existing `--notes ""` becomes `--notes-file` on a file the step writes. The
comment above the step that says notes stay empty is rewritten.

## Desktop tab (`packages/web`)

`packages/web/src/platform/desktopDownload.ts`:

- `BUILDS` gains the `${os}` token in `fileArch` for every entry (`-win-x64`,
  `-mac-arm64`, `-linux-x86_64`, `-linux-amd64`, ...). The single Windows entry
  with `arch: null` becomes two entries, `x64` and `arm64`, both `kind: 'exe'`.
- `DesktopDownload.arch` is no longer nullable; the "combined installer" case
  is gone. `DesktopDownloadLinks` and callers follow.
- `detectDesktopPlatform` runs arch detection for Windows too, with one rule
  that differs from mac and linux: on Windows only client hints count. The
  user agent token `Win64; x64` is frozen on Windows on ARM in every browser,
  so a UA hit says nothing there; `archFromUserAgent` is skipped for Windows
  and anything that is not a client-hint answer is `x64` with
  `archGuessed: true`. `DEFAULT_ARCH.windows = 'x64'`.
- The x64 default is load-bearing, not just likely: the x64 installer on a
  Windows-on-ARM machine installs and runs under emulation, while the arm64
  installer on an x64 machine extracts nothing (electron-builder's
  `extractAppPackage.nsh` finds no matching package). A wrong guess must
  therefore always land on x64.
- `primaryBuild` for Windows picks the detected arch. `platformBuilds` no
  longer special-cases Windows.
- Ordering rules keep the detected platform first and then Windows, Linux,
  macOS for the rest, matching the release table. (The current code runs
  windows, mac, linux; that changes.)

`DesktopDownloadPanel.tsx`:

- Windows gets the same x64 / arm64 picker Linux has (labels
  `desktopDownload.arch.x64` / `.arm64` already exist).
- `selectionFor` gains `windowsArch`, `downloadFor` drops the arch-less
  Windows case, and the "arch guessed" note handles Windows. The note string
  for Windows says the browser did not report the processor and x64 is
  preselected.
- `PLATFORMS` order becomes windows, linux, mac.

Locales `en`, `de`, `ru` `settings.json`: `desktopDownload.covers.windows`
("x64 or arm64", in each language's register), new
`desktopDownload.archGuessed.windows`, and `desktopDownload.unsupported`
reordered to "Windows, Linux and macOS". `scripts/check-i18n.mjs` (part of
`pnpm typecheck`) fails on a missing key or a non-English value identical to
English; the arch strings differ by the conjunction, which satisfies it.

Tests: `desktopDownload.test.ts` and `DesktopDownloadPanel.test.tsx` assert
filenames and order; both are updated to the new names and the new
Windows behaviour (detected x64, detected arm64, guessed on Firefox UA).
`MobileSettingsScreen.test.tsx` references the builds too and is checked.

Dev harness `packages/web/src/dev/desktop-download-preview.tsx`: today it
maps one client-hint architecture per OS and only takes `?os=` and
`&guessed=1`. It gains `?arch=x86|arm` so the three Windows states (x64
detected, arm64 detected, guessed) can be screenshotted before Jannis sees
them.

## Other files

- `packages/desktop/electron-builder.yml`: the three config changes above with
  comments explaining why (per-arch only, no mac zip, the `${os}` token and the
  fixed Linux arch spellings).
- `README.md` download table: new filenames, Windows split into x64/arm64,
  row order Windows, Linux, macOS.
- `docs/systems/desktop.md`: "Desktop tab in the browser" (Windows no longer
  the combined installer, new order), "Build Targets" (mac: dmg only) and the
  yaml snippet above it, "Release publishing" (draft body carries the
  Downloads table; asset naming scheme and the count).
- `.github/workflows/release.yml`: only the `create-release` step changes. The
  fuse and codesign checks read the unpacked directories, not the installers,
  so they are untouched. The matrix `args` stay.

## What does not change

- The updater path. 1.3.0 installs read the 1.4.0 `latest*.yml`, which lists
  the new names; Windows picks by `process.arch` (a 1.3.0 install from the
  universal exe holds the x64 package and shares the install GUID, so the
  per-arch installer updates it in place; its first update is a full download
  because no cached blockmap matches, logged, not an error), Linux per feed
  file. `latest-mac.yml` changes shape (dmg entries only, `path:` on a dmg),
  which manual mode never downloads from.
- The Flatpak pipeline, which builds from source.
- Anything about the 1.3.0 release itself. The new layout appears with the
  next tag.

## Verification

- `pnpm --filter @backspace/web test` for the two download test files and the
  mobile settings test.
- `pnpm --filter @backspace/desktop exec electron-builder --mac --publish never`
  locally on this Mac (after `tsc`): confirms the `${os}` pattern expands, the
  dmg-only mac target still writes `latest-mac.yml` into `dist-electron`, and
  that no zip is produced.
- Dev-harness screenshots of the Windows states of the Desktop tab.
- `actionlint` on `release.yml`; the Downloads-table step is exercised by
  running its shell body locally with `TAG=v1.4.0` and reading the file.
- Windows and Linux naming can only be proven at tag time; the risk is
  confined to the name pattern, which is shared with the mac build that is
  verified locally.
