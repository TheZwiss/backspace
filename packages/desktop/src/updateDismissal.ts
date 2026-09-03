import { app } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * Remembers which update version the user has waved away.
 *
 * This lives in the main process, in userData, rather than in the renderer's
 * localStorage, because an available update is a property of the *installed
 * app*, not of whichever instance the user happens to be connected to. Storing
 * it per-origin would re-nag anyone who switches instances, and would lose the
 * dismissal entirely when site data is cleared.
 *
 * Only one version is remembered. Dismissing 1.0.4 silences 1.0.4 and nothing
 * else, so 1.0.5 surfaces normally when it ships. A dismissed update is never
 * lost: it stays reachable in Settings, Desktop, which is what makes dismissal
 * safe to offer at all.
 */

/** Upper bound on a stored version string. Feed values are not ours to trust. */
const MAX_VERSION_LENGTH = 64;

export function getUpdateStatePath(): string {
  return path.join(app.getPath('userData'), 'update-state.json');
}

/**
 * Reads a dismissed version out of the on-disk JSON.
 *
 * Anything that is not a plain non-empty string yields null, so a truncated,
 * hand-edited, or half-written file degrades to "nothing dismissed" rather than
 * throwing during startup. Showing one extra prompt is a far better failure than
 * refusing to boot.
 */
export function parseDismissalFile(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as { dismissedVersion?: unknown }).dismissedVersion;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_VERSION_LENGTH) return null;
  return trimmed;
}

export function loadDismissedVersion(filePath?: string): string | null {
  try {
    return parseDismissalFile(fs.readFileSync(filePath ?? getUpdateStatePath(), 'utf-8'));
  } catch {
    return null;
  }
}

export function setDismissedVersion(version: string, filePath?: string): void {
  const trimmed = version.trim().slice(0, MAX_VERSION_LENGTH);
  if (trimmed === '') return;
  try {
    fs.writeFileSync(
      filePath ?? getUpdateStatePath(),
      JSON.stringify({ dismissedVersion: trimmed }),
    );
  } catch (err) {
    // A failed write means the prompt reappears next launch. Annoying, not
    // broken, and not worth taking the app down for.
    console.error('[update] could not persist the dismissed version:', err);
  }
}

/**
 * Whether an offered version should stay hidden.
 *
 * Deliberately an exact match rather than a semver comparison. "Newer than what
 * I dismissed" and "not the thing I dismissed" only differ when a release is
 * withdrawn and an older one becomes latest again, and in that case surfacing
 * the prompt is the right answer anyway.
 */
export function isVersionDismissed(offered: string, dismissed: string | null): boolean {
  if (dismissed === null) return false;
  return offered.trim() === dismissed;
}
