#!/usr/bin/env node
/**
 * Fails when a file the service worker precaches is close to the precache
 * limit. Workbox skips a file over `maximumFileSizeToCacheInBytes` with only a
 * build warning, so without this check the main chunk could outgrow the limit
 * and silently stop being precached. Runs in CI after the web build; see
 * docs/systems/deployment.md.
 *
 * Usage (after `pnpm build` or `pnpm build:web`):
 *   node scripts/check-precache-size.mjs
 *
 * The limit and the precached file types are read from
 * packages/web/src/build/precache.ts, the module vite.config.ts builds the
 * worker with, through Vite's own module loader, so both are defined in one
 * place.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PRECACHE_BUDGET_SHARE,
  collectPrecacheCandidates,
  evaluatePrecacheBudget,
  readPrecacheManifest,
} from './precache/check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(root, 'packages/web');
const distDir = path.join(webDir, 'dist');
const limitModule = path.join(webDir, 'src/build/precache.ts');

async function readPrecacheSettings() {
  // Vite is a dependency of the web package, not of the repository root.
  const requireFromWeb = createRequire(path.join(webDir, 'package.json'));
  const { runnerImport } = await import(pathToFileURL(requireFromWeb.resolve('vite')).href);
  const { module } = await runnerImport(limitModule, { configFile: false, logLevel: 'silent', root: webDir });
  return { limitBytes: module.PRECACHE_MAX_FILE_BYTES, extensions: module.PRECACHE_FILE_EXTENSIONS };
}

function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

async function main() {
  const { limitBytes, extensions } = await readPrecacheSettings();
  let swSource;
  try {
    swSource = readFileSync(path.join(distDir, 'sw.js'), 'utf8');
  } catch {
    throw new Error(`${path.relative(root, distDir)}/sw.js not found; build the web app first`);
  }
  const files = collectPrecacheCandidates(distDir, readPrecacheManifest(swSource), extensions);
  const { budgetBytes, overBudget, largest } = evaluatePrecacheBudget(limitBytes, files);
  const share = `${Math.round(PRECACHE_BUDGET_SHARE * 100)}%`;

  console.log(`Precache limit ${kib(limitBytes)}, budget ${share} of it: ${kib(budgetBytes)}.`);
  console.log(`${files.filter((f) => f.precached).length} precached files.`);
  if (largest) {
    const margin = budgetBytes - largest.bytes;
    const relation = margin >= 0 ? `${kib(margin)} under` : `${kib(-margin)} over`;
    console.log(`Largest: ${largest.path}, ${kib(largest.bytes)} (${relation} the budget).`);
  }

  if (overBudget.length > 0) {
    console.error(`\n${overBudget.length} file(s) over the budget:`);
    for (const file of overBudget) {
      const note = file.precached ? '' : ', NOT precached: workbox dropped it for being over the limit';
      console.error(`  ${file.path}: ${kib(file.bytes)}${note}`);
    }
    console.error('\nSplit the chunk (React.lazy for surfaces not needed on the first screen) before it reaches the limit.');
    process.exit(1);
  }
  console.log('OK');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
