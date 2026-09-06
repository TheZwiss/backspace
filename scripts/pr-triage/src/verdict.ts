import type { Triage } from './types.ts';

/**
 * The single place that decides what "read first" means, used by the
 * analysis to set the verdict and by the report to explain it, so the two
 * cannot drift apart.
 *
 * A reason is anything that changes the pipeline a fork PR runs through,
 * as opposed to the code it runs inside that pipeline:
 * - a path in one of the pipeline areas (workflows, install-time config,
 *   build recipes, scanner configuration),
 * - a `package.json` whose `scripts`, `pnpm` block or `packageManager`
 *   changed,
 * - a lockfile whose `overrides` or `patchedDependencies` changed (the
 *   lockfile mirror of the `pnpm` block),
 * - a Flatpak source entry that the build executes or downloads from a
 *   host the generator never uses.
 *
 * Deliberately not a reason: new or bumped registry packages and
 * non-registry resolutions in the lockfile. pnpm 10 runs no dependency
 * install scripts unless the allowlist changes, and the allowlist is
 * covered above. Those rows are for the merge review.
 */
export function readFirstReasons(triage: Pick<Triage, 'hits' | 'packageJson' | 'lockfile' | 'sources'>): string[] {
  const reasons: string[] = [];
  for (const hit of triage.hits) reasons.push(hit.path);
  for (const change of triage.packageJson) reasons.push(`${change.path} (${change.keys.join(', ')})`);
  if (triage.lockfile?.overridesChanged) reasons.push('pnpm-lock.yaml (overrides)');
  if (triage.lockfile?.patchedDependenciesChanged) reasons.push('pnpm-lock.yaml (patchedDependencies)');
  for (const concern of triage.sources?.concerns ?? []) {
    reasons.push(`flatpak/node-sources.json (${concern.label})`);
  }
  return reasons;
}

export function decideVerdict(triage: Omit<Triage, 'verdict'>): Triage['verdict'] {
  if (triage.problems.length > 0) return 'unanalysable';
  return readFirstReasons(triage).length > 0 ? 'read-first' : 'routine';
}
