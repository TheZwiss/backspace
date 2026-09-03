#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = resolve(process.argv[2] ?? 'io.github.TheZwiss.backspace.yml');
const output = resolve(process.argv[3] ?? 'io.github.TheZwiss.backspace.ci.yml');
const manifest = readFileSync(input, 'utf8');

const pinnedSource = /      - type: git\r?\n        url: https:\/\/github\.com\/TheZwiss\/backspace\.git\r?\n        commit: [0-9a-f]{40}/;
const matches = manifest.match(new RegExp(pinnedSource.source, 'g')) ?? [];
if (matches.length !== 1) {
  throw new Error(`Expected one pinned Backspace source, found ${matches.length}`);
}

// CI must build the checked-out PR, not the last released commit. Keeping this
// as a generated override avoids maintaining a second copy of the manifest.
const ciManifest = manifest.replace(
  pinnedSource,
  '      - type: dir\n        path: .',
);
writeFileSync(output, ciManifest);
