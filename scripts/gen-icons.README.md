# Icon Generator

Regenerates every brand artefact from sources in `assets/brand/`:

- macOS `.icns`, Windows `.ico`, Linux per-size PNGs (`packages/desktop/build/`)
- Tray icons for all three platforms (`packages/desktop/resources/`)
- Web favicons, PWA manifest icons, maskable, in-app `logo.png` (`packages/web/public/icons/`)

## When to run

After changing any file under `assets/brand/`, **or** after bumping `sharp`,
`png-to-ico`, or `png2icons` in the root `package.json`. Commit the diff in
the same PR.

```bash
pnpm gen-icons
git status                       # review which files changed
git add packages/desktop/build/ packages/desktop/resources/ packages/web/public/icons/ assets/brand/app-icon-1024.png
git commit -m "chore: regenerate brand icons"
```

(Stage explicit paths rather than `git add -A` — the generator only writes to those four paths, and an unrelated working-tree change shouldn't accidentally land in a "regenerate icons" commit.)

## Determinism

Output is byte-stable for a given lockfile. The same SVGs in produce the
same PNG/ICO/ICNS bytes out, every time, on every OS — Sharp uses librsvg
internally and writes deterministic PNGs, png-to-ico and png2icons don't
embed timestamps.

**Caveat:** byte-stability is *not* guaranteed across version bumps of
the three encoder deps. After a Renovate / dependabot PR upgrades any of
them, run `pnpm gen-icons` once and commit the resulting diff inside the
same PR. That follow-up commit isn't an artwork change — it's encoder
output drift, and gating it inside the dep PR keeps the artwork-change
git history clean.

## Sources

The split is by surface, not by file type. UI surfaces (favicons, the
tray icons, the in-app sidebar tile) stay the flat two-colour mark. The
app-icon family, meaning every output where the OS shows this app as one
launchable icon (dock, taskbar, Start menu, Alt-Tab, PWA install, iOS
home screen, the maskable Android icon), is the dimensional composition:
a squircle badge on a `#2a2740`-to-`#12101d` plum gradient, drop shadow,
inner shadow and a soft-light stroke overlay, with the glyph itself a
white-to-`#7c6cf6` gradient.

Every app-icon output renders straight from vector: there is no raster
source and no post-render masking. `app-icon.svg` carries its own
squircle badge, filters and stroke overlay, so sharp/librsvg renders it
at the target size and that's the pixel output. The only routing decision
is size: 16 and 32 render from `app-icon-small.svg` instead, whose mark
is a bolder, simplified variant of the same glyph in the same badge
geometry. At 16/32 the standard mark's inset strokes and shadow read as
noise at that size. See `APP_ICON_SMALL_MAX` in `gen-icons.mjs`.

| Brand source                          | Drives                                                                              |
|----------------------------------------|--------------------------------------------------------------------------------------|
| `assets/brand/app-icon.svg`             | App-icon outputs >32px: Linux 48–1024, `build/icon.png`, `.ico` reps ≥48, apple-touch-icon, PWA 192/512, in-app `logo.png`, the `app-icon-1024.png` reference export; also every `.icns` rep, 16/32 included, since png2icons synthesises the whole iconset from the single 1024 render |
| `assets/brand/app-icon-small.svg`       | App-icon outputs at 16 and 32px: Linux 16/32, `.ico` reps 16/24/32 (the `.icns` set does not use this file)            |
| `assets/brand/mark-icon.svg`            | PWA maskable inner mark: the bare gradient glyph, transparent, from the app-icon composition, with no badge behind it |
| `assets/brand/mark-small.svg`           | Web favicons 16/32 (flat, transparent, glyph fills the box), Win/Linux tray (`tray-icon.ico`/`.png`, flat colour) |
| `assets/brand/mark-mono-light.svg`      | `logo-mark.svg` (byte copy, for the sidebar's lavender home tile) |
| `assets/brand/mark-tray.svg`            | macOS menu-bar template + @2x (alpha + black; 18px body inset in the 22px canvas, 3px arrow channel) |

`assets/brand/mark.svg` (the flat-lavender standalone glyph, for use on
dark UI-surface grounds) is not read by this script.

Two outputs composite the app icon or mark over an opaque copy of the
badge's own plum gradient (`#2a2740` to `#12101d`, matching `app-icon.svg`'s
squircle) instead of leaving the canvas transparent:

- `apple-touch-icon.png`: the app icon full-bleed on the gradient ground,
  so its rounded corners read as continuous badge instead of the
  transparent pixels iOS would otherwise paint black.
- `icon-maskable-512.png`: the plum gradient fills the whole canvas
  (Android launcher masks crop arbitrarily past the icon's own bounds)
  with `mark-icon.svg`'s gradient glyph centred at 60% of the canvas
  height.

`Artworks-Backspace/` is the design archive — never read by this script.
