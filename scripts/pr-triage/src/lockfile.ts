import type { LockfileDiff } from './types.ts';

/**
 * A line-oriented reader for pnpm-lock.yaml v9.
 *
 * Not a YAML parser, on purpose: the package has no dependencies, and the
 * lockfile is machine-written with a fixed layout (two-space indent, one
 * `packages:` entry per key, an inline `resolution: {...}` flow map on a
 * single line). Anything that deviates from that layout is treated as a
 * parse failure rather than guessed at, because this reader feeds a
 * security verdict and a wrong "routine" is worse than a "could not
 * analyse". The layout assumptions are pinned by a test against the
 * repository's real lockfile.
 */

export interface Resolution {
  /** True only for `{integrity: ...}` with no other key and a bare semver version. */
  registry: boolean;
  /** The raw flow map, for the report. */
  text: string;
}

export interface ParsedLockfile {
  /** name -> version -> resolution */
  packages: Map<string, Map<string, Resolution>>;
  /**
   * Importer dependencies whose specifier or resolved version points outside
   * the registry: `link:`, `file:`, git, http. Formatted
   * `importer: name -> specifier (version)` so a diff can compare strings.
   */
  localSpecifiers: string[];
  overrides: string;
  patchedDependencies: string;
}

export type ParseResult = { ok: true } & ParsedLockfile | { ok: false; reason: string };

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const LOCAL_SPECIFIER_RE = /^(?:link:|file:|git\+|git:|github:|gitlab:|bitbucket:|https?:|\.|\/)/;
const LOCAL_VERSION_RE = /^(?:link:|file:|https?:|git\+)/;

/** Splits the file into top-level sections keyed by their unindented name. */
function sections(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z]+):(.*)$/.exec(line);
    if (m) {
      current = [];
      out.set(m[1]!, current);
      if (m[2]!.trim() !== '') current.push(m[2]!.trim());
      continue;
    }
    current?.push(line);
  }
  return out;
}

function unquote(key: string): string {
  if (key.length >= 2 && key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  return key;
}

/** `@scope/name@1.2.3` -> [`@scope/name`, `1.2.3`]; null when there is no version. */
function splitKey(key: string): [string, string] | null {
  const at = key.lastIndexOf('@');
  if (at <= 0) return null;
  return [key.slice(0, at), key.slice(at + 1)];
}

function flowMapKeys(text: string): string[] | null {
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const inner = text.slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => part.split(':')[0]!.trim());
}

function parsePackages(lines: string[]): Map<string, Map<string, Resolution>> | string {
  const packages = new Map<string, Map<string, Resolution>>();
  let currentKey: string | null = null;
  let currentResolution: string | null = null;

  const flush = (): string | null => {
    if (currentKey === null) return null;
    const split = splitKey(currentKey);
    if (split === null) return `packages entry without a version: ${currentKey}`;
    if (currentResolution === null) return `packages entry without a resolution: ${currentKey}`;
    const keys = flowMapKeys(currentResolution);
    if (keys === null) return `packages entry with a non-inline resolution: ${currentKey}`;
    const [name, version] = split;
    const registry = keys.length === 1 && keys[0] === 'integrity' && SEMVER_RE.test(version);
    let versions = packages.get(name);
    if (!versions) {
      versions = new Map();
      packages.set(name, versions);
    }
    versions.set(version, { registry, text: currentResolution });
    return null;
  };

  for (const line of lines) {
    const entry = /^  ([^\s].*):$/.exec(line);
    if (entry) {
      const err = flush();
      if (err) return err;
      currentKey = unquote(entry[1]!);
      currentResolution = null;
      continue;
    }
    const res = /^    resolution:(.*)$/.exec(line);
    if (res && currentKey !== null) {
      const value = res[1]!.trim();
      if (value === '') return `packages entry with a non-inline resolution: ${currentKey}`;
      currentResolution = value;
    }
  }
  const err = flush();
  if (err) return err;
  return packages;
}

