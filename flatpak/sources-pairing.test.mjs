import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { README_SECTION, checkSourcesPairing } from './sources-pairing.mjs';

const script = fileURLToPath(new URL('./sources-pairing.mjs', import.meta.url));
const published = readFileSync(new URL('../io.github.TheZwiss.backspace.yml', import.meta.url), 'utf8');
const readme = readFileSync(new URL('./README.md', import.meta.url), 'utf8');
const pinned = published.match(/        commit: ([0-9a-f]{40})/)[1];
const nextRelease = 'b'.repeat(40);
const movedManifest = published.replace(pinned, nextRelease);
const pairedBlob = '1'.repeat(40);
const regeneratedBlob = '2'.repeat(40);

test('passes when the offline sources do not change', () => {
  const result = checkSourcesPairing({
    baseManifest: published,
    headManifest: published,
    baseSources: pairedBlob,
    headSources: pairedBlob,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /unchanged/);
});

test('fails when the offline sources change and the pin does not', () => {
  const result = checkSourcesPairing({
    baseManifest: published,
    headManifest: published,
    baseSources: pairedBlob,
    headSources: regeneratedBlob,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /flatpak\/node-sources\.json changed/);
  assert.match(result.message, new RegExp(pinned));
  assert.match(result.message, /node-sources\.ci\.json/);
  assert.ok(result.message.includes(`"${README_SECTION}" in flatpak/README.md`));
});

test('fails when the offline sources are deleted and the pin does not move', () => {
  const result = checkSourcesPairing({
    baseManifest: published,
    headManifest: published,
    baseSources: pairedBlob,
    headSources: null,
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /flatpak\/node-sources\.json changed/);
});

test('passes when the offline sources move together with the pin', () => {
  const result = checkSourcesPairing({
    baseManifest: published,
    headManifest: movedManifest,
    baseSources: pairedBlob,
    headSources: regeneratedBlob,
  });
  assert.equal(result.ok, true);
  assert.match(result.message, new RegExp(`${pinned} to ${nextRelease}`));
});

test('passes when the pin moves and the release needs the same offline sources', () => {
  const result = checkSourcesPairing({
    baseManifest: published,
    headManifest: movedManifest,
    baseSources: pairedBlob,
    headSources: pairedBlob,
  });
  assert.equal(result.ok, true);
});

test('refuses a manifest whose pin cannot be read', () => {
  assert.throws(() => checkSourcesPairing({
    baseManifest: published,
    headManifest: published.replace(/commit: [0-9a-f]{40}/, 'branch: main'),
    baseSources: pairedBlob,
    headSources: regeneratedBlob,
  }), /one pinned Backspace source, found 0/);
});

test('the README section the failure points at exists', () => {
  assert.ok(readme.split(/\r?\n/).includes(`## ${README_SECTION}`), `flatpak/README.md has no "## ${README_SECTION}" heading`);
});

// The command line reads both sides from Git, so it is exercised against a
// small repository whose commits have the shapes a pull request can take.
const repo = mkdtempSync(join(tmpdir(), 'sources-pairing-'));
after(() => rmSync(repo, { recursive: true, force: true }));

function git(...args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function commit(files, subject) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git('add', '--all');
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', subject);
  return git('rev-parse', 'HEAD');
}

git('-c', 'init.defaultBranch=main', 'init', '--quiet');
const release = commit({
  'io.github.TheZwiss.backspace.yml': published,
  'flatpak/node-sources.json': '[{"type":"file","url":"a"}]\n',
  'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
}, 'release');
const lockfileOnly = commit({ 'pnpm-lock.yaml': 'lockfileVersion: 9.0\n# bumped\n' }, 'lockfile only');
const regenerated = commit({ 'flatpak/node-sources.json': '[{"type":"file","url":"b"}]\n' }, 'regenerate');
const metadata = commit({
  'io.github.TheZwiss.backspace.yml': movedManifest,
  'flatpak/node-sources.json': '[{"type":"file","url":"c"}]\n',
}, 'release metadata');

function run(base, head) {
  return spawnSync(process.execPath, [script, base, head], { cwd: repo, encoding: 'utf8' });
}

test('command line passes a pull request that changes only the lockfile', () => {
  const result = run(release, lockfileOnly);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unchanged/);
});

test('command line fails a pull request that regenerates the offline sources', () => {
  const result = run(lockfileOnly, regenerated);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /flatpak\/node-sources\.json changed/);
  assert.ok(result.stderr.includes(README_SECTION));
});

test('command line passes the release metadata pull request', () => {
  const result = run(regenerated, metadata);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`${pinned} to ${nextRelease}`));
});

test('command line reports a revision it cannot read, without a stack trace', () => {
  const result = run('0'.repeat(40), metadata);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read io\.github\.TheZwiss\.backspace\.yml at 0{40}/);
  assert.doesNotMatch(result.stderr, /    at /);
});

test('command line needs the base revision', () => {
  const result = spawnSync(process.execPath, [script], { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage: node flatpak\/sources-pairing\.mjs <base> \[<head>\]/);
});
