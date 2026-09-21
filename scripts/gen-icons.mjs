#!/usr/bin/env node
/**
 * Backspace icon generator
 *
 * Reads from assets/brand/{app-icon.svg, app-icon-small.svg, mark-icon.svg,
 * mark-small.svg, mark-mono-light.svg, mark-tray.svg} and writes the
 * entire desktop + web icon set:
 *   - macOS .icns (10-rep iconset)
 *   - Windows .ico (multi-size)
 *   - Linux per-size PNGs (electron-builder dir mode)
 *   - macOS menu-bar template + @2x (18x22 / 36x44)
 *   - Windows tray .ico (multi-size, DPI-auto, glyph inset per frame)
 *   - Linux tray PNG (22x22, 18px glyph)
 *   - Web favicons, PWA, in-app brand logo, PWA maskable
 *   - assets/brand/app-icon-1024.png, a reference export of the app icon
 *
 * Run via `pnpm gen-icons` after artwork changes; commit the diff.
 *
 * FLAT VS DIMENSIONAL: the split is by surface, not by file type. UI
 * surfaces (the in-app sidebar tile, web favicons, desktop/menu-bar tray
 * icons) stay the flat two-colour mark. The app-icon family, meaning
 * everywhere an OS shows this app as a single launchable icon (dock,
 * taskbar, Start menu, Alt-Tab, PWA install, iOS home screen), is the
 * contributor's original dimensional composition recoloured to the
 * lavender system: a badge (a rounded rectangle at Apple's own 22.37%
 * template corner radius) on a `#2a2740`-to-`#12101d` plum gradient,
 * drop shadow, inner shadow and a soft-light stroke overlay, with the
 * glyph itself a white-to-`#7c6cf6` gradient. See
 * `docs/systems/design-system.md`'s Brand section for the full rule.
 *
 * APP-ICON RENDERING: every app-icon output renders straight from vector.
 * `app-icon.svg` already carries its own badge, drop shadow and
 * inner shadow, so there is no raster source and no post-render masking —
 * sharp/librsvg renders the SVG at the target size and that's the pixel
 * output. Sizes 16 and 32 render from `app-icon-small.svg` instead: at
 * that size the standard mark's inset strokes and shadow read as noise,
 * so the small variant carries a bolder, simplified mark inside the same
 * badge geometry. See APP_ICON_SMALL_MAX.
 *
 * DETERMINISM: byte-stable for a given lockfile only. After bumping
 * sharp / png-to-ico / png2icons, expect a follow-up regen+commit in
 * the dep-bump PR — that diff isn't an artwork change, just upstream
 * encoder differences.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import png2icons from 'png2icons';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SRC = {
  appIcon:       join(ROOT, 'assets/brand/app-icon.svg'),
  appIconSmall:  join(ROOT, 'assets/brand/app-icon-small.svg'),
  markIcon:      join(ROOT, 'assets/brand/mark-icon.svg'),
  markSmall:     join(ROOT, 'assets/brand/mark-small.svg'),
  markMonoLight: join(ROOT, 'assets/brand/mark-mono-light.svg'),
  markTray:      join(ROOT, 'assets/brand/mark-tray.svg'),
};

const DESKTOP_BUILD = join(ROOT, 'packages/desktop/build');
const DESKTOP_RES   = join(ROOT, 'packages/desktop/resources');
const WEB_ICONS      = join(ROOT, 'packages/web/public/icons');
const BRAND          = join(ROOT, 'assets/brand');

// app-icon.svg's badge ground: a vertical gradient from plum to
// near-black, matching the badge's own `paint0_linear` gradient exactly.
// Reused here as an opaque background for outputs that must carry zero
// transparent pixels: the apple-touch-icon (iOS paints transparent
// corners black) and the maskable PWA icon (Android launcher masks crop
// past the mark's own bounding box, so anything outside it must already
// look like the badge). Kept as hex constants rather than re-parsing
// app-icon.svg's gradient stops: the two files sharing these literal
// values is the intended coupling; if the badge gradient ever changes,
// both need editing together regardless.
const PLUM_GRADIENT_TOP = '#2a2740';
const PLUM_GRADIENT_BOTTOM = '#12101d';

// SVG render density. app-icon(-small).svg's viewBox is 256; mark(-small)
// is 133x180. At density 1200, the 256 box pre-renders to ~3200px and the
// 180-tall box to ~2250px — comfortably above every target here (largest
// is the 1024 reference export), so every output is a downscale. Sharp/
// libvips downscales with Lanczos, so over-rendering then resizing is
// fine and keeps output stable across all target sizes.
const SVG_DENSITY = 1200;

// App-icon outputs at this size or smaller render from app-icon-small.svg
// instead of app-icon.svg. Per the brand spec, 16 and 32 are the only
// sizes affected; the small variant's inset mark falls under the 1.5px
// small-size legibility rule at those two sizes, which is accepted rather
// than enlarging the inset (would require a different badge composition).
const APP_ICON_SMALL_MAX = 32;

// ---- helpers ----

const loadSvg = (path) => readFileSync(path);

async function renderPng(svg, size) {
  // Render SVG → square PNG at exact target size. fit: 'contain' preserves
  // aspect ratio: wide-bbox SVGs (mark, mark-small) get transparent
  // top/bottom or left/right padding instead of being stretched square.
  return sharp(svg, { density: SVG_DENSITY })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function renderTemplatePng(svg, height) {
  // Render a non-square SVG at an exact pixel height, width following the
  // SVG's own aspect ratio. mark-tray.svg carries its own 18x22 canvas
  // with the glyph already inset and centred, so nothing is fitted here.
  return sharp(svg, { density: SVG_DENSITY })
    .resize({ height })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

// Alpha centroid of a rendered RGBA buffer, in pixel-centre coordinates
// (a fully symmetric glyph centred on a W-wide canvas measures W / 2).
async function alphaCentroidX(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  let weight = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const a = data[i + 3];
    sum += a * ((p % info.width) + 0.5);
    weight += a;
  }
  return weight === 0 ? info.width / 2 : sum / weight;
}

function parseMarkSvg(markSvg) {
  // Splits a mark master into its root viewBox and inner markup so the
  // glyph can be re-hosted inside another canvas at any size/position.
  const text = markSvg.toString('utf8');
  const open = text.match(/<svg\b[^>]*>/);
  const viewBox = open && open[0].match(/viewBox="([^"]+)"/);
  if (!open || !viewBox) throw new Error('parseMarkSvg: source SVG has no root <svg viewBox>');
  const [, , vbW, vbH] = viewBox[1].trim().split(/[\s,]+/).map(Number);
  const inner = text.slice(open.index + open[0].length, text.lastIndexOf('</svg>'));
  return { viewBox: viewBox[1], aspect: vbW / vbH, inner };
}

// Wraps a parsed mark in a canvas of canvasW x canvasH px with the glyph
// scaled to glyphH px tall and its top-left corner at (x, y), fractional
// positions allowed: the placement is baked into the vector before
// rasterising, so a sub-pixel correction renders as true coverage instead
// of a whole-pixel composite offset.
function placeMarkSvg(mark, canvasW, canvasH, glyphH, x, y) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasW}" height="${canvasH}">` +
      `<svg x="${x}" y="${y}" width="${glyphH * mark.aspect}" height="${glyphH}" viewBox="${mark.viewBox}">${mark.inner}</svg>` +
      `</svg>`,
  );
}

async function renderTrayGlyphPng(markSvg, canvasW, canvasH, glyphH) {
  // Colour tray glyph on a transparent canvas: glyphH px tall, centred
  // vertically by bounding box and horizontally by alpha centroid. The
  // mark's straight left edge and open right side put its centroid left
  // of its box centre, so a box-centred render reads left-heavy; the
  // first pass measures that offset and the second pass bakes the
  // correction into the vector placement.
  const mark = parseMarkSvg(markSvg);
  const render = (x, y) =>
    sharp(placeMarkSvg(mark, canvasW, canvasH, glyphH, x, y), { density: SVG_DENSITY })
      .resize(canvasW, canvasH)
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
  const x0 = (canvasW - glyphH * mark.aspect) / 2;
  const y0 = (canvasH - glyphH) / 2;
  const probe = await render(x0, y0);
  const shift = canvasW / 2 - (await alphaCentroidX(probe));
  const png = await render(x0 + shift, y0);
  const centroid = await alphaCentroidX(png);
  return { png, measured: `${canvasW}x${canvasH} glyph ${glyphH}h, centroid x ${centroid.toFixed(2)} (shift ${shift >= 0 ? '+' : ''}${shift.toFixed(2)})` };
}

// Tray frame sizes for Windows: total vertical margin floor(size / 8), so
// the glyph is 14, 18, 21, 28, 35, 42 tall in the 16..48 frames (Windows
// 11 draws its own tray glyphs about 14px inside the 16px cell).
const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48];
const trayGlyphHeight = (size) => size - Math.floor(size / 8);

function plumGradientSvg(size) {
  // Full-bleed vertical gradient rect, no rounding: the badge shape
  // itself provides the rounding when composited on top; this is only
  // the fill that shows through the badge's transparent corners (or,
  // for the maskable icon, the whole canvas outside the mark).
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
      `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="${size}" gradientUnits="userSpaceOnUse">` +
      `<stop stop-color="${PLUM_GRADIENT_TOP}"/><stop offset="1" stop-color="${PLUM_GRADIENT_BOTTOM}"/>` +
      `</linearGradient></defs><rect width="${size}" height="${size}" fill="url(#g)"/></svg>`,
  );
}

async function renderAppIconPng(icons, size) {
  if (size <= APP_ICON_SMALL_MAX) return renderPng(icons.appIconSmall, size);
  if (size === 1024) {
    // Reuse the once-rendered 1024 buffer computed in main() instead of
    // re-invoking sharp — same deterministic bytes, one fewer rasterize.
    return icons.appIcon1024;
  }
  return renderPng(icons.appIcon, size);
}

async function writePng(path, svg, size) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await renderPng(svg, size);
  writeFileSync(path, buf);
}

async function writeTemplatePng(path, svg, height) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await renderTemplatePng(svg, height);
  writeFileSync(path, buf);
}

async function writeTrayPng(path, markSvg, canvasW, canvasH, glyphH) {
  mkdirSync(dirname(path), { recursive: true });
  const { png, measured } = await renderTrayGlyphPng(markSvg, canvasW, canvasH, glyphH);
  writeFileSync(path, png);
  return measured;
}

async function writeTrayIco(path, markSvg, sizes) {
  mkdirSync(dirname(path), { recursive: true });
  const frames = await Promise.all(sizes.map((s) => renderTrayGlyphPng(markSvg, s, s, trayGlyphHeight(s))));
  const ico = await pngToIco(frames.map((f) => f.png));
  writeFileSync(path, ico);
  return `${sizes.length} frames: ${frames.map((f) => f.measured).join('; ')}`;
}

async function writeAppIconPng(path, icons, size) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await renderAppIconPng(icons, size);
  writeFileSync(path, buf);
}

// Apple's icon-grid template places the visible artwork in an 824px
// square centred on a 1024 canvas (a 100px transparent margin each
// side) — every other OS frames its own icon (Windows applies its own
// padding in Explorer/taskbar, Linux desktop environments crop or pad
// per-DE, Android masks the maskable icon itself), so this margin is
// specific to the two macOS consumers: the .icns and the dev/dock
// `build/icon.png`. Renders the same badge composition as every other
// app-icon output (routed through renderAppIconPng, so 16/32 would still
// take the small variant, though neither macOS output ever requests
// those sizes) at the scaled-down inner size, then centres it on a
// transparent canvas of the requested size.
async function macIconPng(icons, size) {
  const innerSize = Math.round(size * (824 / 1024));
  const inner = await renderAppIconPng(icons, innerSize);
  const offset = Math.round((size - innerSize) / 2);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: inner, left: offset, top: offset }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function writeMacIconPng(path, icons, size) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await macIconPng(icons, size);
  writeFileSync(path, buf);
}

// Measures an already-rendered PNG buffer via sharp metadata — used to
// report .ico frame dimensions, since sharp can't read an .ico container
// back but the frame buffers are already in hand before packing.
async function dimsOfBuffer(buf) {
  const meta = await sharp(buf).metadata();
  return `${meta.width}x${meta.height}`;
}

async function writeAppIconIco(path, icons, sizes) {
  // Every pixel size routes through renderAppIconPng, so the whole .ico —
  // taskbar/Properties small reps through the Alt+Tab / explorer large
  // reps — shares the same vector rendering rule (small ↔ app-icon-small).
  // Windows auto-picks the closest size for the active DPI.
  mkdirSync(dirname(path), { recursive: true });
  const buffers = await Promise.all(sizes.map((s) => renderAppIconPng(icons, s)));
  const ico = await pngToIco(buffers);
  writeFileSync(path, ico);
  const dims = await Promise.all(buffers.map(dimsOfBuffer));
  return `${sizes.length} frames: ${dims.join(', ')}`;
}

async function writeAppIconIcns(path, macIcon1024) {
  // png2icons.createICNS takes a single high-res PNG and synthesises the
  // full 10-rep iconset internally (16/16@2x, 32/32@2x, 128/128@2x,
  // 256/256@2x, 512/512@2x) by downscaling it. Feed it the margined 1024
  // render (see macIconPng) so every synthesised rep inherits the same
  // Apple-grid margin proportionally — there's no per-rep hook into
  // png2icons to apply the margin after the fact.
  mkdirSync(dirname(path), { recursive: true });
  const icns = png2icons.createICNS(macIcon1024, png2icons.BICUBIC, 0);
  if (!icns) throw new Error(`png2icons.createICNS returned null for ${path}`);
  writeFileSync(path, icns);
  // png2icons hands back only the container bytes, no per-rep metadata —
  // report the one thing we can measure honestly: the source buffer it
  // was built from.
  const srcDims = await dimsOfBuffer(macIcon1024);
  return `${srcDims} source, container not decoded`;
}

async function writeAppleTouchIcon(path, icons, size) {
  // Composite the app icon over a full-bleed copy of its own badge
  // gradient. The badge's rounded corners are transparent in the SVG
  // render; painting the identical gradient underneath means those
  // corners read as continuous badge, not a hard-edged cutout, while the
  // final PNG carries no transparent pixel (iOS paints transparent
  // corners black, which would look like a defect here).
  const bg = plumGradientSvg(size);
  const icon = await renderAppIconPng(icons, size);
  mkdirSync(dirname(path), { recursive: true });
  const composed = await sharp(bg)
    .composite([{ input: icon }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  writeFileSync(path, composed);
}

async function writeMaskableIcon(path, markSvg, canvas, heightScale) {
  // PWA maskable icon: the badge's plum gradient fills the full canvas
  // (Android launcher masks, such as circle, squircle or rounded-square,
  // crop arbitrarily past the icon's own bounding box, so the ground must
  // extend to every edge), with the gradient mark centred at
  // heightScale × canvas height. Scaling by height (not by fitting a
  // square) keeps the mark's proportions identical to every other
  // rendering of it. `markSvg` is mark-icon.svg, the same white-to-
  // lavender gradient glyph as the app icon's own badge, transparent
  // outside the glyph itself so the plum ground shows through.
  const innerHeight = Math.round(canvas * heightScale);
  const inner = await sharp(markSvg, { density: SVG_DENSITY })
    .resize({ height: innerHeight })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  const bg = plumGradientSvg(canvas);
  mkdirSync(dirname(path), { recursive: true });
  const composed = await sharp(bg)
    .composite([{ input: inner, gravity: 'center' }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  writeFileSync(path, composed);
}

// ---- main ----

async function main() {
  // Spec: refuse to run if any source SVG is missing — fail loudly, not on
  // a downstream sharp error with a cryptic ENOENT.
  for (const [, path] of Object.entries(SRC)) {
    if (!existsSync(path)) {
      throw new Error(`Missing source SVG: ${relative(ROOT, path)} — see assets/brand/`);
    }
  }

  const appIcon       = loadSvg(SRC.appIcon);
  const appIconSmall  = loadSvg(SRC.appIconSmall);
  const markIcon      = loadSvg(SRC.markIcon);
  const markSmall     = loadSvg(SRC.markSmall);
  const markMonoLight = loadSvg(SRC.markMonoLight);
  const markTray      = loadSvg(SRC.markTray);

  // Rendered once at the top of the pipeline: it's both the .icns
  // synthesis input and the standalone reference export, and every
  // app-icon output ≥1024 (there's only the one) routes through it.
  const appIcon1024 = await renderPng(appIcon, 1024);

  const icons = { appIcon, appIconSmall, appIcon1024 };

  const written = [];
  // Records a row for the summary table. `info` is the routing decision
  // (which source, which rule) decided before rendering. `measured` is a
  // read-back of the actual written file — for a PNG that's always sharp's
  // own metadata on the bytes on disk, never the size we asked it to
  // render, so a resize bug or a corrupt write shows up here instead of
  // being hidden behind a label that only reflects intent. .ico/.icns
  // can't be read back by sharp as a container, so their writers hand back
  // a measured string built from the frame buffers (or source buffer)
  // they already held before packing — passed in as `measuredOverride`.
  async function trace(label, path, info, measuredOverride) {
    let measured = measuredOverride;
    if (measured === undefined) {
      if (path.endsWith('.png')) {
        const meta = await sharp(path).metadata();
        measured = `${meta.width}x${meta.height} ${meta.channels}ch${meta.hasAlpha ? '+a' : ''}`;
      } else if (path.endsWith('.svg')) {
        measured = 'vector';
      } else {
        measured = 'n/a';
      }
    }
    written.push({
      label,
      info,
      measured,
      bytes: statSync(path).size,
      path: relative(ROOT, path),
    });
  }

  // --- Brand: reference export ---
  mkdirSync(BRAND, { recursive: true });
  writeFileSync(join(BRAND, 'app-icon-1024.png'), appIcon1024);
  await trace('brand-1024', join(BRAND, 'app-icon-1024.png'), '1024x1024 (reference)');

  // --- Desktop: application icon ---
  const linuxSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  for (const s of linuxSizes) {
    const out = join(DESKTOP_BUILD, `icons/${s}x${s}.png`);
    await writeAppIconPng(out, icons, s);
    await trace('linux-png', out, `${s}x${s} (${s <= APP_ICON_SMALL_MAX ? 'small' : 'app-icon'})`);
  }

  // macOS dev/dock icon and packaged .icns: both apply Apple's icon-grid
  // margin (824/1024 artwork centred on the canvas) — see macIconPng.
  // Every other output below stays full-bleed.
  await writeMacIconPng(join(DESKTOP_BUILD, 'icon.png'), icons, 512);
  await trace('build-icon', join(DESKTOP_BUILD, 'icon.png'), '512x512 (Apple grid margin)');

  const macIcon1024 = await macIconPng(icons, 1024);
  const icnsMeasured = await writeAppIconIcns(join(DESKTOP_BUILD, 'icon.icns'), macIcon1024);
  await trace('mac-icns', join(DESKTOP_BUILD, 'icon.icns'), '10-rep iconset (Apple grid margin)', icnsMeasured);

  const winIcoMeasured = await writeAppIconIco(
    join(DESKTOP_BUILD, 'icon.ico'),
    icons,
    [16, 24, 32, 48, 64, 128, 256],
  );
  await trace('win-ico', join(DESKTOP_BUILD, 'icon.ico'), '7 sizes', winIcoMeasured);

  // --- Desktop: tray ---
  // macOS menu bar: mark-tray.svg is a silhouette tuned for the menu bar
  // (16px body on an 18x22 canvas, 2.8px arrow channel, centred by alpha
  // centroid), so it renders 1:1 here with no further fitting. The canvas
  // is 18 wide, not 22: the status item pads the image itself, and a 22px
  // box around a 12px glyph left a wider gap than the system icons keep.
  // main.ts marks the PNG as a template image and macOS tints the alpha;
  // the file must stay pure black. Electron resolves the @2x by suffix.
  await writeTemplatePng(join(DESKTOP_RES, 'tray-iconTemplate.png'), markTray, 22);
  await trace('tray-mac-1x', join(DESKTOP_RES, 'tray-iconTemplate.png'), '18x22 (mark-tray)');

  await writeTemplatePng(join(DESKTOP_RES, 'tray-iconTemplate@2x.png'), markTray, 44);
  await trace('tray-mac-2x', join(DESKTOP_RES, 'tray-iconTemplate@2x.png'), '36x44 (mark-tray)');

  // Windows and Linux trays render in colour from the bold small-size
  // variant, inset in their cell the way each platform's own tray glyphs
  // are (Windows 11: about 14px in the 16px cell; Ubuntu/KDE indicators:
  // about 18px in 22) and centred by alpha centroid, see
  // renderTrayGlyphPng. The .ico's 16 and 20px frames fall under the
  // 1.5px small-size rule with the standard mark (its channel is ~1.2px
  // at 16), and the whole tray set takes the same source so every frame
  // is the same glyph. The app icons are a different family and stay
  // full-bleed; this inset applies to the tray only.
  const trayIcoMeasured = await writeTrayIco(join(DESKTOP_RES, 'tray-icon.ico'), markSmall, TRAY_ICO_SIZES);
  await trace('tray-win-ico', join(DESKTOP_RES, 'tray-icon.ico'), '6 sizes (mark-small, inset)', trayIcoMeasured);

  const trayPngMeasured = await writeTrayPng(join(DESKTOP_RES, 'tray-icon.png'), markSmall, 22, 22, 18);
  await trace('tray-linux', join(DESKTOP_RES, 'tray-icon.png'), '22x22 (mark-small, 18px glyph)', trayPngMeasured);

  // --- Web: favicons + PWA + in-app ---
  // Favicons render from mark-small.svg on transparent, not the app-icon
  // badge: at 16/32 the badge's shadow and stroke overlay add nothing but
  // noise, and a bare glyph filling the box reads better in a browser tab.
  await writePng(join(WEB_ICONS, 'favicon-16.png'), markSmall, 16);
  await trace('favicon-16', join(WEB_ICONS, 'favicon-16.png'), '16 (mark-small)');

  await writePng(join(WEB_ICONS, 'favicon-32.png'), markSmall, 32);
  await trace('favicon-32', join(WEB_ICONS, 'favicon-32.png'), '32 (mark-small)');

  await writeAppleTouchIcon(join(WEB_ICONS, 'apple-touch-icon.png'), icons, 180);
  await trace('apple-touch', join(WEB_ICONS, 'apple-touch-icon.png'), '180 (app-icon, opaque)');

  await writeAppIconPng(join(WEB_ICONS, 'icon-192.png'), icons, 192);
  await trace('pwa-192', join(WEB_ICONS, 'icon-192.png'), '192 (app-icon)');

  await writeAppIconPng(join(WEB_ICONS, 'icon-512.png'), icons, 512);
  await trace('pwa-512', join(WEB_ICONS, 'icon-512.png'), '512 (app-icon)');

  await writeMaskableIcon(join(WEB_ICONS, 'icon-maskable-512.png'), markIcon, 512, 0.6);
  await trace('pwa-maskable', join(WEB_ICONS, 'icon-maskable-512.png'), '512 (plum ground, 60% gradient mark)');

  // In-app logo for the SpaceSidebar home tile: same app-icon render as
  // every other ≥128px consumer (dock, launcher, homescreen), just sized
  // for the sidebar slot. The badge's own rounded corners and flat
  // lavender fill read cleanly against the sidebar's `#1a1a23` surface
  // without any extra masking here.
  await writeAppIconPng(join(WEB_ICONS, 'logo.png'), icons, 256);
  await trace('in-app-logo', join(WEB_ICONS, 'logo.png'), '256 (app-icon, sidebar tile)');

  // logo-mark.svg is a byte copy of mark-mono-light.svg: the SpaceSidebar
  // home tile renders it on the same lavender tile as the app icon's own
  // badge, so the mark needs the white mono fill, not the flat-lavender
  // mark.svg fill. Task 1 measured the arrow channel at a 25px sidebar
  // render as ~1.95 device px, clearing the 1.5px small-size legibility
  // rule, so no bolder variant is needed here.
  copyFileSync(SRC.markMonoLight, join(WEB_ICONS, 'logo-mark.svg'));
  await trace('logo-mark-svg', join(WEB_ICONS, 'logo-mark.svg'), 'copy of mark-mono-light.svg');

  // --- Summary ---
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };
  console.log('\nGenerated icons:');
  console.log(
    '  ' + 'kind'.padEnd(14) + 'info'.padEnd(32) + 'measured'.padEnd(34) + 'size'.padStart(10) + '  path',
  );
  console.log(
    '  ' + '----'.padEnd(14) + '----'.padEnd(32) + '--------'.padEnd(34) + '----'.padStart(10) + '  ----',
  );
  for (const r of written) {
    console.log(
      '  ' +
        r.label.padEnd(14) +
        r.info.padEnd(32) +
        r.measured.padEnd(34) +
        fmtBytes(r.bytes).padStart(10) +
        '  ' +
        r.path,
    );
  }
  const totalBytes = written.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`\n${written.length} files written, ${fmtBytes(totalBytes)} total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
