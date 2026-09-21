# Brand v2 rollout

Branch `brand/v2-rollout`, based on the head of PR #229 (`96df70a5`, the
site-only logo refresh). The site is now the brand reference; this plan brings
every other surface in the repo to it. No push until Jannis has tested.

## Spec (binding)

The brand as shipped in `site/assets/` on the PR head:

- **Mark**: the backspace-key glyph in `site/assets/logo-glyph.svg`
  (viewBox `62 38 133 180`, single filled path). Its outline twin is
  `site/assets/logo-glyph-stroke.svg`.
- **Mark fill**: linear gradient at 135 degrees, `white` at 0% to `#0061FF`
  at 100% (`paint1_linear` in `site/assets/logo.svg`), with the outline
  laid over it as a 1px white stroke in `mix-blend-mode: soft-light`.
- **App icon composition**: `site/assets/logo.svg`, a 256x256 squircle
  filled top-to-bottom `#2E3D65` to `#110222`, the mark inset at x 62..195,
  y 38..218, with the SVG drop shadow and inner shadow already in that file.
  Copy that file's geometry and filters; do not redraw it.
- **Primary colour**: `#0061ff`, hover `#0052d9`. Active state for the app:
  `#0047bd`. As RGB triplets for `globals.css`: `0 97 255`, `0 82 217`,
  `0 71 189`.
- **Surfaces stay warm and dark** (`#0b0b10`, `#13131a`, `#1a1a23`); the
  navy page gradient is a website-only choice and is not brought into the
  app or desktop.
- **Pastel accents** (`--accent-lavender` and the rest) are role colours,
  not brand, and do not change.
- **Fonts**: Fabio XM is a website headline face only. The app and desktop
  keep their current fonts.

## Global constraints

- Every existing asset keeps its file name, path, pixel size and channel
  layout (see the size table below). Nothing that references an asset by
  path changes, unless a task says so.
- No new dependency. Tooling uses what the root `package.json` already
  has: `sharp`, `png-to-ico`, `png2icons`. Nothing else.
- TypeScript strict, no `any`. Scripts are `.mjs` under `scripts/`, in
  the style of `scripts/gen-icons.mjs`.
- Small sizes must read. Rule: wherever the mark renders at 32px or smaller
  on its long side, the arrow's transparent channel is at least 1.5 device
  px wide at 1x. If the site glyph does not satisfy that, a bolder
  small-size variant is used at those sizes; the silhouette stays the same
  shape.
- macOS template images are alpha-only silhouettes: every opaque pixel is
  pure black (`r=g=b=0`). macOS tints them; colour in the file is a defect.
- Commit messages: conventional prefix (`feat(brand): ...`), no em dashes,
  no session links, no co-author trailer other than what the harness adds.
- Never push. Never open a PR.
- Docs: `docs/systems/design-system.md` gets a Brand section; CLAUDE.md's
  design summary line is updated. No other doc unless a task says so.

## Asset size table (must match exactly after regeneration)

