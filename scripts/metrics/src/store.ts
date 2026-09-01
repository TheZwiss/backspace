import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseCsv, formatCsv, parseNdjson, formatNdjson } from './series.ts';
import type { DimensionRow, IsoDate } from './types.ts';

/** Collector health, written to `meta.json` at the root of the data branch. */
export interface Meta {
  last_run: string;
  last_success: string | null;
  error: string | null;
  /** Keys are exact file paths, e.g. `traffic/views.csv`. */
  series_last_date: Record<string, IsoDate>;
}

export interface Store {
  readCsv(file: string): Record<string, string>[];
  writeCsv(
    file: string,
    header: readonly string[],
    rows: ReadonlyArray<Record<string, string | number>>,
  ): void;
  readNdjson(file: string): DimensionRow[];
  writeNdjson(file: string, rows: readonly DimensionRow[]): void;
  readMeta(): Meta | null;
  writeMeta(meta: Meta): void;
}

/**
 * Node's fs error objects carry `code` but TypeScript only knows `Error`.
 * Narrows to the shape this module actually inspects, without resorting to
 * `any`.
 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as Record<string, unknown>)['code'];
  return typeof code === 'string' ? code : undefined;
}

/**
 * Validates that a decoded JSON value is a well-formed `Meta` and narrows it
 * to that type.
 *
 * `readMeta` is the only read path in this module whose payload isn't
 * already validated by a `series.ts` parser, so without this check a
 * truncated or hand-edited `meta.json` — missing `last_success`, or a
 * `series_last_date` that decoded to a string instead of an object — would
 * be blindly cast and start handing `undefined` or the wrong shape to every
 * caller that trusts `Meta`. `series_last_date`'s values are checked for
 * `string`, not further validated as `IsoDate` (a `YYYY-MM-DD` shape check
 * duplicated from nowhere else in this package): a malformed date here would
 * poison a single series' resume point, not falsify data already written to
 * a CSV/NDJSON file, so it fails on the next inconsistency rather than
 * requiring an extra check with no shared home.
 */
function parseMeta(value: unknown): Meta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('readMeta: meta.json does not decode to a JSON object');
  }
  const { last_run, last_success, error, series_last_date } = value as Record<string, unknown>;
  if (typeof last_run !== 'string') {
    throw new Error('readMeta: meta.json has a missing or non-string "last_run"');
  }
  if (last_success !== null && typeof last_success !== 'string') {
    throw new Error('readMeta: meta.json has a "last_success" that is neither null nor a string');
  }
  if (error !== null && typeof error !== 'string') {
    throw new Error('readMeta: meta.json has an "error" that is neither null nor a string');
  }
  if (
    typeof series_last_date !== 'object' ||
    series_last_date === null ||
    Array.isArray(series_last_date)
  ) {
    throw new Error('readMeta: meta.json has a "series_last_date" that is not a JSON object');
  }
  for (const [key, entry] of Object.entries(series_last_date)) {
    if (typeof entry !== 'string') {
      throw new Error(`readMeta: meta.json "series_last_date.${key}" is not a string`);
    }
  }
  return {
    last_run,
    last_success,
    error,
    series_last_date: series_last_date as Record<string, IsoDate>,
  };
}

/**
 * Resolves a `file` argument against `dataDir` and rejects any result that
 * would land outside it.
 *
 * `file` values reach this module from the orchestrator (Task 7), driven by
 * series names like `traffic/views.csv`. A value containing `../` segments —
 * or a value that is itself an absolute path, which `path.resolve` treats as
 * overriding `dataDir` entirely — would otherwise let a caller read or write
 * anywhere on disk that this process has permission to touch. Since this
 * store is the only module that touches the filesystem, this is the one
 * place that boundary can be enforced; every read and write funnels through
 * it rather than trusting `path.join` to keep the result contained, which it
 * does not.
 */
function resolve(dataDir: string, file: string): string {
  const root = path.resolve(dataDir);
  const full = path.resolve(root, file);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`Store: "${file}" resolves outside the data directory`);
  }
  return full;
}

export function createStore(dataDir: string): Store {
  /**
   * Reads a file's full text, or `null` if it does not exist yet — the only
   * two outcomes a caller may treat as "no data" vs. "data present".
   *
   * Tells absence apart from an unreadable file using the error's `code`
   * rather than by checking existence first: an
   * `existsSync`-then-`readFileSync` pair has a race (the file can be
   * deleted between the two calls) and, more importantly, would make an
   * `EISDIR` or `EACCES` failure indistinguishable from absence if the catch
   * swallowed every error alike. Only `ENOENT` — the file genuinely is not
   * there — collapses to `null`, which callers read as first run,
   * legitimately empty. Every other failure (wrong permissions, the path is
   * a directory, a symlink loop) propagates as a thrown error, because this
   * archive is the only surviving copy of data GitHub deletes after 14 days
   * and a swallowed read error would silently persist an empty series over
   * real history on the very next write.
   */
  function read(file: string): string | null {
    const full = resolve(dataDir, file);
    try {
      return readFileSync(full, 'utf8');
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') return null;
      throw new Error(`Store: failed to read "${file}"`, { cause });
    }
  }

  /**
   * Writes `text` to `file`, creating parent directories as needed.
   *
   * Writes to a sibling temp file in the same directory and `renameSync`s it
   * over the target rather than calling `writeFileSync` on the target
   * directly. A direct write is not atomic: if the process is killed (OOM,
   * `SIGKILL`, power loss) partway through, the target is left holding a
   * truncated prefix of the new content, indistinguishable on the next run
   * from a genuine (if malformed) file — `readCsv`/`readNdjson` would throw
   * on it as corruption, but the ORIGINAL, previously-good content is gone
   * either way, and for data GitHub has already deleted upstream that loss
   * is permanent. A `rename` within the same directory (same filesystem) is
   * atomic on POSIX and on NTFS: the target either still holds the old
   * complete content or holds the new complete content, never a mix, no
   * matter when the process dies. The temp name includes random bytes so
   * concurrent writes to different files (or a crash-and-rerun before
   * cleanup) never collide on one temp path. On failure, the temp file is
   * best-effort unlinked so a partial temp artifact doesn't accumulate next
   * to the target — the target itself is untouched since the rename never
   * happened.
   */
  function write(file: string, text: string): void {
    const full = resolve(dataDir, file);
    mkdirSync(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      writeFileSync(tmp, text, 'utf8');
      renameSync(tmp, full);
    } catch (cause) {
      try {
        unlinkSync(tmp);
      } catch {
        // Best-effort cleanup only; the original error below is the one that matters.
      }
      throw cause;
    }
  }

  return {
    readCsv(file) {
      const text = read(file);
      return text === null ? [] : parseCsv(text);
    },
    writeCsv(file, header, rows) {
      write(file, formatCsv(header, rows));
    },
    readNdjson(file) {
      const text = read(file);
      return text === null ? [] : parseNdjson(text);
    },
    writeNdjson(file, rows) {
      write(file, formatNdjson(rows));
    },
    readMeta() {
      const text = read('meta.json');
      if (text === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (cause) {
        throw new Error('readMeta: meta.json is not valid JSON', { cause });
      }
      return parseMeta(value);
    },
    writeMeta(meta) {
      write('meta.json', JSON.stringify(meta, null, 2) + '\n');
    },
  };
}
