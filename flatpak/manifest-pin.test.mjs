import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { readManifestPin, writeManifestPin } from './manifest-pin.mjs';

const script = fileURLToPath(new URL('./manifest-pin.mjs', import.meta.url));
const published = readFileSync(new URL('../io.github.TheZwiss.backspace.yml', import.meta.url), 'utf8');
const pinned = published.match(/        commit: ([0-9a-f]{40})/)[1];
const other = 'b'.repeat(40);

test('reads the Backspace source pin from the published manifest', () => {
  assert.equal(readManifestPin(published), pinned);
});

test('reads the pin from a manifest with CRLF line endings', () => {
  assert.equal(readManifestPin(published.replace(/\n/g, '\r\n')), pinned);
});

test('ignores a commit pin on a source that is not the Backspace repository', () => {
  const extra = `${published}\n      - type: git\n        url: https://example.com/other.git\n        commit: ${other}\n`;
  assert.equal(readManifestPin(extra), pinned);
});

for (const [name, manifest, error] of [
  ['a manifest without the pin', published.replace(/commit: [0-9a-f]{40}/, 'branch: main'), /one pinned Backspace source, found 0/],
  ['a manifest with two pins', `${published}\n      - type: git\n        url: https://github.com/TheZwiss/backspace.git\n        commit: ${other}\n`, /one pinned Backspace source, found 2/],
]) {
  test(`rejects ${name}`, () => {
    assert.throws(() => readManifestPin(manifest), error);
  });
}

test('rewrites only the pin', () => {
  const updated = writeManifestPin(published, other);
  assert.equal(readManifestPin(updated), other);
  assert.equal(updated, published.replace(pinned, other));
});

test('refuses to write something that is not a full commit SHA', () => {
  assert.throws(() => writeManifestPin(published, 'v1.5.2'), /full 40-character/);
});

test('command line prints the pin of the manifest on stdin', () => {
  const result = spawnSync(process.execPath, [script], { input: published, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${pinned}\n`);
});

test('command line fails with the reason and prints nothing on stdout', () => {
  const result = spawnSync(process.execPath, [script], { input: 'app-id: x\n', encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /one pinned Backspace source, found 0/);
  assert.doesNotMatch(result.stderr, /    at /, 'no stack trace, only the reason');
});