| Path | Size | Source |
|---|---|---|
| `assets/brand/app-icon.svg` | vector | the 256 composition |
| `assets/brand/mark.svg` | vector | glyph with baked gradient + stroke, transparent |
| `assets/brand/mark-mono-dark.svg` | vector | glyph silhouette, `#000` fill |
| `assets/brand/mark-small.svg` | vector | bold small-size variant, baked gradient |
| `assets/brand/mark-tray.svg` | vector | mono silhouette tuned for 22px |
| `assets/brand/app-icon-small.svg` | vector | the 256 composition with the mark-small geometry |
| `assets/brand/app-icon-1024.png` | 1024, RGBA | reference export of app-icon (an output now, not an input) |
| `assets/brand/app-icon-x{1,2,3}.png` | deleted | were raster inputs for the old 3D icon |
| `packages/web/public/icons/favicon-16.png` | 16, RGBA | mark-small, transparent |
| `packages/web/public/icons/favicon-32.png` | 32, RGBA | mark-small, transparent |
| `packages/web/public/icons/apple-touch-icon.png` | 180, RGBA, fully opaque | app-icon full-bleed (no transparent corners; iOS renders them black) |
| `packages/web/public/icons/icon-192.png` | 192, RGBA | app-icon |
| `packages/web/public/icons/icon-512.png` | 512, RGBA | app-icon |
| `packages/web/public/icons/icon-maskable-512.png` | 512, RGBA, fully opaque | navy gradient full-bleed, mark inside the central 80% safe zone |
| `packages/web/public/icons/logo.png` | 256, RGBA | app-icon |
| `packages/web/public/icons/logo-mark.svg` | vector | copy of mark.svg, or of mark-small.svg if Task 1's measurement says the 25px render fails the small-size rule |
| `packages/desktop/build/icon.png` | 512, RGBA | app-icon |
| `packages/desktop/build/icons/{16,32,48,64,128,256,512,1024}x{same}.png` | RGBA | app-icon; 16 and 32 render from app-icon-small |
| `packages/desktop/build/icon.icns` | 16..1024 | from the icons set |
| `packages/desktop/build/icon.ico` | 16,24,32,48,64,128,256 | from the icons set |
| `packages/desktop/resources/tray-iconTemplate.png` | 18x22, RGBA, mono black | mark-tray (16px glyph, centred by alpha centroid) |
| `packages/desktop/resources/tray-iconTemplate@2x.png` | 36x44, RGBA, mono black | mark-tray |
| `packages/desktop/resources/tray-icon.png` | 22, RGBA | mark-small, colour, 18px glyph centred in the cell |
| `packages/desktop/resources/tray-icon.ico` | 16,20,24,32,40,48 | mark-small, colour, glyph inset per frame (14,18,21,28,35,42 tall) |
| `assets/social-preview.png` | 1280x640, RGB | social composition |
| `site/social-preview.png` | 1280x640, RGB | identical file |

## Tasks

### Task 1: Brand vector masters

Create the five SVGs in `assets/brand/` from the site sources. `app-icon.svg`
is the 256 composition copied from `site/assets/logo.svg` (same paths, same
filter and gradient defs; tidy ids are fine). `mark.svg` is the glyph alone
with the gradient and the soft-light stroke baked in as SVG, viewBox tight
to the glyph, transparent background. `mark-mono-dark.svg` is the silhouette
in `#000`. Delete nothing yet; overwrite the three existing files.

`mark-small.svg`: same silhouette with the arrow counter widened until the
small-size rule holds at 16px tall. Iterate: render at 16, 22, 25, 32 with
sharp (from `packages/server/node_modules/sharp`), upscale 8x nearest
neighbour, and look at the PNGs. Report the counter width you landed on and
show before/after in the report.

`mark-tray.svg` is Task 3; leave it out.

Verify with renders at 512 and the small sizes; the report lists the render
paths. No pipeline code in this task.

### Task 2: Render pipeline and raster outputs

The repo already has the pipeline: `scripts/gen-icons.mjs` (`pnpm gen-icons`,
root devDependencies sharp + png-to-ico + png2icons, documented in
`scripts/gen-icons.README.md`). Adapt it to the v2 masters; do not create a
new package.

Changes:
- The old raster-source route (`APP_ICON_PNG_SOURCES`, `RASTER_THRESHOLD`,
  `renderAppIconPngFromRaster`, the 22% squircle mask) goes away. The v2
  `app-icon.svg` already carries its own squircle and shadows, so every
  app-icon output renders from SVG. Sizes 16 and 32 render from
  `app-icon-small.svg`; everything larger from `app-icon.svg`. Remove the
  long comments that justified the raster route.
- Favicons 16 and 32 render from `mark-small.svg` on transparent (the
  glyph fills the box), not from the app icon.
- `apple-touch-icon.png` is the app icon composited full-bleed on the
  navy top colour `#2E3D65` to `#110222` gradient so no pixel is
  transparent (iOS paints transparent corners black).
- `icon-maskable-512.png`: navy gradient full-bleed, mark at 60% of the
  canvas height, centred. Drop `MASKABLE_BG`.
- `logo-mark.svg` in `packages/web/public/icons/` is written by the
  pipeline as a copy of the master the size table names.
- `assets/brand/app-icon-1024.png` is written as a reference export.
- Tray outputs keep rendering from `mark-mono-dark.svg` and `mark.svg`
  for now; Task 3 swaps their masters. Social previews are not part of
  this script.
