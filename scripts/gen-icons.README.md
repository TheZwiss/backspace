# Icon Generator

Regenerates every brand artefact from `assets/brand/*.svg`:

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

## Source SVGs

| Brand source                    | Drives                                        |
|---------------------------------|-----------------------------------------------|
| `assets/brand/app-icon.svg`     | Every full app icon, all favicons, PWA        |
| `assets/brand/mark.svg`         | Win/Linux tray, in-app logo, PWA maskable     |
| `assets/brand/mark-mono-dark.svg` | macOS menu-bar template (alpha + black)     |

`Artworks-Backspace/` is the design archive — never read by this script.
