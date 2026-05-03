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

App-icon outputs use a hybrid pipeline: SVG <128 px (crisp pixel-grid alignment, where 3D detail wouldn't read), 3D-rendered raster ≥128 px (the designed render shows). The closest-fit picker selects the smallest raster source whose native dimension is ≥ the target output size, so every output is a downscale — no upscale anywhere.

| Brand source                       | Drives                                                                              |
|------------------------------------|-------------------------------------------------------------------------------------|
| `assets/brand/app-icon.svg`        | App-icon outputs <128 px (favicons 16/32, small Linux launcher reps 16/32/48/64, small `.ico` reps 16/24/32/48/64) |
| `assets/brand/app-icon-x1.png` (149) | App-icon outputs ≥128 and ≤149 (Linux 128, Windows `.ico` 128 rep)                |
| `assets/brand/app-icon-x2.png` (294) | App-icon outputs >149 and ≤294 (Linux 256, Windows `.ico` 256 rep, apple-touch 180, PWA 192, in-app `logo.png` 256) |
| `assets/brand/app-icon-x3.png` (440) | App-icon outputs >294 and ≤440 (currently unused — reserved for future intermediate targets) |
| `assets/brand/app-icon-1024.png`     | App-icon outputs >440 (Linux 512, Linux 1024, `build/icon.png` 512, PWA 512, `.icns` synthesis input 1024) |
| `assets/brand/mark.svg`              | Win/Linux tray, PWA maskable inner mark                                            |
| `assets/brand/mark-mono-dark.svg`    | macOS menu-bar template (alpha + black)                                            |

After raster resize, every app-icon raster output is masked with a 22 %-radius rounded-square (matches Apple's macOS template ratio and the existing `app-icon.svg` geometry of `rx=32.42 / 147.46 ≈ 21.99 %`) so launchers/docks/homescreens that render the icon as-is produce the rounded silhouette they expect.

`Artworks-Backspace/` is the design archive — never read by this script.
