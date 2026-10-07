#!/usr/bin/env node

// Enforces the pairing between the committed offline sources and the release
// the Flatpak manifest pins: flatpak/node-sources.json may change only in a
// change that also moves the manifest's pinned Backspace commit, which is what
// the release metadata pull request from flatpak-release-metadata.yml does.
// The rule itself is stated in flatpak/README.md under README_SECTION.
//
// Command line, from the checkout root:
//   node flatpak/sources-pairing.mjs <base> [<head>]
// compares the two revisions (head defaults to HEAD), prints the outcome on
// stdout and exits 0, or prints why the change breaks the rule on stderr and
// exits 1.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { readManifestPin } from './manifest-pin.mjs';

export const README_SECTION = 'Release-paired offline sources';

const MANIFEST = 'io.github.TheZwiss.backspace.yml';
const SOURCES = 'flatpak/node-sources.json';

/**
 * @param {object} change
 * @param {string} change.baseManifest The manifest's text before the change.
 * @param {string} change.headManifest The manifest's text after the change.
 * @param {string | null} change.baseSources The offline sources' blob id before the change, null when absent.
 * @param {string | null} change.headSources The offline sources' blob id after the change, null when absent.
 * @returns {{ ok: boolean, message: string }}
 */
export function checkSourcesPairing({ baseManifest, headManifest, baseSources, headSources }) {
  const basePin = readManifestPin(baseManifest);
  const headPin = readManifestPin(headManifest);

  if (basePin !== headPin) {
    return {
      ok: true,
      message: `The manifest pin moves from ${basePin} to ${headPin}, so ${SOURCES} may move with it.`,
    };
  }
  if (baseSources === headSources) {
    return { ok: true, message: `${SOURCES} is unchanged.` };
  }
  return {
    ok: false,
    message: `${SOURCES} changed but the commit pinned in ${MANIFEST} did not (${headPin}). `
      + 'The committed offline sources belong to that release and move only together with its pin, '
      + 'in the release metadata pull request. Revert the change to the file: the Flatpak workflow '
      + 'generates flatpak/node-sources.ci.json from this checkout\'s lockfile by itself. '
      + `See "${README_SECTION}" in flatpak/README.md.`,
  };
}

function gitAt(revision, path, args) {
  try {
    return execFileSync('git', [...args, `${revision}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function readChange(base, head) {
  const side = (revision) => {
    const manifest = gitAt(revision, MANIFEST, ['show']);
    if (manifest === null) {
      throw new Error(`Cannot read ${MANIFEST} at ${revision}; is that revision fetched?`);
    }
    const sources = gitAt(revision, SOURCES, ['rev-parse', '--verify', '--quiet']);
    return { manifest, sources: sources === null ? null : sources.trim() };
  };
  const before = side(base);
  const after = side(head);
  return {
    baseManifest: before.manifest,
    headManifest: after.manifest,
    baseSources: before.sources,
    headSources: after.sources,
  };
}

function runCli() {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  try {
    if (!base) {
      throw new Error('Usage: node flatpak/sources-pairing.mjs <base> [<head>]');
    }
    const result = checkSourcesPairing(readChange(base, head));
    if (result.ok) {
      process.stdout.write(`${result.message}\n`);
    } else {
      process.stderr.write(`${result.message}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
