import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLockfile, diffLockfiles } from './lockfile.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const realLockfile = readFileSync(path.join(here, '../../../pnpm-lock.yaml'), 'utf8');

const BASE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

overrides:
  undici@^7: ^7.29.0

patchedDependencies:
  uiohook-napi@1.5.5:
    hash: abc
    path: patches/uiohook-napi@1.5.5.patch

importers:

  .:
    devDependencies:
      sharp:
        specifier: ^0.35.4
        version: 0.35.4(@types/node@20.19.33)

  packages/web:
    dependencies:
      '@backspace/shared':
        specifier: workspace:*
        version: link:../shared
      react:
        specifier: ^18.3.1
        version: 18.3.1

packages:

  '@backspace/thing@1.0.0':
    resolution: {integrity: sha512-aaa}

  react@18.3.1:
    resolution: {integrity: sha512-bbb}
    engines: {node: '>=0.10.0'}

  sharp@0.35.4:
    resolution: {integrity: sha512-ccc}

snapshots:

  react@18.3.1:
    dependencies:
      loose-envify: 1.4.0
`;

function withPackages(extra: string, base: string = BASE): string {
  return base.replace('\nsnapshots:', `${extra}\nsnapshots:`);
}

describe('parseLockfile', () => {
  it('parses the repository lockfile with every entry registry-resolved', () => {
    const parsed = parseLockfile(realLockfile);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.packages.size).toBeGreaterThan(500);
    const nonRegistry = [...parsed.packages.values()].flatMap((versions) =>
      [...versions.values()].filter((r) => !r.registry),
    );
    expect(nonRegistry).toEqual([]);
    expect(parsed.localSpecifiers).toEqual(
      expect.arrayContaining(['packages/web: @backspace/shared -> workspace:* (link:../shared)']),
    );
  });

  it('splits scoped and unscoped keys at the last @', () => {
    const parsed = parseLockfile(BASE);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect([...parsed.packages.keys()]).toEqual(['@backspace/thing', 'react', 'sharp']);
    expect([...parsed.packages.get('react')!.keys()]).toEqual(['18.3.1']);
  });

  it('marks git, tarball, directory and non-semver keys as non-registry', () => {
    const text = withPackages(`
  evil@https://codeload.github.com/x/evil/tar.gz/abc:
    resolution: {tarball: https://codeload.github.com/x/evil/tar.gz/abc}
    version: 1.0.0

  local@file:vendor/local:
    resolution: {directory: vendor/local, type: directory}

  gitdep@1.2.3:
    resolution: {commit: deadbeef, repo: git+ssh://git@github.com/x/y.git, type: git}

  mirrored@2.0.0:
    resolution: {integrity: sha512-ddd, tarball: https://npm.example.org/mirrored/-/mirrored-2.0.0.tgz}
`);
    const parsed = parseLockfile(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    const flagged = [...parsed.packages.entries()].flatMap(([name, versions]) =>
      [...versions.entries()].filter(([, r]) => !r.registry).map(([v]) => `${name}@${v}`),
    );
    expect(flagged).toEqual([
      'evil@https://codeload.github.com/x/evil/tar.gz/abc',
      'local@file:vendor/local',
      'gitdep@1.2.3',
      'mirrored@2.0.0',
    ]);
  });

  it('keeps the raw resolution text for the report', () => {
    const text = withPackages(`
  gitdep@1.2.3:
    resolution: {commit: deadbeef, repo: git+ssh://git@github.com/x/y.git, type: git}
`);
    const parsed = parseLockfile(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.packages.get('gitdep')!.get('1.2.3')!.text).toBe(
      '{commit: deadbeef, repo: git+ssh://git@github.com/x/y.git, type: git}',
    );
  });

  it('collects importer specifiers that point outside the registry', () => {
    const text = BASE.replace(
      "      react:\n        specifier: ^18.3.1\n        version: 18.3.1",
      "      react:\n        specifier: ^18.3.1\n        version: 18.3.1\n      evil:\n        specifier: github:x/evil\n        version: https://codeload.github.com/x/evil/tar.gz/abc\n      local:\n        specifier: file:../local\n        version: file:../local",
    );
    const parsed = parseLockfile(text);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.localSpecifiers).toEqual([
      'packages/web: @backspace/shared -> workspace:* (link:../shared)',
      'packages/web: evil -> github:x/evil (https://codeload.github.com/x/evil/tar.gz/abc)',
      'packages/web: local -> file:../local (file:../local)',
    ]);
  });

  it('exposes the overrides and patchedDependencies blocks verbatim', () => {
    const parsed = parseLockfile(BASE);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(parsed.overrides).toContain('undici@^7: ^7.29.0');
    expect(parsed.patchedDependencies).toContain('patches/uiohook-napi@1.5.5.patch');
  });

  it('fails closed on an unsupported lockfile version', () => {
    const parsed = parseLockfile(BASE.replace("'9.0'", "'6.0'"));
    expect(parsed.ok).toBe(false);
  });

  it('fails closed on a package entry without a single-line resolution', () => {
    const multiLine = withPackages(`
  odd@1.0.0:
    resolution:
      integrity: sha512-eee
`);
    expect(parseLockfile(multiLine).ok).toBe(false);
    const missing = withPackages(`
  odd@1.0.0:
    engines: {node: '>=10'}
`);
    expect(parseLockfile(missing).ok).toBe(false);
  });

  it('fails closed on a key without a version separator', () => {
    expect(parseLockfile(withPackages(`
  justaname:
    resolution: {integrity: sha512-fff}
`)).ok).toBe(false);
  });

  it('fails closed when the packages section is absent', () => {
    expect(parseLockfile("lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n").ok).toBe(false);
  });
});

describe('diffLockfiles', () => {
  it('reports nothing for identical lockfiles', () => {
    const diff = diffLockfiles(BASE, BASE);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value).toEqual({
      added: [],
      bumped: 0,
      removed: [],
      nonRegistry: [],
      newLocalSpecifiers: [],
      overridesChanged: false,
      patchedDependenciesChanged: false,
    });
  });

  it('distinguishes new names from bumped versions and removed names', () => {
    const head = withPackages(`
  hexy@0.2.11:
    resolution: {integrity: sha512-ggg}
`, BASE.replace('react@18.3.1:\n    resolution: {integrity: sha512-bbb}', 'react@19.0.0:\n    resolution: {integrity: sha512-bbb2}').replace(
      "  sharp@0.35.4:\n    resolution: {integrity: sha512-ccc}\n",
      '',
    ));
    const diff = diffLockfiles(BASE, head);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.added).toEqual(['hexy']);
    expect(diff.value.bumped).toBe(1);
    expect(diff.value.removed).toEqual(['sharp']);
  });

  it('lists non-registry entries at head only', () => {
    const head = withPackages(`
  evil@1.0.0:
    resolution: {tarball: https://evil.example/evil.tgz}
`);
    const diff = diffLockfiles(BASE, head);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.nonRegistry).toEqual([
      { key: 'evil@1.0.0', resolution: '{tarball: https://evil.example/evil.tgz}' },
    ]);
  });

  it('lists only importer specifiers that are new at head', () => {
    const head = BASE.replace(
      "      react:\n        specifier: ^18.3.1\n        version: 18.3.1",
      "      react:\n        specifier: ^18.3.1\n        version: 18.3.1\n      local:\n        specifier: file:../local\n        version: file:../local",
    );
    const diff = diffLockfiles(BASE, head);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.newLocalSpecifiers).toEqual(['packages/web: local -> file:../local (file:../local)']);
  });

  it('flags overrides and patchedDependencies changes', () => {
    const head = BASE.replace('undici@^7: ^7.29.0', 'undici@^7: npm:evil@1.0.0').replace('hash: abc', 'hash: xyz');
    const diff = diffLockfiles(BASE, head);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.overridesChanged).toBe(true);
    expect(diff.value.patchedDependenciesChanged).toBe(true);
  });

  it('treats an absent base lockfile as empty', () => {
    const diff = diffLockfiles(null, BASE);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.added).toEqual(['@backspace/thing', 'react', 'sharp']);
  });

  it('fails closed when either side does not parse', () => {
    expect(diffLockfiles(BASE, 'lockfileVersion: 9').ok).toBe(false);
    expect(diffLockfiles('garbage', BASE).ok).toBe(false);
  });
});
