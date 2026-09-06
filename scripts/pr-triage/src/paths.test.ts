import { describe, it, expect } from 'vitest';
import { classifyPaths, isLockfile, isNodeSources, isPackageJson } from './paths.ts';
import type { ChangedFile } from './types.ts';

function files(...names: string[]): ChangedFile[] {
  return names.map((filename) => ({ filename, status: 'modified' }));
}

describe('classifyPaths', () => {
  it('returns nothing for ordinary source and docs changes', () => {
    const hits = classifyPaths(
      files('README.md', 'packages/web/src/utils/screenShare.ts', 'docs/systems/voice.md', 'scripts/check-i18n.mjs'),
    );
    expect(hits).toEqual([]);
  });

  it('puts workflow and composite action files under ci', () => {
    const hits = classifyPaths(files('.github/workflows/ci.yml', '.github/actions/setup/action.yml'));
    expect(hits).toEqual([
      { area: 'ci', path: '.github/workflows/ci.yml' },
      { area: 'ci', path: '.github/actions/setup/action.yml' },
    ]);
  });

  it('does not treat other .github files as ci', () => {
    expect(classifyPaths(files('.github/dependabot.yml', '.github/PULL_REQUEST_TEMPLATE.md'))).toEqual([]);
  });

  it('puts install-time configuration under installTime', () => {
    const hits = classifyPaths(
      files('.pnpmfile.cjs', 'packages/web/.pnpmfile.cjs', '.npmrc', 'packages/server/.npmrc', 'pnpm-workspace.yaml', 'patches/uiohook-napi@1.5.5.patch'),
    );
    expect(hits.map((h) => h.area)).toEqual(['installTime', 'installTime', 'installTime', 'installTime', 'installTime', 'installTime']);
  });

  it('does not classify package.json by path; its content decides', () => {
    expect(classifyPaths(files('package.json', 'packages/desktop/package.json'))).toEqual([]);
    expect(isPackageJson('package.json')).toBe(true);
    expect(isPackageJson('packages/desktop/package.json')).toBe(true);
    expect(isPackageJson('packages/desktop/package.json.bak')).toBe(false);
    expect(isPackageJson('flatpak/pnpm-manifest.json')).toBe(false);
  });

  it('puts container, deploy and Flatpak build files under buildRecipes', () => {
    const names = [
      'Dockerfile',
      'Dockerfile.dev',
      'docker-compose.yml',
      'docker-compose.override.yaml',
      'docker-entrypoint.sh',
      'Caddyfile',
      'install.sh',
      'deploy.sh',
      'restore.sh',
      'io.github.TheZwiss.backspace.yml',
      'io.github.TheZwiss.backspace.ci.yml',
      'flatpak/build.sh',
      'flatpak/prepare-ci-manifest.mjs',
      'flatpak/populate_pnpm_store.py',
      'packages/desktop/electron-builder.yml',
      'packages/desktop/scripts/afterPack.js',
    ];
    const hits = classifyPaths(files(...names));
    expect(hits.map((h) => h.path)).toEqual(names);
    expect(new Set(hits.map((h) => h.area))).toEqual(new Set(['buildRecipes']));
  });

  it('leaves Flatpak metadata and release-only helpers alone', () => {
    expect(
      classifyPaths(files('flatpak/io.github.TheZwiss.backspace.metainfo.xml', 'flatpak/README.md', 'flatpak/update-release.mjs')),
    ).toEqual([{ area: 'buildRecipes', path: 'flatpak/update-release.mjs' }]);
  });

  it('puts scanner configuration under scannerConfig', () => {
    const names = ['.github/codeql/codeql-config.yml', 'osv-scanner.toml', '.trivyignore', '.zap/rules.tsv', '.gitleaks.toml'];
    const hits = classifyPaths(files(...names));
    expect(hits.map((h) => h.path)).toEqual(names);
    expect(new Set(hits.map((h) => h.area))).toEqual(new Set(['scannerConfig']));
  });

  it('classifies the previous name of a renamed file too', () => {
    const hits = classifyPaths([
      { filename: '.github/workflows/security.txt', status: 'renamed', previous_filename: '.github/workflows/security.yml' },
    ]);
    expect(hits).toEqual([
      { area: 'ci', path: '.github/workflows/security.txt' },
      { area: 'ci', path: '.github/workflows/security.yml' },
    ]);
  });

  it('classifies removed files', () => {
    expect(classifyPaths([{ filename: '.github/workflows/codeql.yml', status: 'removed' }])).toEqual([
      { area: 'ci', path: '.github/workflows/codeql.yml' },
    ]);
  });

  it('reports each path once even when it matches twice', () => {
    const hits = classifyPaths([
      { filename: '.github/workflows/ci.yml', status: 'renamed', previous_filename: '.github/workflows/ci.yml' },
    ]);
    expect(hits).toHaveLength(1);
  });

  it('is not fooled by a directory that merely contains a magic name', () => {
    expect(classifyPaths(files('docs/Dockerfile.md', 'packages/web/src/Caddyfile.ts', 'notes/.npmrc.md'))).toEqual([]);
  });

  it('recognises the two files that get their own analysis', () => {
    expect(isLockfile('pnpm-lock.yaml')).toBe(true);
    expect(isLockfile('packages/web/pnpm-lock.yaml')).toBe(false);
    expect(isNodeSources('flatpak/node-sources.json')).toBe(true);
    expect(isNodeSources('flatpak/node-sources.ci.json')).toBe(false);
  });
});
