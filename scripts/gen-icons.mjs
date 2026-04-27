#!/usr/bin/env node
/**
 * Backspace icon generator
 *
 * Reads from assets/brand/*.svg and writes the entire desktop + web icon set:
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
  appIcon:      join(ROOT, 'assets/brand/app-icon.svg'),
  mark:         join(ROOT, 'assets/brand/mark.svg'),
  markMonoDark: join(ROOT, 'assets/brand/mark-mono-dark.svg'),
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

// ---- helpers ----

const loadSvg = (path) => readFileSync(path);

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

async function writePng(path, svg, size) {
  mkdirSync(dirname(path), { recursive: true });
  const buf = await renderPng(svg, size);
  writeFileSync(path, buf);
}

async function writeIco(path, svg, sizes) {
  mkdirSync(dirname(path), { recursive: true });
  const buffers = await Promise.all(sizes.map((s) => renderPng(svg, s)));
  const ico = await pngToIco(buffers);
  writeFileSync(path, ico);
}

async function writeIcns(path, svg) {
  // png2icons.createICNS takes one high-res PNG and synthesises the full
  // 10-rep iconset internally (16/16@2x, 32/32@2x, 128/128@2x, 256/256@2x,
  // 512/512@2x). Render at 1024 for full @2x coverage.
  mkdirSync(dirname(path), { recursive: true });
  const src = await renderPng(svg, 1024);
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
    await writePng(out, appIcon, s);
    trace('linux-png', out, `${s}x${s}`);
  }

  await writePng(join(DESKTOP_BUILD, 'icon.png'), appIcon, 512);
  trace('build-icon', join(DESKTOP_BUILD, 'icon.png'), '512x512');

  await writeIcns(join(DESKTOP_BUILD, 'icon.icns'), appIcon);
  trace('mac-icns', join(DESKTOP_BUILD, 'icon.icns'), '10-rep iconset');

  await writeIco(join(DESKTOP_BUILD, 'icon.ico'), appIcon, [16, 24, 32, 48, 64, 128, 256]);
  trace('win-ico', join(DESKTOP_BUILD, 'icon.ico'), '7 sizes');

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
  await writePng(join(WEB_ICONS, 'favicon-16.png'), appIcon, 16);
  trace('favicon-16', join(WEB_ICONS, 'favicon-16.png'), '16');

  await writePng(join(WEB_ICONS, 'favicon-32.png'), appIcon, 32);
  trace('favicon-32', join(WEB_ICONS, 'favicon-32.png'), '32');

  await writePng(join(WEB_ICONS, 'apple-touch-icon.png'), appIcon, 180);
  trace('apple-touch', join(WEB_ICONS, 'apple-touch-icon.png'), '180');

  await writePng(join(WEB_ICONS, 'icon-192.png'), appIcon, 192);
  trace('pwa-192', join(WEB_ICONS, 'icon-192.png'), '192');

  await writePng(join(WEB_ICONS, 'icon-512.png'), appIcon, 512);
  trace('pwa-512', join(WEB_ICONS, 'icon-512.png'), '512');

  await writeCenteredMarkPng(
    join(WEB_ICONS, 'icon-maskable-512.png'),
    mark,
    512,
    0.6,
    MASKABLE_BG,
  );
  trace('pwa-maskable', join(WEB_ICONS, 'icon-maskable-512.png'), `512 (60% mark on ${MASKABLE_BG})`);

  // Logo for the SpaceSidebar home tile: full Element 1 badge with the
  // bg fill swapped from #1d1d1b → #000000. The badge IS the brand
  // identity at small sizes (full mark mass + own internal padding),
  // and pure black against the sidebar's #1a1a23 reads as deliberately
  // darker (intentional dark tile) rather than as a warm/cool mismatch
  // (the original #1d1d1b looked like an off-grey rectangle). The
  // sidebar's overflow-hidden + rounded-[20px → 13px] morph clips the
  // badge cleanly because the bg is fully opaque.
  const logoSvg = Buffer.from(
    appIcon.toString('utf8').replace(/#1d1d1b/gi, '#000000'),
  );
  await writePng(join(WEB_ICONS, 'logo.png'), logoSvg, 256);
  trace('in-app-logo', join(WEB_ICONS, 'logo.png'), '256 (full badge, #000)');

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
