import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./update-release.mjs', import.meta.url));
const manifest = readFileSync(new URL('../io.github.TheZwiss.backspace.yml', import.meta.url), 'utf8');
const metainfo = readFileSync(new URL('./io.github.TheZwiss.backspace.metainfo.xml', import.meta.url), 'utf8');
const commit = 'a'.repeat(40);
// The committed metadata moves with every release, so the tests read the
// current newest entry and screenshot tag from it instead of naming them.
const newestRelease = metainfo.match(/    <release version="[^"]+"/)[0];
const screenshotTag = metainfo.match(/backspace\/(v\d+\.\d+\.\d+)\/docs\/screenshots\//)[1];

// Runs the script in a scratch checkout holding copies of the three files it
// reads, with package.json set to `version`.
function run(t, args, { version = '9.8.7', metainfoText = metainfo } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'backspace-update-release-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'flatpak'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(dir, 'io.github.TheZwiss.backspace.yml'), manifest);
  writeFileSync(join(dir, 'flatpak', 'io.github.TheZwiss.backspace.metainfo.xml'), metainfoText);
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: dir });
  return {
    ...result,
    manifest: readFileSync(join(dir, 'io.github.TheZwiss.backspace.yml'), 'utf8'),
    metainfo: readFileSync(join(dir, 'flatpak', 'io.github.TheZwiss.backspace.metainfo.xml'), 'utf8'),
  };
}

test('writes the description into a new release entry above the previous ones', t => {
  const result = run(t, ['v9.8.7', commit, '2030-01-02', 'Faster startup, and a new theme.']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.metainfo.includes([
    '  <releases>',
    '    <release version="9.8.7" date="2030-01-02">',
    '      <description>',
    '        <p>Faster startup, and a new theme.</p>',
    '      </description>',
    '    </release>',
    newestRelease,
  ].join('\n')));
  assert.doesNotMatch(result.metainfo, /Backspace 9\.8\.7 release\./);
  assert.match(result.manifest, new RegExp(`        commit: ${commit}`));
  assert.match(result.metainfo, /backspace\/v9\.8\.7\/docs\/screenshots\/chat\.webp/);
  assert.ok(!result.metainfo.includes(`backspace/${screenshotTag}/docs/screenshots/`));
});

test('escapes XML markup in the description', t => {
  const result = run(t, ['v9.8.7', commit, '2030-01-02', 'Search for <b> & "quotes" > less']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.metainfo.includes('        <p>Search for &lt;b&gt; &amp; "quotes" &gt; less</p>'));
});

test('leaves an existing entry for the version untouched and says so', t => {
  const edited = metainfo.replace(
    '  <releases>\n',
    '  <releases>\n    <release version="9.8.7" date="2030-01-01">\n      <description>\n        <p>Written by hand.</p>\n      </description>\n    </release>\n',
  );
  const result = run(t, ['v9.8.7', commit, '2030-01-02', 'From the release notes.'], { metainfoText: edited });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already has a release entry for 9\.8\.7/);
  assert.ok(result.metainfo.includes('<p>Written by hand.</p>'));
  assert.doesNotMatch(result.metainfo, /From the release notes\./);
  assert.equal(result.metainfo.match(/<release version="9\.8\.7"/g).length, 1);
});

for (const [name, args, error] of [
  ['a missing description', ['v9.8.7', commit, '2030-01-02'], /release description/],
  ['a blank description', ['v9.8.7', commit, '2030-01-02', '  '], /release description/],
  ['a multi-line description', ['v9.8.7', commit, '2030-01-02', 'one\ntwo'], /single line/],
  ['a malformed tag', ['9.8.7', commit, '2030-01-02', 'Text.'], /release tag/],
]) {
  test(`rejects ${name} without touching any file`, t => {
    const result = run(t, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.equal(result.manifest, manifest);
    assert.equal(result.metainfo, metainfo);
  });
}
