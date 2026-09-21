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
git add packages/desktop/build/ packages/desktop/resources/ packages/web/public/icons/
git commit -m "chore: regenerate brand icons"
```

(Stage explicit paths rather than `git add -A` — the generator only writes to those three directories, and an unrelated working-tree change shouldn't accidentally land in a "regenerate icons" commit.)

## Determinism

Output is byte-stable for a given lockfile. The same SVGs in produce the
same PNG/ICO/ICNS bytes out, every time, on every OS — Sharp uses resvg
internally and writes deterministic PNGs, png-to-ico and png2icons don't
embed timestamps.

**Caveat:** byte-stability is *not* guaranteed across version bumps of
the three encoder deps. After a Renovate / dependabot PR upgrades any of
them, run `pnpm gen-icons` once and commit the resulting diff inside the
same PR. That follow-up commit isn't an artwork change — it's encoder
output drift, and gating it inside the dep PR keeps the artwork-change
git history clean.

## Sources

Every app-icon output renders straight from vector — there is no raster
source and no post-render masking. `app-icon.svg` already carries its own
squircle badge, drop shadow and inner shadow (rendered through SVG
`<filter>`, honoured by librsvg), so sharp renders it at the target size
and that's the pixel output. The only routing decision is size: 16 and 32
render from `app-icon-small.svg` instead, whose mark is a bolder,
simplified variant of the same glyph in the same badge geometry — at
16/32 the standard mark's inset strokes and soft-light overlay read as
noise. See `APP_ICON_SMALL_MAX` in `gen-icons.mjs`.

| Brand source                       | Drives                                                                              |
|------------------------------------|--------------------------------------------------------------------------------------|
| `assets/brand/app-icon.svg`         | App-icon outputs >32px: Linux 48–1024, `build/icon.png`, `.icns`/`.ico` reps ≥48, apple-touch-icon, PWA 192/512, in-app `logo.png`, the `app-icon-1024.png` reference export |
| `assets/brand/app-icon-small.svg`   | App-icon outputs at 16 and 32px: Linux 16/32, `.ico` reps 16/24/32                   |
| `assets/brand/mark.svg`             | PWA maskable inner mark, `logo-mark.svg` (byte copy)                                |
| `assets/brand/mark-small.svg`       | Web favicons 16/32 (transparent, glyph fills the box), Win/Linux tray (`tray-icon.ico`/`.png`, colour) |
| `assets/brand/mark-tray.svg`        | macOS menu-bar template + @2x (alpha + black; 18px body inset in the 22px canvas, 3px arrow channel) |

Two outputs composite the app icon or mark over an opaque copy of the
badge's own navy gradient (`#2E3D65` → `#110222`, matching `app-icon.svg`'s
`badgeFill`) instead of leaving the canvas transparent:

- `apple-touch-icon.png` — the app icon full-bleed on the gradient, so its
  rounded corners read as continuous badge instead of the transparent
  pixels iOS would otherwise paint black.
- `icon-maskable-512.png` — the gradient fills the whole canvas (Android
  launcher masks crop arbitrarily past the icon's own bounds) with the
  bare mark centred at 60% of the canvas height.

`Artworks-Backspace/` is the design archive — never read by this script.
