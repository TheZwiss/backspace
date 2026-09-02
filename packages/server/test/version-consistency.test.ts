import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain ESM helper shared with the release script; it has no
// type declarations and adding a .d.ts for one exported function is not worth it.
import { findVersionedManifests, REPO_ROOT } from '../../../scripts/bump-version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function versionOf(relative: string): string {
  const raw = readFileSync(path.join(REPO_ROOT as string, relative), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '';
}

describe('release version consistency', () => {
  const manifests: string[] = findVersionedManifests();

  it('finds every workspace manifest, so none can be silently left behind', () => {
    // Discovery rather than a hand-written list is the point: adding a package
    // must not require anyone to remember this file exists. If this count ever
    // changes, a package was added or removed and that is worth noticing.
    expect(manifests).toContain('package.json');
    expect(manifests).toContain('packages/server/package.json');
    expect(manifests).toContain('packages/desktop/package.json');
    expect(manifests.length).toBeGreaterThanOrEqual(6);
  });

  it('holds the same version in every manifest', () => {
    // The repo releases these in lockstep. Bumping some and not others is what
    // produces a desktop app and a server image that claim different versions
    // of the same release. scripts/bump-version.mjs writes them all at once.
    const versions = Object.fromEntries(manifests.map((m) => [m, versionOf(m)]));
    const distinct = [...new Set(Object.values(versions))];
    expect(distinct, `manifests disagree: ${JSON.stringify(versions, null, 2)}`).toHaveLength(1);
  });

  it('reports the version the server package actually declares', async () => {
    // The guard against the specific bug this replaces: routes/instance.ts held
    // a hardcoded '1.0.0' that stayed put through 1.0.1 and 1.0.2 while every
    // manifest moved. config.version is now read from the manifest, so the two
    // cannot disagree, and this asserts the value rather than its type.
    const { config } = await import('../src/config.js');
    expect(config.version).toBe(versionOf('packages/server/package.json'));
    expect(config.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('resolves the manifest the runtime image actually ships', () => {
    // config.ts reads ../package.json relative to src/. If the server source
    // ever moves, this catches it before an instance boots unable to state its
    // own version, which is half of the AGPL section 13 source offer.
    const fromConfigPerspective = path.resolve(__dirname, '../src', '../package.json');
    expect(fromConfigPerspective).toBe(path.join(REPO_ROOT as string, 'packages/server/package.json'));
  });
});
