import { describe, it, expect } from 'vitest';
import { render, MARKER } from './report.ts';
import type { Triage } from './types.ts';

const SHA = 'a'.repeat(40);

function triage(overrides: Partial<Triage> = {}): Triage {
  return {
    verdict: 'routine',
    headSha: SHA,
    author: 'akk0sfx',
    totalFiles: 3,
    hits: [],
    packageJson: [],
    lockfile: null,
    sources: null,
    problems: [],
    ...overrides,
  };
}

describe('render', () => {
  it('starts with the marker and greets the author', () => {
    const out = render(triage());
    expect(out.startsWith(`${MARKER}\n`)).toBe(true);
    expect(out).toContain('Hi @akk0sfx, thanks for the PR!');
  });

  it('renders the routine verdict with every row unchanged', () => {
    const out = render(triage());
    expect(out).toContain('**CI approval: routine.**');
    expect(out.match(/\| unchanged \|/g)).toHaveLength(6);
    expect(out).toContain('Updated for commit `aaaaaaa` (3 files changed).');
  });

  it('renders the read-first verdict naming every reason', () => {
    const out = render(
      triage({
        verdict: 'read-first',
        hits: [{ area: 'ci', path: '.github/workflows/ci.yml' }],
        packageJson: [{ path: 'packages/desktop/package.json', keys: ['scripts.postinstall'] }],
      }),
    );
    expect(out).toContain('**CI approval: read first.**');
    expect(out).toContain('`.github/workflows/ci.yml`, `packages/desktop/package.json (scripts.postinstall)`');
    expect(out).toContain('| CI workflows | **changed**: `.github/workflows/ci.yml` |');
    expect(out).toContain('**`packages/desktop/package.json`**: `scripts.postinstall`');
  });

  it('renders the fail-closed verdict with the problems', () => {
    const out = render(triage({ verdict: 'unanalysable', problems: ['GitHub listed 3000 of 3001 changed files'] }));
    expect(out).toContain('**CI approval: could not analyse.** GitHub listed 3000 of 3001 changed files.');
  });

  it('summarises a routine lockfile change', () => {
    const out = render(
      triage({
        lockfile: {
          added: ['@nornagon/put', 'dbus-next', 'hexy'],
          bumped: 12,
          removed: [],
          nonRegistry: [],
          newLocalSpecifiers: [],
          overridesChanged: false,
          patchedDependenciesChanged: false,
        },
      }),
    );
    expect(out).toContain('| `pnpm-lock.yaml` | 12 packages updated, 3 new: `@nornagon/put`, `dbus-next`, `hexy`. All registry-resolved |');
  });

  it('bolds lockfile findings that need review', () => {
    const out = render(
      triage({
        lockfile: {
          added: ['evil'],
          bumped: 0,
          removed: ['sharp'],
          nonRegistry: [{ key: 'evil@1.0.0', resolution: '{tarball: https://evil.example/e.tgz}' }],
          newLocalSpecifiers: ['packages/web: local -> file:../local (file:../local)'],
          overridesChanged: true,
          patchedDependenciesChanged: false,
        },
      }),
    );
    expect(out).toContain('1 new: `evil`, 1 removed: `sharp`.');
    expect(out).toContain('**1 package resolves outside the registry**: `evil@1.0.0` {tarball: https://evil.example/e.tgz}');
    expect(out).toContain('**1 new local or link dependency**: `packages/web: local -> file:../local (file:../local)`');
    expect(out).toContain('**`overrides` changed**');
  });

  it('summarises a routine Flatpak regeneration', () => {
    const out = render(triage({ sources: { addedKnown: 15, changedData: 2, removed: 4, concerns: [] } }));
    expect(out).toContain(
      '| `flatpak/node-sources.json` | 15 sources added from known hosts (npm registry, Electron releases), 2 data entries regenerated, 4 removed |',
    );
  });

  it('bolds executable and foreign Flatpak sources', () => {
    const out = render(
      triage({
        verdict: 'read-first',
        sources: {
          addedKnown: 0,
          changedData: 0,
          removed: 1,
          concerns: [
            { kind: 'executable', label: 'shell: curl x | sh' },
            { kind: 'foreign', label: 'https://evil.example/x.tgz' },
          ],
        },
      }),
    );
    expect(out).toContain('**1 executable entry added or changed**: `shell: curl x / sh`');
    expect(out).toContain('**1 download from an unknown host**: `https://evil.example/x.tgz`');
    expect(out).toContain('`flatpak/node-sources.json (shell: curl x / sh)`');
  });

  it('never lets PR-controlled strings break the table or the greeting', () => {
    const out = render(
      triage({
        verdict: 'read-first',
        author: 'not a login',
        headSha: 'garbage|`',
        hits: [{ area: 'ci', path: '.github/workflows/a|b`c\n.yml' }],
      }),
    );
    expect(out).toContain('Thanks for the PR!');
    expect(out).not.toContain('@not');
    expect(out).toContain("`.github/workflows/a/b'c.yml`");
    expect(out).toContain("Updated for commit `garbage/'`");
    for (const line of out.split('\n').filter((l) => l.startsWith('|'))) {
      expect(line.split('|')).toHaveLength(4);
    }
  });
});
