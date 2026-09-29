import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { checkNodeSdkExtension } from './node-sdk-version.mjs';

const script = fileURLToPath(new URL('./node-sdk-version.mjs', import.meta.url));
const manifest = readFileSync(new URL('../io.github.TheZwiss.backspace.yml', import.meta.url), 'utf8');

const workflow = [
  'jobs:',
  '  build:',
  '    steps:',
  '      - run: |',
  '          flatpak install --user --noninteractive -y flathub \\',
  '            org.freedesktop.Sdk.Extension.node24//25.08',
  '      - run: |',
  '          flatpak-node-generator --electron-node-headers \\',
  '            --node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08 \\',
  '            -o flatpak/node-sources.json pnpm pnpm-lock.yaml',
  '',
].join('\n');

function workflowFile(text, path = '.github/workflows/flatpak.yml') {
  return { path, text, generator: true };
}

test('passes when every workflow names the manifest runtime version and extension', () => {
  assert.deepEqual(checkNodeSdkExtension(manifest, [
    workflowFile(workflow),
    workflowFile(workflow, '.github/workflows/flatpak-release-metadata.yml'),
  ]), []);
});

test('fails a generator flag on another runtime version, naming the file and line', () => {
  const stale = workflow.replace('--node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08', '--node-sdk-extension org.freedesktop.Sdk.Extension.node24//24.08');
  const problems = checkNodeSdkExtension(manifest, [workflowFile(stale)]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^\.github\/workflows\/flatpak\.yml:9: /);
  assert.match(problems[0], /org\.freedesktop\.Sdk\.Extension\.node24\/\/24\.08/);
  assert.match(problems[0], /runtime-version '25\.08'/);
});

test('fails an install of the extension on another runtime version', () => {
  const stale = workflow.replace('            org.freedesktop.Sdk.Extension.node24//25.08\n', '            org.freedesktop.Sdk.Extension.node24//24.08\n');
  const problems = checkNodeSdkExtension(manifest, [workflowFile(stale)]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /:6: /);
});

test('fails an extension the manifest does not list in sdk-extensions', () => {
  const other = workflow.replaceAll('node24//', 'node26//');
  const problems = checkNodeSdkExtension(manifest, [workflowFile(other)]);
  assert.equal(problems.length, 2);
  for (const problem of problems) {
    assert.match(problem, /org\.freedesktop\.Sdk\.Extension\.node26 is not in the manifest's sdk-extensions \(org\.freedesktop\.Sdk\.Extension\.node24\)/);
  }
});

test('fails a workflow that no longer passes --node-sdk-extension, so the check cannot go quiet', () => {
  const renamed = workflow.replace('--node-sdk-extension ', '--sdk-extension ');
  const problems = checkNodeSdkExtension(manifest, [workflowFile(renamed)]);
  assert.deepEqual(problems, ['.github/workflows/flatpak.yml: no --node-sdk-extension flag found']);
});

test('fails a generator flag that names the extension without a branch', () => {
  const bare = workflow.replace('--node-sdk-extension org.freedesktop.Sdk.Extension.node24//25.08', '--node-sdk-extension org.freedesktop.Sdk.Extension.node24');
  const problems = checkNodeSdkExtension(manifest, [workflowFile(bare)]);
  assert.deepEqual(problems, ['.github/workflows/flatpak.yml:9: --node-sdk-extension is given org.freedesktop.Sdk.Extension.node24, expected <extension>//25.08']);
});

test('checks references in files that pass no generator flag, without requiring one', () => {
  const readme = 'Install `org.freedesktop.Sdk.Extension.node24//24.08` first.\n';
  assert.deepEqual(checkNodeSdkExtension(manifest, [{ path: 'README.md', text: 'no reference\n', generator: false }]), []);
  const problems = checkNodeSdkExtension(manifest, [{ path: 'README.md', text: readme, generator: false }]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^README\.md:1: /);
});

test('reads a runtime-version written without quotes', () => {
  const unquoted = manifest.replace("runtime-version: '25.08'", 'runtime-version: 25.08');
  assert.deepEqual(checkNodeSdkExtension(unquoted, [workflowFile(workflow)]), []);
});

test('refuses a manifest without runtime-version or sdk-extensions', () => {
  assert.throws(() => checkNodeSdkExtension(manifest.replace(/^runtime-version:.*$/m, ''), []), /no runtime-version/);
  assert.throws(() => checkNodeSdkExtension(manifest.replace(/^sdk-extensions:\n(  - .*\n)+/m, ''), []), /no sdk-extensions/);
});

test('command line passes on the repository as committed', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /org\.freedesktop\.Sdk\.Extension\.node24\/\/25\.08/);
});
