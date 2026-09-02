#!/usr/bin/env node
/**
 * Set the version in every package.json this repo releases in lockstep.
 *
 * The repo has always moved all of these together, and doing it by hand is what
 * let routes/instance.ts drift to a stale constant across two releases. This
 * script is the supported way to bump. Two things back it up: the server reads
 * its own version from its package.json rather than holding a copy, and
 * test/version-consistency.test.ts fails if the manifests disagree.
 *
 * Usage: node scripts/bump-version.mjs 1.0.3
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that hold workspace packages, relative to the repo root. */
const PACKAGE_PARENTS = ['packages', 'scripts'];

/**
 * Find every package.json that carries the release version.
 *
 * Discovered rather than hand-listed on purpose. A hardcoded list is one more
 * copy to drift, and drift is the whole reason this script exists: add a
 * workspace package and it is covered here and by the consistency test without
 * anyone remembering to update either.
 */
export function findVersionedManifests(root = REPO_ROOT) {
  const found = ['package.json'];

  for (const parent of PACKAGE_PARENTS) {
    const parentDir = path.join(root, parent);
    if (!existsSync(parentDir)) continue;

    for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      const relative = path.join(parent, entry.name, 'package.json');
      if (existsSync(path.join(root, relative))) found.push(relative);
    }
  }

  return found.sort();
}

/** Accepts a plain semver release. Prereleases and build metadata are not used here. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

async function main() {
  const next = process.argv[2];

  if (!next) {
    console.error('Usage: node scripts/bump-version.mjs <version>');
    process.exit(1);
  }

  if (!VERSION_PATTERN.test(next)) {
    console.error(`Not a release version: ${next}. Expected three dot-separated numbers, for example 1.0.3.`);
    process.exit(1);
  }

  const manifests = findVersionedManifests();
  const written = [];

  for (const relative of manifests) {
    const file = path.join(REPO_ROOT, relative);
    const raw = await readFile(file, 'utf8');

    // Rewrite the version line in place rather than reserialising the parsed
    // object. JSON.stringify would drop the file's existing indentation and
    // trailing newline, producing a diff that touches every line of every
    // manifest for a one-word change.
    const updated = raw.replace(
      /^(\s*"version"\s*:\s*)"[^"]*"/m,
      (_match, prefix) => `${prefix}"${next}"`,
    );

    if (updated === raw) {
      console.error(`No version field found in ${relative}. Nothing further was written.`);
      process.exit(1);
    }

    await writeFile(file, updated);
    written.push(relative);
  }

  console.log(`Set version ${next} in:`);
  for (const relative of written) console.log(`  ${relative}`);
  console.log('\nNext: commit as chore/release-<version>, then tag and push.');
}

// Only run when invoked directly, so the consistency test can import the finder.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
