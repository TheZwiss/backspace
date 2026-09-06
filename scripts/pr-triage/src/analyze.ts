import type { ChangedFile, PackageJsonChange, Triage } from './types.ts';
import type { PullRequest } from './github.ts';
import { classifyPaths, isLockfile, isNodeSources, isPackageJson } from './paths.ts';
import { diffPackageJson } from './package-json.ts';
import { diffLockfiles } from './lockfile.ts';
import { diffSources } from './sources.ts';
import { decideVerdict } from './verdict.ts';

/** What the analysis needs from GitHub, narrowed so tests can hand in a stub. */
export interface AnalysisInput {
  pull: PullRequest;
  files: ChangedFile[];
  mergeBase: string;
  /** Raw contents of `path` at commit `ref`, or null if absent. May throw. */
  getRawFile(path: string, ref: string): Promise<string | null>;
}

/**
 * Runs every signal over the PR and folds the results into one `Triage`.
 *
 * Anything that stops a signal from completing (a fetch error, an
 * oversized or unparseable file, a truncated file listing) is recorded in
 * `problems` and the verdict becomes `unanalysable`. No signal failure is
 * ever swallowed into a "routine".
 */
export async function analyze(input: AnalysisInput): Promise<Triage> {
  const { pull, files, mergeBase } = input;
  const headSha = pull.head.sha;
  const problems: string[] = [];

  if (files.length !== pull.changed_files) {
    problems.push(`GitHub listed ${files.length} of ${pull.changed_files} changed files`);
  }

  const hits = classifyPaths(files);

  const packageJson: PackageJsonChange[] = [];
  for (const file of files) {
    const basePath = file.previous_filename ?? file.filename;
    if (!isPackageJson(file.filename) && !isPackageJson(basePath)) continue;
    try {
      const base = isPackageJson(basePath) ? await input.getRawFile(basePath, mergeBase) : null;
      const head = file.status === 'removed' || !isPackageJson(file.filename) ? null : await input.getRawFile(file.filename, headSha);
      const diff = diffPackageJson(file.filename, base, head);
      if (!diff.ok) problems.push(diff.reason);
      else if (diff.keys.length > 0) packageJson.push({ path: file.filename, keys: diff.keys });
    } catch (err) {
      problems.push(`${file.filename}: ${message(err)}`);
    }
  }

  let lockfile: Triage['lockfile'] = null;
  const lockfileFile = files.find((f) => isLockfile(f.filename) || isLockfile(f.previous_filename ?? ''));
  if (lockfileFile) {
    try {
      const base = await input.getRawFile('pnpm-lock.yaml', mergeBase);
      const head = await input.getRawFile('pnpm-lock.yaml', headSha);
      if (head === null) problems.push('pnpm-lock.yaml is removed or renamed at head');
      else {
        const diff = diffLockfiles(base, head);
        if (!diff.ok) problems.push(`pnpm-lock.yaml: ${diff.reason}`);
        else lockfile = diff.value;
      }
    } catch (err) {
      problems.push(`pnpm-lock.yaml: ${message(err)}`);
    }
  }

  let sources: Triage['sources'] = null;
  const sourcesFile = files.find((f) => isNodeSources(f.filename) || isNodeSources(f.previous_filename ?? ''));
  if (sourcesFile) {
    try {
      const base = await input.getRawFile('flatpak/node-sources.json', mergeBase);
      const head = await input.getRawFile('flatpak/node-sources.json', headSha);
      if (head === null) problems.push('flatpak/node-sources.json is removed or renamed at head');
      else {
        const diff = diffSources(base, head);
        if (!diff.ok) problems.push(`flatpak/node-sources.json: ${diff.reason}`);
        else sources = diff.value;
      }
    } catch (err) {
      problems.push(`flatpak/node-sources.json: ${message(err)}`);
    }
  }

  const partial: Omit<Triage, 'verdict'> = {
    headSha,
    author: pull.user?.login ?? '',
    totalFiles: pull.changed_files,
    hits,
    packageJson,
    lockfile,
    sources,
    problems,
  };
  return { verdict: decideVerdict(partial), ...partial };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