function parseImporters(lines: string[]): string[] {
  const local: string[] = [];
  let importer: string | null = null;
  let dep: string | null = null;
  let specifier: string | null = null;
  let version: string | null = null;

  const flush = (): void => {
    if (importer !== null && dep !== null && specifier !== null) {
      const v = version ?? '';
      if (LOCAL_SPECIFIER_RE.test(specifier) || LOCAL_VERSION_RE.test(v)) {
        local.push(`${importer}: ${dep} -> ${specifier} (${v})`);
      }
    }
    dep = null;
    specifier = null;
    version = null;
  };

  for (const line of lines) {
    let m = /^  ([^\s].*):$/.exec(line);
    if (m) {
      flush();
      importer = unquote(m[1]!);
      continue;
    }
    m = /^      ([^\s].*):$/.exec(line);
    if (m) {
      flush();
      dep = unquote(m[1]!);
      continue;
    }
    m = /^        specifier: (.*)$/.exec(line);
    if (m) {
      specifier = unquote(m[1]!.trim());
      continue;
    }
    m = /^        version: (.*)$/.exec(line);
    if (m) {
      version = unquote(m[1]!.trim());
    }
  }
  flush();
  return local;
}

export function parseLockfile(text: string): ParseResult {
  const secs = sections(text);
  const version = secs.get('lockfileVersion')?.[0];
  if (version !== "'9.0'" && version !== '9.0') {
    return { ok: false, reason: `unsupported lockfileVersion ${version ?? '(missing)'}` };
  }
  const packageLines = secs.get('packages');
  if (!packageLines) return { ok: false, reason: 'no packages section' };
  const packages = parsePackages(packageLines);
  if (typeof packages === 'string') return { ok: false, reason: packages };

  return {
    ok: true,
    packages,
    localSpecifiers: parseImporters(secs.get('importers') ?? []),
    overrides: (secs.get('overrides') ?? []).join('\n').trim(),
    patchedDependencies: (secs.get('patchedDependencies') ?? []).join('\n').trim(),
  };
}

const EMPTY: ParsedLockfile = { packages: new Map(), localSpecifiers: [], overrides: '', patchedDependencies: '' };

export type DiffResult = { ok: true; value: LockfileDiff } | { ok: false; reason: string };

/** `base === null` means the lockfile did not exist at the merge base. */
export function diffLockfiles(base: string | null, head: string): DiffResult {
  let baseParsed: ParsedLockfile = EMPTY;
  if (base !== null) {
    const parsed = parseLockfile(base);
    if (!parsed.ok) return { ok: false, reason: `base: ${parsed.reason}` };
    baseParsed = parsed;
  }
  const headParsed = parseLockfile(head);
  if (!headParsed.ok) return { ok: false, reason: `head: ${headParsed.reason}` };

  const added: string[] = [];
  const removed: string[] = [];
  let bumped = 0;
  const nonRegistry: LockfileDiff['nonRegistry'] = [];

  for (const [name, versions] of headParsed.packages) {
    const baseVersions = baseParsed.packages.get(name);
    if (!baseVersions) added.push(name);
    else if (!sameKeys(baseVersions, versions)) bumped += 1;
    for (const [version, resolution] of versions) {
      if (!resolution.registry) nonRegistry.push({ key: `${name}@${version}`, resolution: resolution.text });
    }
  }
  for (const name of baseParsed.packages.keys()) {
    if (!headParsed.packages.has(name)) removed.push(name);
  }

  const baseLocal = new Set(baseParsed.localSpecifiers);
  const newLocalSpecifiers = headParsed.localSpecifiers.filter((s) => !baseLocal.has(s));

  return {
    ok: true,
    value: {
      added,
      bumped,
      removed,
      nonRegistry,
      newLocalSpecifiers,
      overridesChanged: baseParsed.overrides !== headParsed.overrides,
      patchedDependenciesChanged: baseParsed.patchedDependencies !== headParsed.patchedDependencies,
    },
  };
}

function sameKeys(a: Map<string, unknown>, b: Map<string, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) if (!b.has(key)) return false;
  return true;
}
