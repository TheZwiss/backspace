#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const input = resolve(process.argv[2] ?? 'io.github.TheZwiss.backspace.yml');
const output = resolve(process.argv[3] ?? 'io.github.TheZwiss.backspace.ci.yml');
const manifest = readFileSync(input, 'utf8');

const pinnedSource = /      - type: git\r?\n        url: https:\/\/github\.com\/TheZwiss\/backspace\.git\r?\n        commit: [0-9a-f]{40}/;
const matches = manifest.match(new RegExp(pinnedSource.source, 'g')) ?? [];
if (matches.length !== 1) {
  throw new Error(`Expected one pinned Backspace source, found ${matches.length}`);
}

const publishedSources = /^      - flatpak\/node-sources\.json\r?$/gm;
const sourceMatches = manifest.match(publishedSources) ?? [];
if (sourceMatches.length !== 1) {
  throw new Error(`Expected one published offline source list, found ${sourceMatches.length}`);
}

const generatedSources = resolve(dirname(output), 'flatpak/node-sources.ci.json');
if (!existsSync(generatedSources)) {
  throw new Error(`Missing generated CI source list: ${generatedSources}\n`
    + 'Run the generator from the checkout root first (see flatpak/README.md):\n'
    + 'flatpak run --filesystem="$PWD" --command=flatpak-node-generator org.flatpak.Builder '
    + '--electron-node-headers --node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08 '
    + '-o "$PWD/flatpak/node-sources.ci.json" pnpm "$PWD/pnpm-lock.yaml"\n'
    + 'For a custom output manifest directory, adjust -o to the missing path above.');
}

// CI must build the checked-out PR, not the last released commit.
// Both the application source and its offline dependencies must come from the
// checkout. The published pair remains pinned until release metadata updates it.
const ciManifest = manifest.replace(
  pinnedSource,
  '      - type: dir\n        path: .',
).replace(publishedSources, '      - flatpak/node-sources.ci.json');
writeFileSync(output, ciManifest);
