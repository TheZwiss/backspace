export function deriveStartMinimizedFromArgs(args: string[] | undefined): boolean {
  if (!args) return false;
  return args.includes('--hidden');
}

/**
 * Extracts the executable path from a freedesktop .desktop file's Exec= line.
 * Handles double-quoted paths (which may contain spaces). Ignores commented
 * lines (leading #). Returns null if no Exec= line is present or parseable.
 *
 * The .desktop spec also defines field codes (%f, %u, etc.) and backslash
 * escapes; we don't need to honour them here because we only ever compare the
 * leading executable token, never re-execute it.
 */
export function parseExecPathFromDesktopFile(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (!line.startsWith('Exec=')) continue;
    const value = line.slice('Exec='.length).trimStart();
    if (!value) continue;
    if (value.startsWith('"')) {
      const end = value.indexOf('"', 1);
      if (end === -1) return null;
      return value.slice(1, end);
    }
    const sp = value.indexOf(' ');
    return sp === -1 ? value : value.slice(0, sp);
  }
  return null;
}

/**
 * Returns true iff the existing autostart entry's recorded executable path differs
 * from the current AppImage path (i.e., the AppImage moved and the entry is stale).
 *
 * A missing recorded path (recordedExecPath === null, i.e. the .desktop file does
 * not exist) is intentionally treated as "do nothing" — it represents the user
 * disabling autostart via their desktop environment's startup manager or removing
 * the file manually. Re-creating it would override OS-level user intent, which is
 * exactly the bug class this whole refactor exists to fix.
 */
export function shouldReapplyAppImage(
  currentAppImagePath: string | null,
  recordedExecPath: string | null,
): boolean {
  if (!currentAppImagePath) return false;
  if (!recordedExecPath) return false;
  return currentAppImagePath !== recordedExecPath;
}