- Keep the output table at the end; add the measured width x height of
  every PNG to it (read back with sharp metadata).
- Determinism: running twice yields byte-identical files. Check it.

Update `scripts/gen-icons.README.md` to describe the v2 sources and
routing (replace the raster-route paragraphs). Run `pnpm gen-icons` and
commit the script, the README and every regenerated file. Verify each
output against the size table with `magick identify` and list any
mismatch as a concern.

### Task 3: macOS menu-bar icon and the tray set

Design `assets/brand/mark-tray.svg`: a mono silhouette of the mark for the
macOS menu bar at 22px (16pt) and its @2x. Constraints: alpha-only, pure
black; the arrow reads at 1x; stroke weight sits with the system's own
menu-bar glyphs (about 1.5px at 1x). Start from `mark-small.svg` and adjust.

Iterate visually. Build a mock menu bar (light and dark, 1x and 2x) with
the template tinted the way macOS does it (black at ~85% on light, white
at ~85% on dark), composite the candidate next to two or three real system
glyph stand-ins of the same weight, and look at the result upscaled. Keep
going until the arrow is unambiguous at 1x.

Then point `scripts/gen-icons.mjs` at the new masters:
`tray-iconTemplate.png` and `@2x` from `mark-tray.svg`, `tray-icon.png` and
`tray-icon.ico` from `mark-small.svg`; update the README's source table;
run `pnpm gen-icons`. Pixel-check the templates:
every pixel with alpha > 0 has `r=g=b=0`.

If a real check is possible, run the desktop app in dev
(`packages/desktop`, `pnpm dev`) and capture the menu bar with
`screencapture`. If macOS blocks the capture, say so and rely on the mock.

### Task 4: Social previews

One 1280x640 composition for both `assets/social-preview.png` and
`site/social-preview.png` (identical bytes). Ground: the navy gradient
from the app icon. Content: the mark at a generous size, the word
"Backspace" set in Fabio XM (`site/assets/fabio-xm-variable.ttf`), and the
site's tagline "Group chat that lives on your own hardware." in DM Sans.
Nothing else; no screenshots, no badges.

Source lives at `scripts/social-preview.html`, rendered by a new
`scripts/gen-social-preview.mjs` (`pnpm gen-social-preview` in the root
package.json, next to `gen-icons`) with headless Chrome (`/Applications/Google Chrome.app/Contents/MacOS/Google
Chrome`, overridable via `CHROME` env) at exactly 1280x640, device scale 1,
and skips with a clear message when Chrome is absent. Look at the render
before committing it.

### Task 5: Colour tokens, literals and docs

Batch, one dispatch:

- `packages/web/src/styles/globals.css:72-74`: the three accent triplets.
- `packages/web/src/components/chat/MentionBadge.tsx:36`,
  `packages/web/src/main.tsx:60`: the `#7c6cf6` literals become `#0061ff`.
- `packages/desktop/resources/instance-picker.html:130,165` and
  `packages/desktop/resources/recovery.html:86`: `#7c6cf6` becomes
  `#0061ff`.
- `scripts/metrics/src/datapage.ts:229`: `--accent:#7c6cf6` becomes
  `#0061ff`.
- `packages/desktop/src/main.ts:290-315`: the fallback tray circle is
  painted `#0061ff` (BGRA order in the buffer; fix the comment).
- `docs/systems/design-system.md`: a "Brand" section after the colour
  tokens: the mark, the masters in `assets/brand/`, the size table's
  intent (which master feeds which size class), the regenerate command,
  the primary hex. Adjust line 12's principle so it says surfaces stay
  warm while the brand primary is the electric blue.
- `CLAUDE.md` design summary: update the colour line to mention the blue
  primary. Two lines at most.
- Grep the repo for any remaining `7c6cf6`/`6b5ce0` outside `site/`,
  `docs/superpowers/` and lockfiles; there must be none.

