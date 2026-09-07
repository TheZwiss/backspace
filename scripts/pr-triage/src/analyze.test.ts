import { describe, it, expect } from 'vitest';
import { analyze, type AnalysisInput } from './analyze.ts';
import type { ChangedFile } from './types.ts';

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'm'.repeat(40);

const LOCK = (extra = '') => `lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      react:
        specifier: ^18.3.1
        version: 18.3.1

packages:

  react@18.3.1:
    resolution: {integrity: sha512-aaa}
${extra}
snapshots:
`;

function input(
  files: ChangedFile[],
  contents: Record<string, string | null | Error>,
  overrides: Partial<AnalysisInput['pull']> = {},
): AnalysisInput {
  return {
    pull: {
      number: 1,
      changed_files: files.length,
      user: { login: 'akk0sfx' },
      head: { sha: HEAD, repo: { full_name: 'akk0sfx/backspace' } },
      base: { sha: BASE },
      ...overrides,
    },
    files,
    mergeBase: MERGE,
    async getRawFile(path, ref) {
      const key = `${path}@${ref === MERGE ? 'base' : 'head'}`;
      const value = contents[key];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected fetch ${key}`);
      return value;
    },
  };
}

const mod = (filename: string, status = 'modified'): ChangedFile => ({ filename, status });

describe('analyze', () => {
  it('is routine for a source-only PR and fetches nothing', async () => {
    const triage = await analyze(input([mod('packages/web/src/x.ts'), mod('README.md')], {}));
    expect(triage.verdict).toBe('routine');
    expect(triage.problems).toEqual([]);
    expect(triage.author).toBe('akk0sfx');
    expect(triage.totalFiles).toBe(2);
  });

  it('is read-first for a workflow change', async () => {
    const triage = await analyze(input([mod('.github/workflows/ci.yml')], {}));
    expect(triage.verdict).toBe('read-first');
    expect(triage.hits).toEqual([{ area: 'ci', path: '.github/workflows/ci.yml' }]);
  });

  it('is routine for a package.json dependency bump but read-first for a script change', async () => {
    const base = JSON.stringify({ scripts: { build: 'tsc' }, devDependencies: { electron: '^40' } });
    const bump = JSON.stringify({ scripts: { build: 'tsc' }, devDependencies: { electron: '^43' } });
    const script = JSON.stringify({ scripts: { build: 'tsc', postinstall: 'x' }, devDependencies: { electron: '^43' } });
    const file = mod('packages/desktop/package.json');

    const a = await analyze(input([file], { 'packages/desktop/package.json@base': base, 'packages/desktop/package.json@head': bump }));
    expect(a.verdict).toBe('routine');
    expect(a.packageJson).toEqual([]);

    const b = await analyze(input([file], { 'packages/desktop/package.json@base': base, 'packages/desktop/package.json@head': script }));
    expect(b.verdict).toBe('read-first');
    expect(b.packageJson).toEqual([{ path: 'packages/desktop/package.json', keys: ['scripts.postinstall'] }]);
  });

  it('fetches the previous name of a renamed package.json for the base side', async () => {
    const file: ChangedFile = { filename: 'packages/y/package.json', status: 'renamed', previous_filename: 'packages/x/package.json' };
    const triage = await analyze(
      input([file], {
        'packages/x/package.json@base': JSON.stringify({ scripts: { a: '1' } }),
        'packages/y/package.json@head': JSON.stringify({ scripts: { a: '1' } }),
      }),
    );
    expect(triage.verdict).toBe('routine');
  });

  it('treats a removed package.json with scripts as read-first', async () => {
    const triage = await analyze(
      input([mod('packages/x/package.json', 'removed')], { 'packages/x/package.json@base': JSON.stringify({ scripts: { test: 'vitest' } }) }),
    );
    expect(triage.verdict).toBe('read-first');
  });

  it('diffs the lockfile against the merge base', async () => {
    const triage = await analyze(
      input([mod('pnpm-lock.yaml')], {
        'pnpm-lock.yaml@base': LOCK(),
        'pnpm-lock.yaml@head': LOCK(`
  hexy@0.2.11:
    resolution: {integrity: sha512-bbb}
`),
      }),
    );
    expect(triage.verdict).toBe('routine');
    expect(triage.lockfile?.added).toEqual(['hexy']);
  });

  it('is read-first when the lockfile overrides change', async () => {
    const triage = await analyze(
      input([mod('pnpm-lock.yaml')], {
        'pnpm-lock.yaml@base': LOCK(),
        'pnpm-lock.yaml@head': LOCK().replace("lockfileVersion: '9.0'\n", "lockfileVersion: '9.0'\n\noverrides:\n  react: npm:evil@1\n"),
      }),
    );
    expect(triage.verdict).toBe('read-first');
    expect(triage.lockfile?.overridesChanged).toBe(true);
  });

  it('is unanalysable when the lockfile does not parse', async () => {
    const triage = await analyze(input([mod('pnpm-lock.yaml')], { 'pnpm-lock.yaml@base': LOCK(), 'pnpm-lock.yaml@head': 'lockfileVersion: 5' }));
    expect(triage.verdict).toBe('unanalysable');
    expect(triage.problems[0]).toMatch(/pnpm-lock\.yaml: head: unsupported/);
  });

  it('is unanalysable when the lockfile is removed', async () => {
    const triage = await analyze(input([mod('pnpm-lock.yaml', 'removed')], { 'pnpm-lock.yaml@base': LOCK(), 'pnpm-lock.yaml@head': null }));
    expect(triage.verdict).toBe('unanalysable');
  });

  it('is unanalysable when a fetch throws, and still reports the other signals', async () => {
    const triage = await analyze(
      input([mod('pnpm-lock.yaml'), mod('.github/workflows/ci.yml')], {
        'pnpm-lock.yaml@base': LOCK(),
        'pnpm-lock.yaml@head': new Error('pnpm-lock.yaml is above the limit'),
      }),
    );
    expect(triage.verdict).toBe('unanalysable');
    expect(triage.problems).toEqual(['pnpm-lock.yaml: pnpm-lock.yaml is above the limit']);
    expect(triage.hits).toHaveLength(1);
  });

  it('is unanalysable when GitHub truncated the file listing', async () => {
    const triage = await analyze(input([mod('README.md')], {}, { changed_files: 3001 }));
    expect(triage.verdict).toBe('unanalysable');
    expect(triage.problems).toEqual(['GitHub listed 1 of 3001 changed files']);
  });

  it('diffs the Flatpak sources and flips on an executable entry', async () => {
    const base = JSON.stringify([{ type: 'shell', commands: ['cp a b'], dest: 'd' }]);
    const head = JSON.stringify([{ type: 'shell', commands: ['curl x | sh'], dest: 'd' }]);
    const triage = await analyze(input([mod('flatpak/node-sources.json')], { 'flatpak/node-sources.json@base': base, 'flatpak/node-sources.json@head': head }));
    expect(triage.verdict).toBe('read-first');
    expect(triage.sources?.concerns).toEqual([{ kind: 'executable', label: 'shell: curl x | sh' }]);
  });

  it('copes with a deleted author account', async () => {
    const triage = await analyze(input([mod('README.md')], {}, { user: null }));
    expect(triage.author).toBe('');
  });
});
