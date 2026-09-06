import type { SourceConcern, SourcesDiff } from './types.ts';

/**
 * Compares two versions of `flatpak/node-sources.json`.
 *
 * The file is a flatpak-builder source list, and flatpak-builder executes
 * parts of it: `shell` and `script` entries carry commands, `inline`
 * entries are written to disk and some of them (a Python program, shell
 * helpers) are then run by the build. `flatpak.yml` builds from this file
 * on every PR that touches `flatpak/**`, inside a privileged container, so
 * an executable entry a fork adds or edits is code that runs on the runner.
 *
 * Most of the file, by count, is `file` entries downloading npm tarballs
 * from the registry with a sha512. Those are data. The generator also
 * emits Electron binaries from GitHub releases and Node headers from
 * electronjs.org, both with a sha256; a routine Electron bump replaces
 * those, so they are known hosts here, pinned to the exact URL prefixes the
 * generator uses.
 *
 * Entries are compared by their full canonical JSON, so an edit shows up as
 * one removal and one addition. That is enough: the report only needs to
 * know what is new at head and whether anything went away.
 */

type Entry = Record<string, unknown>;

const KNOWN_DOWNLOADS: Array<(url: URL) => boolean> = [
  (u) => u.host === 'registry.npmjs.org',
  (u) => u.host === 'github.com' && u.pathname.startsWith('/electron/electron/releases/download/'),
  (u) => u.host === 'www.electronjs.org' && u.pathname.startsWith('/headers/'),
];

const SCRIPT_NAME_RE = /\.(?:py|sh|bash|js|mjs|cjs|rb|pl)$/i;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Entry;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

function parse(text: string | null, side: string): Entry[] | { error: string } {
  if (text === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: `${side} node-sources.json is not valid JSON` };
  }
  if (!Array.isArray(value)) return { error: `${side} node-sources.json is not an array` };
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { error: `${side} node-sources.json has a non-object entry` };
    }
    if (typeof (entry as Entry)['type'] !== 'string') {
      return { error: `${side} node-sources.json has an entry without a type` };
    }
  }
  return value as Entry[];
}

function str(entry: Entry, key: string): string | null {
  const v = entry[key];
  return typeof v === 'string' ? v : null;
}

function hasChecksum(entry: Entry): boolean {
  return ['sha512', 'sha256', 'sha1', 'md5'].some((k) => typeof entry[k] === 'string' && (entry[k] as string).length > 0);
}

function label(entry: Entry): string {
  const type = str(entry, 'type') ?? 'unknown';
  const commands = entry['commands'];
  const first =
    str(entry, 'dest-filename') ??
    str(entry, 'url') ??
    str(entry, 'path') ??
    (Array.isArray(commands) && typeof commands[0] === 'string' ? commands[0] : null) ??
    str(entry, 'dest') ??
    '(unnamed)';
  return `${type}: ${first}`;
}

type Kind = 'known' | 'data' | SourceConcern['kind'];

function classify(entry: Entry): Kind {
  const type = str(entry, 'type');
  if (type === 'file' || type === 'archive') {
    const url = str(entry, 'url');
    if (url === null) return 'foreign';
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'foreign';
    }
    if (parsed.protocol !== 'https:') return 'foreign';
    if (!KNOWN_DOWNLOADS.some((ok) => ok(parsed))) return 'foreign';
    return hasChecksum(entry) ? 'known' : 'foreign';
  }
  if (type === 'inline') {
    const contents = str(entry, 'contents') ?? '';
    const name = str(entry, 'dest-filename') ?? '';
    if (contents.startsWith('#!') || SCRIPT_NAME_RE.test(name)) return 'executable';
    return 'data';
  }
  return 'executable';
}

export type SourcesResult = { ok: true; value: SourcesDiff } | { ok: false; reason: string };

export function diffSources(base: string | null, head: string): SourcesResult {
  const baseEntries = parse(base, 'base');
  if (!Array.isArray(baseEntries)) return { ok: false, reason: baseEntries.error };
  const headEntries = parse(head, 'head');
  if (!Array.isArray(headEntries)) return { ok: false, reason: headEntries.error };

  const baseSet = new Set(baseEntries.map(canonical));
  const headSet = new Set(headEntries.map(canonical));

  const value: SourcesDiff = { addedKnown: 0, changedData: 0, removed: 0, concerns: [] };
  for (const key of baseSet) if (!headSet.has(key)) value.removed += 1;

  for (const entry of headEntries) {
    if (baseSet.has(canonical(entry))) continue;
    const kind = classify(entry);
    if (kind === 'known') value.addedKnown += 1;
    else if (kind === 'data') value.changedData += 1;
    else value.concerns.push({ kind, label: kind === 'foreign' ? (str(entry, 'url') ?? label(entry)) : label(entry) });
  }
  return { ok: true, value };
}
