import { app } from 'electron';
import { spawnSync } from 'child_process';
import path from 'path';

/**
 * Whether this build can install its own updates.
 *
 * `auto`     — electron-updater can download and apply an update in place.
 * `manual`   — it cannot, so the user must be sent to the download page instead.
 * `external` — the package manager owns updates; the app must not check or install.
 */
export type UpdateCapability = 'auto' | 'manual' | 'external';

/**
 * How the running macOS bundle is signed, as far as Squirrel.Mac cares.
 *
 * `adhoc`      — the designated requirement is a literal cdhash of this exact
 *                binary. No other build can ever satisfy it.
 * `identified` — the requirement is anchored to a certificate, so later builds
 *                signed by the same identity satisfy it.
 * `unknown`    — no requirement could be read (unsigned, codesign missing,
 *                unparseable output).
 */
export type SignatureClass = 'adhoc' | 'identified' | 'unknown';

/**
 * Classifies the designated requirement printed by `codesign -d -r- <bundle>`.
 *
 * This is the property that decides whether macOS auto-update can ever work.
 * Squirrel.Mac validates a staged update against the *running* app's designated
 * requirement before installing it. An ad-hoc signature has no stable identity,
 * so codesign derives the requirement from the binary's own code directory hash:
 *
 *   # designated => cdhash H"4a9e49fe20f82802702a4e9d752748e990909659"
 *
 * A different build has a different cdhash, so it cannot satisfy that. Not
 * "usually fails". It is arithmetically impossible for every future release.
 *
 * A Developer ID signed bundle instead reports something anchored to the
 * certificate, which every later build from the same team satisfies:
 *
 *   # designated => identifier "com.backspace.desktop" and anchor apple generic
 *     and certificate leaf[subject.OU] = "TEAMID"
 *
 * Universal binaries report one cdhash term per slice, joined by `or`, so the
 * check is "mentions cdhash and nothing certificate-shaped" rather than an
 * exact-match on a single term.
 */
export function classifyDesignatedRequirement(codesignOutput: string): SignatureClass {
  if (!codesignOutput) return 'unknown';

  const marker = 'designated =>';
  const idx = codesignOutput.indexOf(marker);
  if (idx === -1) return 'unknown';

  // The requirement can wrap across lines. Take everything after the marker up
  // to the next line that starts a new codesign field (`Something=value`), which
  // is how codesign delimits its -d output.
  const rest = codesignOutput.slice(idx + marker.length);
  const lines = rest.split(/\r?\n/);
  const parts: string[] = [lines[0] ?? ''];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '') break;
    if (/^[A-Za-z][A-Za-z0-9]*=/.test(trimmed)) break;
    parts.push(line);
  }

  const requirement = parts.join(' ').trim().toLowerCase();
  if (requirement === '') return 'unknown';

  // Anchored to a certificate of some kind. Later builds from the same identity
  // satisfy it, so Squirrel can install them.
  if (requirement.includes('anchor ') || requirement.includes('certificate')) {
    return 'identified';
  }

  // Only cdhash terms. This is the ad-hoc case.
  if (requirement.includes('cdhash')) return 'adhoc';

  return 'unknown';
}

/**
 * Resolves the .app bundle root from the main executable path.
 *
 * `/Applications/Backspace.app/Contents/MacOS/Backspace`
 *   -> `/Applications/Backspace.app`
 *
 * Exported for tests; the shape is fixed by the macOS bundle layout.
 */
export function macAppBundlePath(execPath: string): string {
  // This function always receives a macOS path, including when its unit tests
  // run on Windows. Use POSIX semantics explicitly so the result is independent
  // of the machine running the test suite.
  return path.posix.resolve(path.posix.dirname(execPath), '..', '..');
}

/**
 * Runs `codesign -d -r-` against the bundle and returns its combined output.
 *
 * codesign writes its -d report to stderr, and prints a usable requirement even
 * on some non-zero exits, so both streams are returned and the exit status is
 * deliberately ignored. A spawn failure yields an empty string, which
 * classifies as `unknown`, which resolves to `manual`.
 */
function readDesignatedRequirement(bundlePath: string): string {
  try {
    const result = spawnSync('/usr/bin/codesign', ['-d', '-r-', bundlePath], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    if (result.error) return '';
    return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  } catch {
    return '';
  }
}

let cached: UpdateCapability | null = null;

/**
 * Whether this build can install its own updates. Computed once, then cached.
 *
 * Every uncertain path resolves to `manual` on purpose. A download link always
 * works, so guessing "manual" wrongly costs the user one extra click, while
 * guessing "auto" wrongly gives them a button that does nothing, which is the
 * exact defect this module exists to remove.
 *
 * Nothing here hardcodes "macOS cannot update". It measures the signature, so
 * the day CI signs with a Developer ID, this returns `auto` with no code change.
 */
export function getUpdateCapability(): UpdateCapability {
  if (cached !== null) return cached;

  // Flatpak deployments are immutable. Updates are installed atomically by
  // Flatpak, so neither electron-updater nor a manual GitHub download is an
  // appropriate action inside the sandbox.
  if (process.env.FLATPAK_ID) {
    cached = 'external';
    return cached;
  }

  // A dev build has no update feed and must never offer to install anything.
  if (!app.isPackaged) {
    cached = 'manual';
    return cached;
  }

  // NSIS and AppImage both apply unsigned updates without complaint.
  if (process.platform !== 'darwin') {
    cached = 'auto';
    return cached;
  }

  const bundlePath = macAppBundlePath(process.execPath);
  const signatureClass = classifyDesignatedRequirement(readDesignatedRequirement(bundlePath));
  cached = signatureClass === 'identified' ? 'auto' : 'manual';

  console.log(
    `[update] capability=${cached} (macOS signature classified as ${signatureClass})`,
  );
  return cached;
}

/** Test seam. Clears the memoised value so each case probes fresh. */
export function resetUpdateCapabilityForTest(): void {
  cached = null;
}