Run `pnpm --filter web typecheck` (or the repo's equivalent), the web unit
tests, and `pnpm --filter desktop build` or its tsc step.

### Task 6: Verification renders

Start the stack (`pnpm dev`, with `DATA_DIR` or the config's data path
pointed at a throwaway directory and a throwaway `JWT_SECRET`), register a
user through the API, and capture with headless Chrome at 1280x800: the
login page, the register page, the main app after login (sidebar mark, a
primary button visible), and the user settings modal. Also capture the
three site pages from the PR. Write all PNGs to the workspace directory and
list their paths in the report; the controller looks at them. Stop the
stack and delete the throwaway data directory afterwards.

Report anything that looks wrong (mark too small, colour mismatch, cut-off
glyph) as a concern; do not fix it in this task.

## Revision: flat lavender (2026-09-21, after the live review)

Jannis rejected the material and the colour on the live instance: the mark
must be flat, and the primary stays lavender. The mark's shape and Fabio XM
on the site stay. This revision supersedes the Spec's colour and material
lines; everything else in the Spec, constraints and size table still binds.

### Spec v3 (binding)

- **Primary**: `#7c6cf6`, hover `#6b5ce0`, active `#5f4fd0`; triplets
  `124 108 246`, `107 92 224`, `95 79 208`.
- **Two flat colours, no material.** The mark is a single flat fill. On
  dark grounds it is `#7c6cf6`; on a lavender tile or squircle it is
  `#ffffff`. No gradient, stroke, glow, shadow, blur or blend anywhere,
  app or site.
- **App icon**: the same 256 squircle path, filled flat `#7c6cf6`, the
  glyph inset as before filled `#ffffff`. No filters, no defs.
- **Grounds**: Aether Drift dark (`#0b0b10` base). The site's navy page
  gradient and gradient buttons go; `.btn-primary` is flat `--primary`
  with white text as before #229 v2.
- **Site mark**: flat `--primary` (a plain CSS mask fill or an inline
  SVG); the hero mock's sidebar tile is a lavender tile with a white mark,
  mirroring the app. The animated gradient, the glass edge and the
  long-press colour picker are removed.
- **Social preview**: `#0b0b10` ground, lavender mark, white wordmark in
  Fabio XM, tagline in DM Sans.

### Task 7: Flat masters, pipeline, rasters, social preview

`assets/brand/`: `mark.svg` and `mark-small.svg` become flat `#7c6cf6`
(same geometry, drop gradient and stroke). Add `mark-mono-light.svg`
(standard geometry, `#fff`). `app-icon.svg` and `app-icon-small.svg`: flat
lavender squircle, white glyph, no defs. `mark-tray.svg` and
`mark-mono-dark.svg` unchanged.

`scripts/gen-icons.mjs`: replace `navyGradientSvg` with a solid
`#7c6cf6` ground for apple-touch-icon and maskable (mark on the maskable
is `mark-mono-light.svg` at 60% height); `logo-mark.svg` is a copy of
`mark-mono-light.svg`; favicons and colour tray stay on `mark-small.svg`.
README and the design-system Brand section updated to the flat system.
`scripts/social-preview.html`: `#0b0b10` ground, mark in `#7c6cf6`, no
effects. Run both generators; verify sizes and opaque flags as before;
commit everything.

### Task 8: Site back to Aether Drift, flat mark

`site/assets/site.css` and the inline copy in `site/insights/index.html`:
`--primary` `#7c6cf6`, `--primary-hover` `#6b5ce0`; delete
`--primary-gradient`, `--primary-gradient-hover`, `--site-bg-gradient`;
body `background: var(--base)`; `.btn-primary` flat primary with `#fff`
text and the pre-#229 hover; `.range-btn[aria-pressed="true"]` flat primary
with `#fff`, its disabled state `color-mix(in srgb, var(--primary) 35%,
transparent)`. `site/assets/logo.css`: `.logo-mark` keeps the mask
approach but with a single flat `background: var(--primary)`, no `filter`,
no `::before`, no aero variables; `.strip .tile.logo` is a lavender tile
whose mark is white; delete the popover rules. Delete
`site/assets/logo-color.js`, `site/assets/logo-glyph-stroke.svg` and the
orphaned `site/assets/logo.png`; remove the script tags from the three
pages. `site/assets/logo.svg` (favicon): the glyph alone, flat `#7c6cf6`,
viewBox tight (copy of `assets/brand/mark.svg`). Fabio XM and the
headline rules stay. Render the three pages headless and look at them.

### Task 9: App, desktop and docs back to lavender

`packages/web/src/styles/globals.css:54-56` triplets; `--primary` pairs in
`packages/desktop/resources/instance-picker.html` and `recovery.html`;
`scripts/metrics/src/datapage.ts` `--accent`; `packages/desktop/src/main.ts`
tray fallback bytes (`#7c6cf6`: B=0xf6 G=0x6c R=0x7c) and comment;
`MentionBadge.tsx` and `main.tsx` literals. Docs: design-system.md line 12
back to "Calm over flashy. Warm over cool.", Brand section primary hex and
the flat rule; CLAUDE.md colours line; desktop.md fallback row; search.md
caption if it names a colour. Grep: no `0061ff`, `0052d9`, `0047bd`,
`0 97 255`, `0 82 217`, `0 71 189`, `2E3D65`, `110222` outside
`docs/superpowers/`. Typecheck web and desktop, run web tests.

### Task 10: Dimensional app icon in lavender

Jannis reviewed the flat icon sheet and asked for the contributor's
dimensional app-icon composition back, recoloured to the lavender system
("Lavender, plum ground"). Scope: the app-icon family only. The in-app
sidebar tile, favicons, all tray files and the site header mark stay flat.

Masters: `assets/brand/app-icon.svg` = the #229 composition (`git show
96df70a5:site/assets/logo.svg`) with `#0061FF` replaced by `#7c6cf6`,
`#2E3D65` by `#2a2740`, `#110222` by `#12101d`; same filters, same stroke
overlay. `assets/brand/app-icon-small.svg` = the same recolour applied to
the gradient small-glyph composition at `bd60bfeb:assets/brand/app-icon-small.svg`.
New `assets/brand/mark-icon.svg` = the gradient mark alone (from
`bd60bfeb:assets/brand/mark.svg`, recoloured), transparent, for the
maskable inner and the social card.

Pipeline: apple-touch-icon ground and the maskable ground become the
plum gradient (`#2a2740` top to `#12101d` bottom); the maskable inner is
`mark-icon.svg` at 60% height; `logo.png`, `icon-192/512`, `build/icon.*`,
`build/icons/*`, `app-icon-1024.png` follow the masters automatically.
`scripts/social-preview.html` uses `mark-icon.svg`. Favicons, `logo-mark.svg`
and tray outputs unchanged (byte-identical after regeneration). README and
the design-system Brand section: the flat rule now applies to UI surfaces
(site header, sidebar tile, favicons, trays); the app-icon family is the
dimensional composition on the plum ground.

### Task 11: App icon on Apple's icon grid

The dock icon renders larger and rounder than neighbouring macOS icons. Two
causes: the badge fills the whole canvas (Apple's template places the
icon in an 824 px square centred on a 1024 canvas, transparent margin of
100 px each side) and the contributor's squircle corner radius is about
36% of the side where Apple's rounded rectangle is 22.37%.

Masters: in `assets/brand/app-icon.svg` and `app-icon-small.svg`, replace
the badge `<path>` with a `<rect x="0" y="0" width="256" height="256"
rx="57.27" ry="57.27">` (22.37% of 256) carrying the same `badgeFill`
gradient. Mark inset, gradient, stroke overlay and filters unchanged.

Pipeline (`scripts/gen-icons.mjs`): a `macIconPng(size)` helper renders
the composition at `round(size * 824/1024)` and centres it on a
transparent `size` canvas. Use it for `build/icon.icns` (all reps) and
`build/icon.png`. Everything else (Windows `.ico`, Linux `build/icons/*`,
PWA `icon-192/512`, `logo.png`, `app-icon-1024.png`, apple-touch-icon,
maskable) stays full-bleed: those platforms apply their own framing.
README and the design-system Brand section note the margin rule.

Verify: `build/icon.png` has transparent pixels in a 50 px border at 512
(`magick ... -format '%[fx:p{2,2}.a]'` is 0) and none at the centre;
icns reps follow. Regenerate, commit, and note that packaged macOS builds
and the dev Dock icon both consume these files.
