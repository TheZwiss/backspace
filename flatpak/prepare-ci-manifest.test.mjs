import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./prepare-ci-manifest.mjs', import.meta.url));
const published = readFileSync(new URL('../io.github.TheZwiss.backspace.yml', import.meta.url), 'utf8');

function prepare(t, manifest) {
  const dir = mkdtempSync(join(tmpdir(), 'backspace-flatpak-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'published.yml');
  const output = join(dir, 'ci.yml');
  writeFileSync(input, manifest);
  const result = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' });
  assert.equal(readFileSync(input, 'utf8'), manifest, 'published manifest stays unchanged');
  return { ...result, output };
}

for (const newline of ['\n', '\r\n']) {
  test(`replaces the source and dependency list together (${JSON.stringify(newline)})`, t => {
    const manifest = published.replace(/\r?\n/g, newline);
    const result = prepare(t, manifest);
    assert.equal(result.status, 0, result.stderr);
    const ci = readFileSync(result.output, 'utf8');
    assert.match(ci, /- type: dir\n        path: \./);
    assert.match(ci, /- flatpak\/node-sources\.ci\.json/);
    assert.doesNotMatch(ci, /- type: git|        commit: |\- flatpak\/node-sources\.json/);
    // All unrelated build settings and sources must survive the override.
    assert.equal(ci.replace(/\r\n/g, '\n'), manifest.replace(/\r\n/g, '\n')
      .replace(/      - type: git\n        url: https:\/\/github\.com\/TheZwiss\/backspace\.git\n        commit: [0-9a-f]{40}/,
        '      - type: dir\n        path: .')
      .replace('      - flatpak/node-sources.json', '      - flatpak/node-sources.ci.json'));
  });
}

for (const [name, transform, error] of [
  ['missing dependency list', s => s.replace('      - flatpak/node-sources.json', ''), /offline source list, found 0/],
  ['duplicate dependency list', s => `${s}\n      - flatpak/node-sources.json\n`, /offline source list, found 2/],
  ['missing source pin', s => s.replace(/commit: [0-9a-f]{40}/, 'branch: main'), /pinned Backspace source, found 0/],
]) {
  test(`rejects ${name} before writing a CI manifest`, t => {
    const result = prepare(t, transform(published));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(existsSync(result.output), false);
  });
}
