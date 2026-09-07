/**
 * One entry of `GET /repos/{r}/pulls/{n}/files`. Only the fields the triage
 * reads are declared; the rest of the payload is ignored on purpose so a new
 * field GitHub adds can never change a verdict.
 */
export interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

/**
 * The parts of the CI pipeline a fork pull request can rewrite. Each one is
 * a reason the maintainer reads the PR before approving its workflow runs,
 * because a change there alters what executes on the runner or what the
 * scanners check. Everything else the PR changes runs inside the same test
 * and build steps every PR runs in.
 */
export type PipelineArea = 'ci' | 'installTime' | 'buildRecipes' | 'scannerConfig';

/** A changed path that fell into one of the pipeline areas. */
export interface PathHit {
  area: PipelineArea;
  path: string;
}

/**
 * The keys a `package.json` change touched that matter at install or build
 * time: every key under `scripts`, every key under `pnpm`, and
 * `packageManager`. Rendered as `scripts.postinstall`, `pnpm.overrides`, ...
 */
export interface PackageJsonChange {
  path: string;
  keys: string[];
}

/** Result of comparing the base and head `pnpm-lock.yaml`. */
export interface LockfileDiff {
  /** Package names present at head but at no version in base. */
  added: string[];
  /** Package names present in both whose version set differs. */
  bumped: number;
  /** Package names present in base but at no version in head. */
  removed: string[];
  /**
   * Head `packages:` entries whose resolution is anything but a plain
   * registry integrity, or whose version is not a bare semver: git, tarball
   * URL, local directory, `file:`. Each carries the raw resolution text.
   */
  nonRegistry: Array<{ key: string; resolution: string }>;
  /**
   * Importer specifiers new at head that point outside the registry:
   * `link:`, `file:`, git, http. The baseline `workspace:*` links are not
   * listed because they exist in base too.
   */
  newLocalSpecifiers: string[];
  overridesChanged: boolean;
  patchedDependenciesChanged: boolean;
}

/** One `flatpak/node-sources.json` entry the maintainer should look at. */
export interface SourceConcern {
  /** `executable` runs during the build; `foreign` downloads from an unknown host. */
  kind: 'executable' | 'foreign';
  /** Human label: dest-filename, url, or the first command. */
  label: string;
}

/** Result of comparing the base and head `flatpak/node-sources.json`. */
export interface SourcesDiff {
  /** Added `file`/`archive` entries with a checksum from a known host. */
  addedKnown: number;
  /** Added or changed data entries (inline JSON and the like). */
  changedData: number;
  removed: number;
  concerns: SourceConcern[];
}

/**
 * The full triage of one head commit. `problems` is non-empty whenever any
 * part of the analysis could not complete; the verdict is then
 * `unanalysable` regardless of what the completed parts found.
 */
export interface Triage {
  verdict: 'routine' | 'read-first' | 'unanalysable';
  headSha: string;
  author: string;
  totalFiles: number;
  hits: PathHit[];
  packageJson: PackageJsonChange[];
  lockfile: LockfileDiff | null;
  sources: SourcesDiff | null;
  problems: string[];
}
