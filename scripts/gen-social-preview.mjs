#!/usr/bin/env node
/**
 * Backspace social preview generator
 *
 * Renders scripts/social-preview.html with headless Chrome at exactly
 * 1280x640, device scale 1, and writes the result to both
 * assets/social-preview.png (GitHub's repo card) and
 * site/social-preview.png (the website's og:image) — byte-identical
 * copies of the same render.
 *
 * The template embeds everything it needs so Chrome has no file:// fetch
 * to make: the mark is read live from assets/brand/mark.svg (that file
 * stays the one source of truth for the glyph — see scripts/gen-icons.mjs)
 * and inlined as SVG markup, and both webfonts (site/assets/*) are
 * inlined as base64 data: URIs. Chrome over file:// does not resolve
 * external @font-face sources or mask: url() targets, so anything short
 * of full inlining renders with fallback fonts and no gradient.
 *
 * Run via `pnpm gen-social-preview` after brand or copy changes; commit
 * the diff. Skips (exit 0) with a message if Chrome isn't found, so it
 * never blocks CI on a machine without a browser installed.
 *
 * DETERMINISM: sharp re-encodes Chrome's screenshot on the way out, which
 * normalizes PNG metadata (timestamps, encoder text chunks). Two runs
 * back to back produced byte-identical output in testing on this
 * machine. The main risk for drift across machines/Chrome versions is
 * font rasterization (hinting, subpixel AA) — that isn't asserted here
 * beyond this one machine and Chrome version; if CI ever diffs this file
 * against a committed copy, expect to need a tolerance, not exact bytes.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TEMPLATE = join(ROOT, 'scripts/social-preview.html');
const MARK_SVG = join(ROOT, 'assets/brand/mark.svg');
const FABIO_FONT = join(ROOT, 'site/assets/fabio-xm-variable.ttf');
const DM_SANS_FONT = join(ROOT, 'site/assets/dm-sans.woff2');

const OUT_PATHS = [
  join(ROOT, 'assets/social-preview.png'),
  join(ROOT, 'site/social-preview.png'),
];

const WIDTH = 1280;
const HEIGHT = 640;

// Ground's bottom stop (navyGradientSvg's NAVY_GRADIENT_BOTTOM in
// gen-icons.mjs) — used only as the flatten background for any stray
// transparent pixel Chrome's screenshot might carry; the page itself
// paints opaque all the way to its own edges.
const FLATTEN_BG = '#110222';

const DEFAULT_CHROME_MAC =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function findChrome() {
  return process.env.CHROME || DEFAULT_CHROME_MAC;
}

function requireFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`Missing ${label}: ${relative(ROOT, path)}`);
  }
}

function dataUri(path, mime) {
  const buf = readFileSync(path);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function main() {
  const chrome = findChrome();
  if (!existsSync(chrome)) {
    console.log(
      `gen-social-preview: skipping — Chrome not found at "${chrome}". ` +
        'Install Google Chrome, or point CHROME at a chrome/chromium binary, and re-run.',
    );
    return;
  }

  requireFile(TEMPLATE, 'template');
  requireFile(MARK_SVG, 'mark SVG');
  requireFile(FABIO_FONT, 'Fabio XM font');
  requireFile(DM_SANS_FONT, 'DM Sans font');

  const template = readFileSync(TEMPLATE, 'utf8');
  const markSvg = readFileSync(MARK_SVG, 'utf8').trim();
  const fabioDataUri = dataUri(FABIO_FONT, 'font/ttf');
  const dmSansDataUri = dataUri(DM_SANS_FONT, 'font/woff2');

  const html = template
    .replaceAll('{{MARK_SVG}}', markSvg)
    .replaceAll('{{FABIO_XM_DATA_URI}}', fabioDataUri)
    .replaceAll('{{DM_SANS_DATA_URI}}', dmSansDataUri);

  const tmpDir = mkdtempSync(join(tmpdir(), 'backspace-social-preview-'));
  const tmpHtml = join(tmpDir, 'social-preview.html');
  const tmpPng = join(tmpDir, 'social-preview.png');

  try {
    writeFileSync(tmpHtml, html);

    const args = [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--force-device-scale-factor=1',
      // Gives Chrome real wall-clock time to decode/rasterize the two
      // inlined webfonts before the screenshot is taken. There is no
      // network fetch to wait on (everything is a data: URI), but font
      // parsing is asynchronous relative to first paint and there is no
      // JS hook available through the bare --screenshot flag to await
      // document.fonts.ready explicitly.
      '--virtual-time-budget=5000',
      `--screenshot=${tmpPng}`,
      `file://${tmpHtml}`,
    ];

    const result = spawnSync(chrome, args, { stdio: 'inherit' });
    if (result.error) {
      throw new Error(`Failed to launch Chrome: ${result.error.message}`);
    }
    if (result.status !== 0) {
      throw new Error(`Chrome exited with status ${result.status}`);
    }
    if (!existsSync(tmpPng)) {
      throw new Error('Chrome did not produce a screenshot');
    }

    const renderMeta = await sharp(tmpPng).metadata();
    if (renderMeta.width !== WIDTH || renderMeta.height !== HEIGHT) {
      throw new Error(
        `Unexpected render size ${renderMeta.width}x${renderMeta.height}, expected ${WIDTH}x${HEIGHT}`,
      );
    }

    // Chrome's screenshot PNG carries an alpha channel even though the
    // page paints opaque edge to edge; flatten onto the ground's own
    // bottom colour (belt-and-suspenders — there should be nothing
    // transparent to flatten) and strip the channel so the output stays
    // 3-channel RGB, matching the committed files today.
    const flattened = await sharp(tmpPng)
      .flatten({ background: FLATTEN_BG })
      .removeAlpha()
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();

    for (const outPath of OUT_PATHS) {
      writeFileSync(outPath, flattened);
    }

    const outMeta = await sharp(flattened).metadata();
    console.log(
      `gen-social-preview: wrote ${outMeta.width}x${outMeta.height} ` +
        `${outMeta.channels}ch${outMeta.hasAlpha ? '+a' : ''} ` +
        `(${(flattened.length / 1024).toFixed(1)} KB) to:`,
    );
    for (const outPath of OUT_PATHS) {
      console.log(`  ${relative(ROOT, outPath)}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
