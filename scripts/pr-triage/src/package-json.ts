/**
 * Compares two versions of a `package.json` for the keys that decide what
 * executes at install or build time.
 *
 * - `scripts.*`: `ci.yml` runs `pnpm build`, `pnpm -r test` and two filtered
 *   scripts by name, so any script body change is code the runner executes.
 *   Lifecycle scripts (`postinstall` and friends) additionally run during
 *   `pnpm install`. Both are reported the same way, by key.
 * - `pnpm.*`: `onlyBuiltDependencies` and its siblings gate which
 *   dependencies' own install scripts run (pnpm 10 skips them all by
 *   default), `overrides` can substitute any package, `patchedDependencies`
 *   applies a patch file. Every sub-key is reported.
 * - `packageManager`: selects the pnpm version Corepack installs.
 *
 * A dependency bump touches none of these and is not reported.
 */

export type PackageJsonDiff = { ok: true; keys: string[] } | { ok: false; reason: string };

type JsonObject = Record<string, unknown>;

function parseObject(text: string | null, side: 'base' | 'head'): JsonObject | null | { error: string } {
  if (text === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${side} package.json is not valid JSON` };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: `${side} package.json is not an object` };
  }
  return value as JsonObject;
}

function isError(v: unknown): v is { error: string } {
  return typeof v === 'object' && v !== null && 'error' in v && typeof (v as { error: unknown }).error === 'string';
}

function objectAt(obj: JsonObject | null, key: string): JsonObject {
  if (obj === null) return {};
  const value = obj[key];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as JsonObject;
}

/**
 * Structural equality with key order ignored, so a reformatted file is not a
 * change. Arrays keep their order: an allowlist that lists the same packages
 * in another order is the same allowlist, but a script array is not, and
 * telling the two apart is not worth the ambiguity.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as JsonObject;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function changedSubKeys(base: JsonObject, head: JsonObject): string[] {
  const keys: string[] = [];
  for (const key of Object.keys(base)) {
    if (!(key in head)) keys.push(key);
    else if (canonical(base[key]) !== canonical(head[key])) keys.push(key);
  }
  for (const key of Object.keys(head)) {
    if (!(key in base)) keys.push(key);
  }
  return keys;
}

/**
 * `base` or `head` being `null` means the file does not exist on that side.
 * Any parse failure on either side fails closed: the caller must not treat
 * the file as routine.
 */
export function diffPackageJson(path: string, base: string | null, head: string | null): PackageJsonDiff {
  const baseObj = parseObject(base, 'base');
  if (isError(baseObj)) return { ok: false, reason: `${path}: ${baseObj.error}` };
  const headObj = parseObject(head, 'head');
  if (isError(headObj)) return { ok: false, reason: `${path}: ${headObj.error}` };

  const keys: string[] = [];
  for (const key of changedSubKeys(objectAt(baseObj, 'scripts'), objectAt(headObj, 'scripts'))) {
    keys.push(`scripts.${key}`);
  }
  for (const key of changedSubKeys(objectAt(baseObj, 'pnpm'), objectAt(headObj, 'pnpm'))) {
    keys.push(`pnpm.${key}`);
  }
  const basePm = baseObj?.['packageManager'];
  const headPm = headObj?.['packageManager'];
  if (canonical(basePm) !== canonical(headPm)) keys.push('packageManager');

  return { ok: true, keys };
}
