import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./prepare-ci-manifest.mjs', import.meta.url));
const published = readFileSync(new URL('../io.github.TheZwiss.backspace.yml', import.meta.url), 'utf8');

function prepare(t, manifest, { generated = true, existingOutput = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backspace-flatpak-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const input = join(dir, 'published.yml');
  const outputDir = join(dir, 'output');
  const cwd = join(dir, 'cwd');
  mkdirSync(join(outputDir, 'flatpak'), { recursive: true });
  mkdirSync(cwd);
  const output = join(outputDir, 'ci.yml');
  const sources = join(outputDir, 'flatpak', 'node-sources.ci.json');
  if (generated) writeFileSync(sources, '[]\n');
  // Decoys must not satisfy the check: paths belong to the output manifest.
  for (const base of [dir, cwd]) {
    mkdirSync(join(base, 'flatpak'));
    writeFileSync(join(base, 'flatpak', 'node-sources.ci.json'), '[]\n');
  }
  if (existingOutput) writeFileSync(output, 'existing manifest\n');
  writeFileSync(input, manifest);
  const result = spawnSync(process.execPath, [script, input, output], { encoding: 'utf8', cwd });
  assert.equal(readFileSync(input, 'utf8'), manifest, 'published manifest stays unchanged');
  return { ...result, output, sources };
}

for (const existingOutput of [false, true]) {
  test(`rejects missing generated sources without ${existingOutput ? 'overwriting' : 'creating'} the output`, t => {
    const result = prepare(t, published, { generated: false, existingOutput });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(result.sources));
    assert.match(result.stderr, /flatpak-node-generator/);
    assert.match(result.stderr, /--electron-node-headers/);
    assert.match(result.stderr, /org\.freedesktop\.Sdk\.Extension\.node24\/\/25\.08/);
    assert.match(result.stderr, /pnpm-lock\.yaml/);
    if (existingOutput) assert.equal(readFileSync(result.output, 'utf8'), 'existing manifest\n');
    else assert.equal(existsSync(result.output), false);
  });
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
