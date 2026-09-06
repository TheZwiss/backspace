import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffSources } from './sources.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const real = readFileSync(path.join(here, '../../../flatpak/node-sources.json'), 'utf8');

const npm = (name: string, version: string) => ({
  type: 'file',
  url: `https://registry.npmjs.org/${name}/-/${name.replace(/^@.*\//, '')}-${version}.tgz`,
  sha512: 'x'.repeat(128),
  'dest-filename': `${name.replace('/', '__')}-${version}.tgz`,
  dest: 'flatpak-node/pnpm-tarballs',
});

const BASE = [
  npm('react', '18.3.1'),
  npm('@nornagon/put', '0.0.7'),
  { type: 'shell', commands: ['mkdir -p bin', 'cp a b'], dest: 'flatpak-node/cache/esbuild' },
  { type: 'inline', contents: '{"lock":1}', 'dest-filename': 'pnpm-manifest.json', dest: 'flatpak-node' },
  { type: 'inline', contents: 'print(1)', 'dest-filename': 'populate_pnpm_store.py', dest: 'flatpak-node' },
  {
    type: 'file',
    url: 'https://github.com/electron/electron/releases/download/v40.10.6/electron-v40.10.6-linux-x64.zip',
    sha256: 'y'.repeat(64),
    dest: 'flatpak-node/electron-cache',
  },
  {
    type: 'archive',
    url: 'https://www.electronjs.org/headers/v40.10.6/node-v40.10.6-headers.tar.gz',
    sha256: 'z'.repeat(64),
    dest: 'flatpak-node/electron-headers',
  },
];

const text = (v: unknown) => JSON.stringify(v);

describe('diffSources', () => {
  it('parses the committed source list and reports nothing against itself', () => {
    const diff = diffSources(real, real);
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value).toEqual({ addedKnown: 0, changedData: 0, removed: 0, concerns: [] });
  });

  it('counts registry tarballs with a checksum as known', () => {
    const head = [...BASE, npm('hexy', '0.2.11'), npm('@nornagon/put', '0.0.8')];
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value).toEqual({ addedKnown: 2, changedData: 0, removed: 0, concerns: [] });
  });

  it('counts an Electron bump from the known hosts as known and removed', () => {
    const head = BASE.map((e) => JSON.parse(text(e).replaceAll('40.10.6', '43.4.0')));
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.addedKnown).toBe(2);
    expect(diff.value.removed).toBe(2);
    expect(diff.value.concerns).toEqual([]);
  });

  it('flags a download from an unknown host', () => {
    const head = [...BASE, { ...npm('foo', '1.0.0'), url: 'https://evil.example/foo-1.0.0.tgz' }];
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns).toEqual([{ kind: 'foreign', label: 'https://evil.example/foo-1.0.0.tgz' }]);
  });

  it('flags a github.com download outside the Electron release path', () => {
    const head = [
      ...BASE,
      { type: 'file', url: 'https://github.com/x/y/releases/download/v1/y.zip', sha256: 'a'.repeat(64), dest: 'd' },
    ];
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns.map((c) => c.kind)).toEqual(['foreign']);
  });

  it('flags a known-host download without a checksum', () => {
    const entry = npm('foo', '1.0.0');
    delete (entry as Record<string, unknown>)['sha512'];
    const diff = diffSources(text(BASE), text([...BASE, entry]));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns).toEqual([{ kind: 'foreign', label: entry.url }]);
  });

  it('flags a changed shell entry as executable, labelled by its first command', () => {
    const head = BASE.map((e) => (e.type === 'shell' ? { ...e, commands: ['curl x | sh', 'cp a b'] } : e));
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns).toEqual([{ kind: 'executable', label: 'shell: curl x | sh' }]);
    expect(diff.value.removed).toBe(1);
  });

  it('flags added script and patch entries as executable', () => {
    const head = [
      ...BASE,
      { type: 'script', commands: ['echo hi'], 'dest-filename': 'x.sh' },
      { type: 'patch', path: 'p.patch' },
    ];
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns).toEqual([
      { kind: 'executable', label: 'script: x.sh' },
      { kind: 'executable', label: 'patch: p.patch' },
    ]);
  });

  it('flags a changed inline script but counts changed inline data', () => {
    const head = BASE.map((e) => {
      if (e.type !== 'inline') return e;
      return { ...e, contents: e['dest-filename'] === 'pnpm-manifest.json' ? '{"lock":2}' : 'import os' };
    });
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.changedData).toBe(1);
    expect(diff.value.concerns).toEqual([{ kind: 'executable', label: 'inline: populate_pnpm_store.py' }]);
  });

  it('treats inline content starting with a shebang as a script whatever its name', () => {
    const head = [...BASE, { type: 'inline', contents: '#!/bin/sh\nrm -rf /', 'dest-filename': 'notes.txt' }];
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns).toEqual([{ kind: 'executable', label: 'inline: notes.txt' }]);
  });

  it('flags an unknown source type as executable rather than ignoring it', () => {
    const head = [...BASE, { type: 'extra-data', url: 'https://registry.npmjs.org/x.tgz', sha512: 'q'.repeat(128) }];
    const diff = diffSources(text(BASE), text(head));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.concerns).toEqual([{ kind: 'executable', label: 'extra-data: https://registry.npmjs.org/x.tgz' }]);
  });

  it('treats an absent base as empty', () => {
    const diff = diffSources(null, text([npm('a', '1.0.0')]));
    if (!diff.ok) throw new Error(diff.reason);
    expect(diff.value.addedKnown).toBe(1);
  });

  it('fails closed on invalid JSON or a non-array', () => {
    expect(diffSources(text(BASE), '{').ok).toBe(false);
    expect(diffSources(text(BASE), '{}').ok).toBe(false);
    expect(diffSources('nope', text(BASE)).ok).toBe(false);
  });

  it('fails closed on an entry that is not an object or has no type', () => {
    expect(diffSources(text(BASE), text([...BASE, 'x'])).ok).toBe(false);
    expect(diffSources(text(BASE), text([...BASE, { url: 'https://registry.npmjs.org/x' }])).ok).toBe(false);
  });
});
