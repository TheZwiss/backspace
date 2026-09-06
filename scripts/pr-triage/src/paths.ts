import type { ChangedFile, PathHit, PipelineArea } from './types.ts';

/**
 * Which changed paths rewrite the CI pipeline itself.
 *
 * The lists below are derived from what the `pull_request` workflows in
 * `.github/workflows/` actually execute or read on a fork PR, not from a
 * generic notion of "sensitive files". `ci.yml` runs `pnpm install`,
 * `pnpm build`, `pnpm -r test` and a Docker build; `flatpak.yml` runs
 * flatpak-builder in a privileged container from the manifest and
 * `flatpak/*`; `dast.yml` builds and starts the container image;
 * `security.yml`/`codeql.yml` read their scanner configuration from the
 * checkout. A change to any of those inputs alters what runs or what is
 * checked, so it is listed here.
 *
 * Deliberately NOT listed: application source, tests, Vite/PostCSS/vitest
 * configs, `scripts/*.mjs`. Every one of those executes on the runner too,
 * inside the test and build steps, and that is true of every PR. The
 * verdict wording accounts for it; enumerating it would make every PR
 * "read first" and the signal worthless.
 *
 * `package.json` is not a path signal either: a dependency bump is routine
 * and a new `postinstall` is not, and only the content tells them apart.
 * See `package-json.ts`.
 */
const RULES: Array<{ area: PipelineArea; test: (path: string) => boolean }> = [
  { area: 'ci', test: (p) => p.startsWith('.github/workflows/') || p.startsWith('.github/actions/') },
  {
    area: 'installTime',
    test: (p) =>
      basename(p) === '.pnpmfile.cjs' ||
      basename(p) === '.npmrc' ||
      p === 'pnpm-workspace.yaml' ||
      p.startsWith('patches/'),
  },
  {
    area: 'buildRecipes',
    test: (p) =>
      /^Dockerfile(\.[\w.-]+)?$/.test(p) ||
      /^docker-compose[\w.-]*\.ya?ml$/.test(p) ||
      p === 'docker-entrypoint.sh' ||
      p === 'Caddyfile' ||
      p === 'install.sh' ||
      p === 'deploy.sh' ||
      p === 'restore.sh' ||
      /^io\.github\.TheZwiss\.backspace[\w.-]*\.ya?ml$/.test(p) ||
      /^flatpak\/[^/]+\.(sh|mjs|cjs|js|py)$/.test(p) ||
      p === 'packages/desktop/electron-builder.yml' ||
      p.startsWith('packages/desktop/scripts/'),
  },
  {
    area: 'scannerConfig',
    test: (p) =>
      p.startsWith('.github/codeql/') ||
      p === 'osv-scanner.toml' ||
      p === '.trivyignore' ||
      p.startsWith('.zap/') ||
      p === '.gitleaks.toml',
  },
];

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Classifies every changed path, including the previous name of a rename,
 * so that renaming a workflow away (which disables it) is caught the same
 * as editing it. Order follows the input; each path appears at most once.
 */
export function classifyPaths(files: ChangedFile[]): PathHit[] {
  const seen = new Set<string>();
  const hits: PathHit[] = [];
  for (const file of files) {
    const candidates = [file.filename];
    if (file.previous_filename !== undefined && file.previous_filename !== file.filename) {
      candidates.push(file.previous_filename);
    }
    for (const path of candidates) {
      if (seen.has(path)) continue;
      seen.add(path);
      const rule = RULES.find((r) => r.test(path));
      if (rule) hits.push({ area: rule.area, path });
    }
  }
  return hits;
}

/** A `package.json` anywhere in the tree (workspace roots and packages). */
export function isPackageJson(path: string): boolean {
  return basename(path) === 'package.json';
}

/** Only the root lockfile is used by `pnpm install --frozen-lockfile`. */
export function isLockfile(path: string): boolean {
  return path === 'pnpm-lock.yaml';
}

/** The committed Flatpak offline source list that `flatpak.yml` builds from. */
export function isNodeSources(path: string): boolean {
  return path === 'flatpak/node-sources.json';
}
