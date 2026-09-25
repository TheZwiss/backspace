#!/usr/bin/env node

// The one place that knows where the Flatpak manifest pins the Backspace
// source commit. update-release.mjs moves the pin to a release's commit, and
// flatpak-release-metadata.yml reads main's pin to tell whether a release has
// already landed: the pin equals the tag's commit exactly when that release's
// metadata pull request has merged.
//
// Command line: node flatpak/manifest-pin.mjs < io.github.TheZwiss.backspace.yml
// prints the pinned commit, or the reason on stderr with exit status 1.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const PINNED_SOURCE = /(      - type: git\r?\n        url: https:\/\/github\.com\/TheZwiss\/backspace\.git\r?\n        commit: )([0-9a-f]{40})/g;

function pinMatches(manifest) {
  const matches = [...String(manifest).matchAll(PINNED_SOURCE)];
  if (matches.length !== 1) {
    throw new Error(`The Flatpak manifest needs one pinned Backspace source, found ${matches.length}`);
  }
  return matches[0];
}

/**
 * @param {string} manifest The Flatpak manifest's text.
 * @returns {string} The 40-character commit the Backspace source is pinned to.
 */
export function readManifestPin(manifest) {
  return pinMatches(manifest)[2];
}

/**
 * @param {string} manifest The Flatpak manifest's text.
 * @param {string} commit The full commit SHA to pin the Backspace source to.
 * @returns {string} The manifest with only that pin changed.
 */
export function writeManifestPin(manifest, commit) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error('Expected the full 40-character release commit SHA');
  }
  const match = pinMatches(manifest);
  const start = match.index + match[1].length;
  return manifest.slice(0, start) + commit + manifest.slice(start + match[2].length);
}

function runCli() {
  try {
    process.stdout.write(`${readManifestPin(readFileSync(0, 'utf8'))}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
