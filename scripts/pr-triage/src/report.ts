import type { LockfileDiff, PathHit, PipelineArea, SourcesDiff, Triage } from './types.ts';
import { code, codeList, inline, login } from './sanitize.ts';
import { readFirstReasons } from './verdict.ts';

/**
 * First line of every comment the bot posts. The CLI finds its own earlier
 * comment by this prefix (and the bot author) and updates it in place, so
 * a PR carries one triage comment however many times it is pushed.
 */
export const MARKER = '<!-- backspace-pr-triage -->';

const AREA_LABEL: Record<PipelineArea, string> = {
  ci: 'CI workflows',
  installTime: 'Install-time code (`postinstall` and friends, pnpm settings, `.pnpmfile.cjs`, `.npmrc`, `patches/`)',
  buildRecipes: 'Build recipes (Dockerfile, Compose, Flatpak manifest and helpers, shell scripts)',
  scannerConfig: 'Scanner configuration (CodeQL, OSV, Trivy, ZAP, gitleaks)',
};

function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`;
}

function areaCell(area: PipelineArea, hits: PathHit[], packageJson: Triage['packageJson']): string {
  const paths = hits.filter((h) => h.area === area).map((h) => h.path);
  const parts: string[] = [];
  if (paths.length > 0) parts.push(`**changed**: ${codeList(paths)}`);
  if (area === 'installTime') {
    for (const change of packageJson) {
      parts.push(`**${code(change.path)}**: ${codeList(change.keys)}`);
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'unchanged';
}

function lockfileCell(diff: LockfileDiff | null): string {
  if (diff === null) return 'unchanged';
  const parts: string[] = [];
  if (diff.bumped > 0) parts.push(`${plural(diff.bumped, 'package')} updated`);
  if (diff.added.length > 0) parts.push(`${diff.added.length} new: ${codeList(diff.added)}`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed: ${codeList(diff.removed)}`);
  if (parts.length === 0) parts.push('no package changes');
  const notes: string[] = [];
  if (diff.nonRegistry.length > 0) {
    const items = diff.nonRegistry.slice(0, 5).map((e) => `${code(e.key)} ${inline(e.resolution)}`);
    const rest = diff.nonRegistry.length - items.length;
    notes.push(
      `**${plural(diff.nonRegistry.length, 'package resolves', 'packages resolve')} outside the registry**: ${items.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
    );
  } else {
    notes.push('All registry-resolved');
  }
  if (diff.newLocalSpecifiers.length > 0) {
    notes.push(`**${plural(diff.newLocalSpecifiers.length, 'new local or link dependency', 'new local or link dependencies')}**: ${codeList(diff.newLocalSpecifiers, 5)}`);
  }
  if (diff.overridesChanged) notes.push('**`overrides` changed**');
  if (diff.patchedDependenciesChanged) notes.push('**`patchedDependencies` changed**');
  return `${parts.join(', ')}. ${notes.join('. ')}`;
}

function sourcesCell(diff: SourcesDiff | null): string {
  if (diff === null) return 'unchanged';
  const parts: string[] = [];
  if (diff.addedKnown > 0) parts.push(`${plural(diff.addedKnown, 'source')} added from known hosts (npm registry, Electron releases)`);
  if (diff.changedData > 0) parts.push(`${plural(diff.changedData, 'data entry', 'data entries')} regenerated`);
  if (diff.removed > 0) parts.push(`${diff.removed} removed`);
  if (parts.length === 0) parts.push('no entry changes');
  const executable = diff.concerns.filter((c) => c.kind === 'executable').map((c) => c.label);
  const foreign = diff.concerns.filter((c) => c.kind === 'foreign').map((c) => c.label);
  const notes: string[] = [];
  if (executable.length > 0) {
    notes.push(`**${plural(executable.length, 'executable entry', 'executable entries')} added or changed**: ${codeList(executable, 5)}`);
  }
  if (foreign.length > 0) {
    notes.push(`**${plural(foreign.length, 'download', 'downloads')} from an unknown host**: ${codeList(foreign, 5)}`);
  }
  return notes.length > 0 ? `${parts.join(', ')}. ${notes.join('. ')}` : parts.join(', ');
}

function verdictLine(triage: Triage): string {
  if (triage.verdict === 'unanalysable') {
    const why = triage.problems.map(inline).join('; ');
    return `**CI approval: could not analyse.** ${why}. The maintainer reads the full diff before approving CI runs or merging, so this step can take a little longer.`;
  }
  if (triage.verdict === 'read-first') {
    const reasons = codeList(readFirstReasons(triage), 8);
    return `**CI approval: read first.** This PR changes the pipeline itself, so the maintainer reads these before approving CI runs or merging: ${reasons}. This step can take a little longer.`;
  }
  return '**CI approval: routine.** The pipeline this PR runs through is unchanged: no workflow, install hook, build recipe or scanner configuration differs from the base branch. The PR\'s own code runs inside the same test and build steps every PR runs in, with no secrets and a read-only token.';
}

export function render(triage: Triage): string {
  const who = login(triage.author);
  const greeting = who ? `Hi @${who}, thanks for the PR!` : 'Thanks for the PR!';
  const rows: Array<[string, string]> = [
    [AREA_LABEL.ci, areaCell('ci', triage.hits, triage.packageJson)],
    [AREA_LABEL.installTime, areaCell('installTime', triage.hits, triage.packageJson)],
    [AREA_LABEL.buildRecipes, areaCell('buildRecipes', triage.hits, triage.packageJson)],
    [AREA_LABEL.scannerConfig, areaCell('scannerConfig', triage.hits, triage.packageJson)],
    ['`pnpm-lock.yaml`', lockfileCell(triage.lockfile)],
    ['`flatpak/node-sources.json`', sourcesCell(triage.sources)],
  ];
  const sha = /^[0-9a-f]{40}$/.test(triage.headSha) ? triage.headSha.slice(0, 7) : inline(triage.headSha);

  return [
    MARKER,
    '### Automated pre-review notes',
    '',
    `${greeting} This bot summarises what a pull request touches so the maintainer can decide from anywhere whether to approve CI runs and where to start reading. It only looks at file paths and dependency sources, never at whether the change is good, so nothing here is feedback on your work.`,
    '',
    verdictLine(triage),
    '',
    '| Area | Result |',
    '|---|---|',
    ...rows.map(([area, result]) => `| ${area} | ${result} |`),
    '',
    'The dependency rows are for the merge review. They only affect the CI verdict when they add something the build itself executes.',
    '',
    `Updated for commit \`${sha}\` (${plural(triage.totalFiles, 'file')} changed).`,
  ].join('\n');
}
