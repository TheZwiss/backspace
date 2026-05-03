#!/usr/bin/env node
/**
 * Backspace icon generator
 *
 * Reads from assets/brand/{app-icon.svg, app-icon-x{1,2,3}.png, mark.svg,
 * mark-mono-dark.svg} and writes the entire desktop + web icon set:
 *   - macOS .icns (10-rep iconset)
 *   - Windows .ico (multi-size)
 *   - Linux per-size PNGs (electron-builder dir mode)
 *   - macOS menu-bar template + @2x
 *   - Windows tray .ico (multi-size, DPI-auto)
 *   - Linux tray PNG (22x22)
 *   - Web favicons, PWA, in-app brand logo, PWA maskable
 *
 * Run via `pnpm gen-icons` after artwork changes; commit the diff.
 *
 * APP-ICON HYBRID RENDERING: app-icon outputs ≥128 px source from the 3D
 * raster PNGs (x1=149 / x2=294 / x3=440), routed by closest-fit (smallest
 * source ≥ target) to minimise resampling, then masked to a rounded-square
 * silhouette (22 %·side ≈ Apple's macOS template radius). Outputs <128 px
 * source from app-icon.svg — flat geometry stays crisp at favicon sizes
 * where the 3D detail wouldn't read anyway. Tray icons and the PWA
 * maskable inner remain SVG-only.
 *
 * DETERMINISM: byte-stable for a given lockfile only. After bumping
 * sharp / png-to-ico / png2icons, expect a follow-up regen+commit in
 * the dep-bump PR — that diff isn't an artwork change, just upstream
 * encoder differences. See spec
 * docs/superpowers/specs/2026-04-27-icon-system-design.md.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import png2icons from 'png2icons';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const SRC = {
  appIcon:        join(ROOT, 'assets/brand/app-icon.svg'),
  appIconPngX1:   join(ROOT, 'assets/brand/app-icon-x1.png'),
  appIconPngX2:   join(ROOT, 'assets/brand/app-icon-x2.png'),
  appIconPngX3:   join(ROOT, 'assets/brand/app-icon-x3.png'),
  appIconPng1024: join(ROOT, 'assets/brand/app-icon-1024.png'),
  mark:           join(ROOT, 'assets/brand/mark.svg'),
  markMonoDark:   join(ROOT, 'assets/brand/mark-mono-dark.svg'),
};

const DESKTOP_BUILD = join(ROOT, 'packages/desktop/build');
const DESKTOP_RES   = join(ROOT, 'packages/desktop/resources');
const WEB_ICONS     = join(ROOT, 'packages/web/public/icons');

// Hex extracted from app-icon.svg's cls-1 fill (the badge background).
// Used as the maskable PWA background so regular and maskable variants
// read as the same brand on Android home screens.
const MASKABLE_BG = '#1d1d1b';

// SVG render density. High enough to produce a clean intermediate for
// the largest target (1024) from the smallest viewBox source (~100px).
// Sharp/libvips downscales with Lanczos, so over-rendering then resizing
// is fine and keeps output stable across all target sizes.
const SVG_DENSITY = 1200;

// Sizes at or above this threshold render from the 3D raster PNG sources;
// smaller targets render from app-icon.svg. 128 picked because:
//   - dock / launcher / homescreen / PWA tile thumbnails are all ≥128 px,
//     where the 3D-rendered design intent reads;
//   - <128 (favicons, small Linux launcher slots, small .ico subset) reads
//     better from flat SVG — crisp pixel grid alignment, and the 3D detail
//     wouldn't be visible at that size regardless.
const RASTER_THRESHOLD = 128;

// Rounded-square corner radius as a fraction of the side length. 0.22
// matches the existing app-icon.svg geometry (rx=32.42 on a 147.46 viewBox
// = 21.99 %) and sits within Apple's macOS app-icon template ratio
// (~22.37 % on the 824×824 grid) — both produce visually identical
// rounding at typical icon sizes.
const SQUIRCLE_RADIUS_RATIO = 0.22;

// Multi-resolution PNG sources for the 3D-rendered app icon. The x1/x2/x3
// variants are the user-supplied @1x/@2x/@3x exports of the same render;
// the 1024 variant is the full-resolution master. Each is independently
// sampled at its native DPI rather than downscaled from a single master.
// We pick the smallest source whose native dimension is ≥ the target
// output size: minimises resampling distance (closer source resolution
// → cleaner result), and the 1024 variant ensures every target ≤1024
// is a downscale (no upscale anywhere, including the 1024 Linux output
// and the .icns synthesis input).
const APP_ICON_PNG_SOURCES = [
  { key: 'appIconPngX1',   size: 149 },
  { key: 'appIconPngX2',   size: 294 },
  { key: 'appIconPngX3',   size: 440 },
  { key: 'appIconPng1024', size: 1024 },
];

// ---- helpers ----

const loadSvg = (path) => readFileSync(path);
const loadPng = (path) => readFileSync(path);

async function renderPng(svg, size) {
  // Render SVG → square PNG at exact target size. fit: 'contain' preserves
  // aspect ratio: wide-bbox SVGs (mark, mark-mono-dark) get transparent
  // top/bottom padding instead of being stretched square.
  return sharp(svg, { density: SVG_DENSITY })
    .resize(size, size, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

function pickAppIconPngSource(sources, target) {
  // Smallest source ≥ target; if every source is smaller, use the largest.
  for (const s of APP_ICON_PNG_SOURCES) {
    if (s.size >= target) return sources[s.key];
  }
  return sources[APP_ICON_PNG_SOURCES[APP_ICON_PNG_SOURCES.length - 1].key];
}

async function renderAppIconPngFromRaster(sources, size) {
  const raster = pickAppIconPngSource(sources, size);
  // fit: 'cover' is safe — every PNG source is square, so cover/contain
  // produce identical pixels but cover avoids gratuitous transparent
  // padding logic if a future variant ships non-square.
  // kernel: lanczos3 is sharp's standard high-quality resampler for both
  // up- and down-scaling; chosen explicitly for byte-stable determinism
  // across sharp versions that change the default kernel.
  const resized = await sharp(raster)
    .resize(size, size, { fit: 'cover', kernel: sharp.kernel.lanczos3 })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  // Squircle mask: clip corners to transparent so launchers / docks /
  // homescreens that render the icon as-is produce the rounded silhouette
  // they expect, instead of a hard-edged square. Apple's macOS template
  // ratio is ~22.37 %; we use 22 % to match the geometry of the existing
  // app-icon.svg (rx=32.42/147.46 ≈ 21.99 %).
  const r = Math.round(size * SQUIRCLE_RADIUS_RATIO);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><rect x="0" y="0" width="${size}" height="${size}" rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  );
  return sharp(resized)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

async function renderAppIcon(sources, size) {
  // Hybrid: raster ≥ threshold, vector below it. See RASTER_THRESHOLD.
  if (size >= RASTER_THRESHOLD) {
    return renderAppIconPngFromRaster(sources, size);
  }
  return renderPng(sources.appIcon, size);
}

async function writePng(path, svg, size) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await renderPng(svg, size);
  writeFileSync(path, buf);
}

async function writeAppIconPng(path, sources, size) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await renderAppIcon(sources, size);
  writeFileSync(path, buf);
}

async function writeIco(path, svg, sizes) {
  mkdirSync(dirname(path), { recursive: true });
  const buffers = await Promise.all(sizes.map((s) => renderPng(svg, s)));
  const ico = await pngToIco(buffers);
  writeFileSync(path, ico);
}

async function writeAppIconIco(path, sources, sizes) {
  // Mixed-source .ico: each pixel size routes through renderAppIcon, so
  // 16/24/32/48/64 come from the SVG and 128/256 from the raster — Windows
  // auto-picks the closest size for the active DPI, getting flat-crisp
  // small variants for taskbar/Properties and the designed render at the
  // larger sizes that Alt+Tab and explorer thumbnails use.
  mkdirSync(dirname(path), { recursive: true });
  const buffers = await Promise.all(sizes.map((s) => renderAppIcon(sources, s)));
  const ico = await pngToIco(buffers);
  writeFileSync(path, ico);
}

async function writeAppIconIcns(path, sources) {
  // png2icons.createICNS takes a single high-res PNG and synthesises the
  // full 10-rep iconset internally (16/16@2x, 32/32@2x, 128/128@2x,
  // 256/256@2x, 512/512@2x). We feed it the 1024 raster output (designed
  // 3D render, squircle-masked) and accept that the synthesised 16/32 reps
  // are downsampled from raster rather than re-rendered from SVG. macOS
  // surfaces .icns reps mostly at ≥128 (Dock, Mission Control, Launchpad)
  // — the only place the small-rep softness shows is Finder column view,
  // a worthwhile trade for a single-file .icns build that matches every
  // other app-icon consumer's design intent.
  mkdirSync(dirname(path), { recursive: true });
  const src = await renderAppIcon(sources, 1024);
  const icns = png2icons.createICNS(src, png2icons.BICUBIC, 0);
  if (!icns) throw new Error(`png2icons.createICNS returned null for ${path}`);
  writeFileSync(path, icns);
}

async function writeCenteredMarkPng(path, markSvg, canvas, scale, bgHex) {
  // Compose: square canvas + bare mark centred at scale × canvas.
  //   bgHex = hex string → opaque background (PWA maskable: survives
  //                       Android launcher masks like Samsung One UI's
  //                       full circle, Pixel's squircle).
  //   bgHex = null/undefined → transparent canvas (in-app slots whose
  //                            container provides the visual frame, e.g.
  //                            SpaceSidebar's 40×40 squircle tile).
  const innerSize = Math.round(canvas * scale);
  const inner = await sharp(markSvg, { density: SVG_DENSITY })
    .resize(innerSize, innerSize, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
  mkdirSync(dirname(path), { recursive: true });
  const composed = await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 4,
      background: bgHex ?? { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
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
      throw new Error(
        `Missing source SVG: ${relative(ROOT, path)} — copy from Artworks-Backspace/SVG/`,
      );
    }
  }

  const appIcon      = loadSvg(SRC.appIcon);
  const mark         = loadSvg(SRC.mark);
  const markMonoDark = loadSvg(SRC.markMonoDark);

  const appIconSources = {
    appIcon,
    appIconPngX1:   loadPng(SRC.appIconPngX1),
    appIconPngX2:   loadPng(SRC.appIconPngX2),
    appIconPngX3:   loadPng(SRC.appIconPngX3),
    appIconPng1024: loadPng(SRC.appIconPng1024),
  };

  const written = [];
  const trace = (label, path, info) =>
    written.push({
      label,
      info,
      bytes: statSync(path).size,
      path: relative(ROOT, path),
    });

  // --- Desktop: application icon ---
  const linuxSizes = [16, 32, 48, 64, 128, 256, 512, 1024];
  for (const s of linuxSizes) {
    const out = join(DESKTOP_BUILD, `icons/${s}x${s}.png`);
    await writeAppIconPng(out, appIconSources, s);
    trace('linux-png', out, `${s}x${s} (${s >= RASTER_THRESHOLD ? 'raster' : 'svg'})`);
  }

  await writeAppIconPng(join(DESKTOP_BUILD, 'icon.png'), appIconSources, 512);
  trace('build-icon', join(DESKTOP_BUILD, 'icon.png'), '512x512 (raster)');

  await writeAppIconIcns(join(DESKTOP_BUILD, 'icon.icns'), appIconSources);
  trace('mac-icns', join(DESKTOP_BUILD, 'icon.icns'), '10-rep iconset (raster)');

  await writeAppIconIco(
    join(DESKTOP_BUILD, 'icon.ico'),
    appIconSources,
    [16, 24, 32, 48, 64, 128, 256],
  );
  trace('win-ico', join(DESKTOP_BUILD, 'icon.ico'), '7 sizes (svg<128, raster≥128)');

  // --- Desktop: tray ---
  await writePng(join(DESKTOP_RES, 'tray-iconTemplate.png'), markMonoDark, 22);
  trace('tray-mac-1x', join(DESKTOP_RES, 'tray-iconTemplate.png'), '22x22');

  await writePng(join(DESKTOP_RES, 'tray-iconTemplate@2x.png'), markMonoDark, 44);
  trace('tray-mac-2x', join(DESKTOP_RES, 'tray-iconTemplate@2x.png'), '44x44');

  await writeIco(join(DESKTOP_RES, 'tray-icon.ico'), mark, [16, 20, 24, 32, 40, 48]);
  trace('tray-win-ico', join(DESKTOP_RES, 'tray-icon.ico'), '6 sizes');

  await writePng(join(DESKTOP_RES, 'tray-icon.png'), mark, 22);
  trace('tray-linux', join(DESKTOP_RES, 'tray-icon.png'), '22x22');

  // --- Web: favicons + PWA + in-app ---
  await writeAppIconPng(join(WEB_ICONS, 'favicon-16.png'), appIconSources, 16);
  trace('favicon-16', join(WEB_ICONS, 'favicon-16.png'), '16 (svg)');

  await writeAppIconPng(join(WEB_ICONS, 'favicon-32.png'), appIconSources, 32);
  trace('favicon-32', join(WEB_ICONS, 'favicon-32.png'), '32 (svg)');

  await writeAppIconPng(join(WEB_ICONS, 'apple-touch-icon.png'), appIconSources, 180);
  trace('apple-touch', join(WEB_ICONS, 'apple-touch-icon.png'), '180 (raster)');

  await writeAppIconPng(join(WEB_ICONS, 'icon-192.png'), appIconSources, 192);
  trace('pwa-192', join(WEB_ICONS, 'icon-192.png'), '192 (raster)');

  await writeAppIconPng(join(WEB_ICONS, 'icon-512.png'), appIconSources, 512);
  trace('pwa-512', join(WEB_ICONS, 'icon-512.png'), '512 (raster)');

  await writeCenteredMarkPng(
    join(WEB_ICONS, 'icon-maskable-512.png'),
    mark,
    512,
    0.6,
    MASKABLE_BG,
  );
  trace('pwa-maskable', join(WEB_ICONS, 'icon-maskable-512.png'), `512 (60% mark on ${MASKABLE_BG})`);

  // Logo for the SpaceSidebar home tile: routes through the standard
  // app-icon hybrid path (raster ≥128, squircle-masked) — same designed
  // 3D render as desktop launcher / dock / homescreen, just sized for
  // the sidebar slot. The squircle's 22 %-radius transparent corners are
  // fully contained by the sidebar's own CSS mask (`rounded-[20px → 13px]`
  // on a 40×40 tile = 50 % → 32.5 % radius — both more aggressive than
  // 22 %), so no transparent gaps show against the `#1a1a23` surface.
  // The new raster's vignetted dark-gradient corners visually replace the
  // legacy `#1d1d1b → #000000` SVG fill swap that was needed to make the
  // flat badge read as an intentional dark tile rather than a warm-grey
  // rectangle — the 3D render carries its own dark surround.
  await writeAppIconPng(join(WEB_ICONS, 'logo.png'), appIconSources, 256);
  trace('in-app-logo', join(WEB_ICONS, 'logo.png'), '256 (raster, sidebar tile)');

  // --- Summary ---
  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };
  console.log('\nGenerated icons:');
  console.log('  ' + 'kind'.padEnd(14) + 'info'.padEnd(30) + 'size'.padStart(10) + '  path');
  console.log('  ' + '----'.padEnd(14) + '----'.padEnd(30) + '----'.padStart(10) + '  ----');
  for (const r of written) {
    console.log('  ' + r.label.padEnd(14) + r.info.padEnd(30) + fmtBytes(r.bytes).padStart(10) + '  ' + r.path);
  }
  const totalBytes = written.reduce((sum, r) => sum + r.bytes, 0);
  console.log(`\n${written.length} files written, ${fmtBytes(totalBytes)} total.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
