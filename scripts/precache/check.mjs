/**
 * Pure logic of the precache size check (scripts/check-precache-size.mjs).
 * Kept apart from the command so the tests can drive it with fixture builds.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** A file fails the check once it is larger than this share of the limit. */
export const PRECACHE_BUDGET_SHARE = 0.9;

/**
 * The urls in the precache manifest of a workbox-generated `sw.js`: the
 * first argument of its single `precacheAndRoute([...])` call.
 *
 * @param {string} swSource
 * @returns {string[]}
 */
export function readPrecacheManifest(swSource) {
  const call = /precacheAndRoute\(\[(.*?)\]/s.exec(swSource);
  if (!call) {
    throw new Error('sw.js has no precacheAndRoute([...]) call; the worker format changed or the build did not generate one');
  }
  const urls = [...call[1].matchAll(/url:\s*"([^"]+)"/g)].map((m) => m[1]);
  if (urls.length === 0) {
    throw new Error('the precacheAndRoute([...]) call in sw.js lists no urls');
  }
  return urls;
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * Every file the size rule applies to, with its size on disk: each manifest
 * entry, plus every build asset under `assets/` of a precached type that the
 * manifest does not list. Workbox drops a file that is over its limit from
 * the manifest, so the manifest alone would miss exactly the file this check
 * exists to catch. An asset of any other type (a font, an image, a source
 * map) was never a precache candidate, so its absence says nothing about
 * size and it is left out.
 *
 * @param {string} distDir the web build's output directory
 * @param {string[]} manifestUrls from {@link readPrecacheManifest}
 * @param {readonly string[]} precachedExtensions the worker's precached file
 *   types, `PRECACHE_FILE_EXTENSIONS` in packages/web/src/build/precache.ts
 * @returns {{ path: string, bytes: number, precached: boolean }[]}
 */
export function collectPrecacheCandidates(distDir, manifestUrls, precachedExtensions) {
  const precachedTypes = new Set(precachedExtensions);
  const precached = new Set(manifestUrls);
  const files = manifestUrls.map((url) => {
    const full = path.join(distDir, url);
    if (!existsSync(full)) {
      throw new Error(`the precache manifest lists ${url}, which is not in ${distDir}`);
    }
    return { path: url, bytes: statSync(full).size, precached: true };
  });
  const assetsDir = path.join(distDir, 'assets');
  if (existsSync(assetsDir)) {
    for (const rel of listFiles(assetsDir)) {
      const url = `assets/${rel}`;
      if (precached.has(url) || !precachedTypes.has(path.extname(url).slice(1))) continue;
      files.push({ path: url, bytes: statSync(path.join(assetsDir, rel)).size, precached: false });
    }
  }
  return files;
}

/**
 * @param {number} limitBytes the worker's maximumFileSizeToCacheInBytes
 * @param {{ path: string, bytes: number, precached: boolean }[]} files
 * @returns {{
 *   budgetBytes: number,
 *   overBudget: { path: string, bytes: number, precached: boolean }[],
 *   largest: { path: string, bytes: number, precached: boolean } | null,
 * }}
 */
export function evaluatePrecacheBudget(limitBytes, files) {
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) {
    throw new Error(`the precache limit must be a positive number of bytes, got ${limitBytes}`);
  }
  const budgetBytes = Math.floor(limitBytes * PRECACHE_BUDGET_SHARE);
  const bySize = [...files].sort((a, b) => b.bytes - a.bytes);
  return {
    budgetBytes,
    overBudget: bySize.filter((f) => f.bytes > budgetBytes),
    largest: bySize[0] ?? null,
  };
}
