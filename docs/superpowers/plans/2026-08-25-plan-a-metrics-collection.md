# Metrics Collection Pipeline (WS1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily GitHub Action that snapshots this repo's ephemeral traffic metrics into an orphan `metrics-data` branch as CSV/NDJSON, retained indefinitely, plus a one-shot backfill of reconstructable history.

**Architecture:** A zero-runtime-dependency TypeScript package (`scripts/metrics`) executed directly by Node 24's native type stripping, so there is no build step. Parsing and upsert logic are pure functions unit-tested against fixtures; the API client is injected so no test touches the network. Data is committed to an orphan branch, isolating ~365 commits/year from `main`.

**Tech Stack:** TypeScript 5.8 (strict, `erasableSyntaxOnly`), Node 24, vitest 4, GitHub Actions, `gh` CLI. No runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-08-25-repo-metrics-design.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **Zero runtime dependencies.** `src/` imports only `node:` builtins and global `fetch`. Enforced by a test (Task 2).
- **`import type` is mandatory** for type-only imports. Without it Node throws `SyntaxError` at runtime while `tsc` stays green. (spec 3.7)
- **Relative imports carry the `.ts` extension**: `import './series.ts'`, never `'./series'`. (spec 3.7)
- **Forbidden syntax:** enums, namespaces with runtime code, parameter properties, import aliases, decorators. Enforced by `erasableSyntaxOnly`. (spec 3.7)
- **Traffic is required; releases and stats are optional.** A failed required fetch aborts the entire write. A failed optional fetch skips, leaving the prior value. (spec 4.4, 5.2)
- **Backfill is write-if-absent.** It may never overwrite a date that already has a row. (spec 5.2)
- **No zero-filling.** A missing date means "not collected", never "zero". (spec 5.2)
- **Never assume the traffic window ends today.** The last bucket is frequently yesterday, non-deterministically. (spec 5.2)
- **A persistent HTTP 202 is a skip, never a zero.** (spec 6.1)
- **Workflows:** header comment explaining *why*, `step-security/harden-runner` with `egress-policy: audit`, every `uses:` pinned to a full SHA with a trailing `# vX.Y.Z`. (spec 4)
- **Repo slug** is read from `github.repository`, never hardcoded. (spec 10)
- **Commit identity:** the workflow commits as `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`.

### Deviation from spec 3.6, deliberate

Spec 3.6 specifies the package `test` script as `tsc --noEmit && vitest run && node --experimental-strip-types vendor-check.ts`. `vendor-check.ts` belongs to WS3 — it guards the vendored uPlot copy, which does not exist yet. This plan sets `test` to `tsc --noEmit && vitest run`; **WS3 appends the vendor-check clause.** Recorded here so the WS3 implementer knows it is their job.

---

## File Structure

| File | Responsibility |
|---|---|
| `pnpm-workspace.yaml` | Add `scripts/metrics` to the workspace (modify) |
| `.gitignore` | Ignore `.metrics-data/` (modify) |
| `scripts/metrics/package.json` | Package manifest, `test` script, TS 5.8 |
| `scripts/metrics/tsconfig.json` | Strict + `erasableSyntaxOnly` + `.ts` imports |
| `scripts/metrics/src/types.ts` | Row shapes. Types only, no runtime values |
| `scripts/metrics/src/series.ts` | CSV/NDJSON parse, format, upsert. Pure functions |
| `scripts/metrics/src/github.ts` | API client: auth, pagination, 202 retry. Injectable `fetch` |
| `scripts/metrics/src/store.ts` | Filesystem read/write of the data directory |
| `scripts/metrics/src/collect.ts` | Daily orchestration and atomicity. Injectable client |
| `scripts/metrics/src/backfill.ts` | Historical reconstruction, write-if-absent |
| `scripts/metrics/src/no-runtime-deps.test.ts` | Static guard on imports |
| `.github/workflows/metrics.yml` | Daily cron |
| `.github/workflows/backfill.yml` | `workflow_dispatch` only |
| `docs/systems/metrics.md` | Subsystem doc |
| `CLAUDE.md` | Subsystem table + monorepo structure rows (modify) |
| `docs/systems/security-scanning.md` | Two maintainer-checklist entries (modify) |

---

## Task 1: Package scaffold and workspace wiring

**Files:**
- Modify: `pnpm-workspace.yaml`
- Create: `scripts/metrics/package.json`
- Create: `scripts/metrics/tsconfig.json`
- Create: `scripts/metrics/src/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `@backspace/metrics` package, picked up by `pnpm -r test`. Types `IsoDate`, `TrafficPoint`, `CountPoint`, `ReleaseRow`, `RepoPoint`, `DimensionRow` for every later task.

- [ ] **Step 1: Add the package to the workspace**

Modify `pnpm-workspace.yaml` to read exactly:

```yaml
packages:
  - "packages/*"
  # Repo tooling that needs typecheck + tests, listed explicitly rather than as
  # `scripts/*` so unrelated one-off scripts (gen-icons.mjs) stay out of the
  # workspace. See docs/systems/metrics.md.
  - "scripts/metrics"
```

- [ ] **Step 2: Create the package manifest**

Create `scripts/metrics/package.json`:

```json
{
  "name": "@backspace/metrics",
  "version": "1.0.0",
  "private": true,
  "license": "AGPL-3.0-only",
  "author": "Jannis Braun",
  "type": "module",
  "engines": {
    "node": ">=22.18"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "tsc --noEmit && vitest run"
  },
  "devDependencies": {
    "typescript": "^5.8.0",
    "vitest": "^4.0.18"
  }
}
```

Note the TypeScript floor. Every other workspace pins `^5.4.0`, but `erasableSyntaxOnly` did not land until 5.8, so this package needs its own newer copy. pnpm handles the divergence.

- [ ] **Step 3: Create the tsconfig**

Create `scripts/metrics/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "NodeNext",
    "moduleResolution": "nodenext",
    "lib": ["ES2023"],
    "types": ["node"],
    "noEmit": true,
    "declaration": false,
    "declarationMap": false,
    "sourceMap": false,
    "allowImportingTsExtensions": true,
    "erasableSyntaxOnly": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"]
}
```

`erasableSyntaxOnly` and `verbatimModuleSyntax` are the whole point: they make `tsc --noEmit` reject the constructs Node's type stripper cannot handle, so the failure surfaces in CI instead of at 03:00 in the cron. `allowImportingTsExtensions` permits the mandatory `.ts` import suffixes and requires `noEmit`, which is set. `declaration`, `declarationMap`, and `sourceMap` are turned back off because `tsconfig.base.json` enables them and they are illegal alongside `noEmit`.

- [ ] **Step 4: Create the shared types**

Create `scripts/metrics/src/types.ts`:

```ts
/** A UTC calendar date, `YYYY-MM-DD`. */
export type IsoDate = string;

/** One day of views or clones. */
export interface TrafficPoint {
  date: IsoDate;
  count: number;
  uniques: number;
}

/** One day of a cumulative counter (stars, forks, contributors). */
export interface CountPoint {
  date: IsoDate;
  total: number;
}

/** A published release. `date` is the UTC day of `published_at`. */
export interface ReleaseRow {
  date: IsoDate;
  tag: string;
  name: string;
}

/** One day of repo-object counters. */
export interface RepoPoint {
  date: IsoDate;
  subscribers: number;
  open_issues: number;
  downloads_total: number;
}

/**
 * One row of a trailing-14-day aggregate, tagged with the day it was fetched.
 * `dimension` is the referrer host or the content path.
 */
export interface DimensionRow {
  snapshot_date: IsoDate;
  dimension: string;
  title: string;
  count: number;
  uniques: number;
}
```

This file must contain **no runtime values** — no `const`, no `enum`, no class. Consumers import from it with `import type`.

- [ ] **Step 5: Install and verify the workspace picks it up**

Run: `pnpm install`

Then run: `pnpm --filter @backspace/metrics exec tsc --noEmit`
Expected: exits 0, no output.

Then run: `pnpm -r test 2>&1 | grep -c "@backspace/metrics"`
Expected: at least `1`. The package appears in the recursive run and fails for having no test files; that is Task 2's job.

- [ ] **Step 6: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml scripts/metrics/package.json scripts/metrics/tsconfig.json scripts/metrics/src/types.ts
git commit -m "chore(metrics): scaffold @backspace/metrics workspace package"
```

---

## Task 2: Zero-runtime-dependency guard

**Files:**
- Create: `scripts/metrics/src/no-runtime-deps.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a standing guard. Every later task that adds a `src/*.ts` file is covered automatically.

This task comes before the modules it guards so the constraint cannot silently regress as they are written.

- [ ] **Step 1: Write the test**

Create `scripts/metrics/src/no-runtime-deps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/** Matches the module specifier of any static import or re-export. */
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g;

describe('collector source constraints', () => {
  it('has source files to check', () => {
    expect(sourceFiles().length).toBeGreaterThan(0);
  });

  it('imports nothing outside node: builtins and relative paths', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(srcDir, file), 'utf8');
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1];
        if (spec === undefined) continue;
        const ok = spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../');
        if (!ok) offenders.push(`${file} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('uses the .ts extension on every relative import', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(srcDir, file), 'utf8');
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1];
        if (spec === undefined) continue;
        if ((spec.startsWith('./') || spec.startsWith('../')) && !spec.endsWith('.ts')) {
          offenders.push(`${file} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports types with the type keyword so Node can erase them', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(path.join(srcDir, file), 'utf8');
      for (const match of text.matchAll(IMPORT_RE)) {
        const spec = match[1];
        if (spec === undefined) continue;
        if (!spec.endsWith('types.ts')) continue;
        if (!/import\s+type\b/.test(match[0])) {
          offenders.push(`${file} -> ${spec} (missing import type)`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

The fourth test is the important one. `types.ts` holds only types, so a value-import of it is a runtime `SyntaxError` under Node's stripper, and that failure would otherwise appear for the first time in the cron.

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS, 4 tests. Only `types.ts` exists so far and it imports nothing, so all four are trivially green. If instead it errors with "No test files found", vitest did not install — re-run `pnpm install`.

- [ ] **Step 3: Verify the guard actually catches a violation**

A guard that has never been seen to fail is not a guard. Temporarily add this line to the top of `scripts/metrics/src/types.ts`:

```ts
import { readFileSync } from 'fs';
```

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — "imports nothing outside node: builtins" reports `types.ts -> fs`.

Now delete that line and re-run.
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/metrics/src/no-runtime-deps.test.ts
git commit -m "test(metrics): guard collector against runtime deps and unerasable imports"
```

---

## Task 3: CSV series — parse, format, upsert

**Files:**
- Create: `scripts/metrics/src/series.ts`
- Create: `scripts/metrics/src/series.test.ts`

**Interfaces:**
- Consumes: `IsoDate` from `types.ts`.
- Produces:
  - `parseCsv(text: string): Record<string, string>[]`
  - `formatCsv(header: readonly string[], rows: ReadonlyArray<Record<string, string | number>>): string`
  - `upsertByDate<T extends { date: IsoDate }>(existing: readonly T[], incoming: readonly T[], mode: 'overwrite' | 'if-absent'): T[]`

- [ ] **Step 1: Write the failing tests**

Create `scripts/metrics/src/series.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseCsv, formatCsv, upsertByDate } from './series.ts';

describe('parseCsv', () => {
  it('parses a header and rows into keyed records', () => {
    const text = 'date,count,uniques\n2026-08-01,10,4\n2026-08-02,12,5\n';
    expect(parseCsv(text)).toEqual([
      { date: '2026-08-01', count: '10', uniques: '4' },
      { date: '2026-08-02', count: '12', uniques: '5' },
    ]);
  });

  it('returns an empty array for empty or header-only input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('date,count\n')).toEqual([]);
  });

  it('round-trips quoted fields containing commas and quotes', () => {
    const rows = [{ snapshot_date: '2026-08-01', title: 'Backspace: chat, voice and "video"' }];
    const text = formatCsv(['snapshot_date', 'title'], rows);
    expect(parseCsv(text)).toEqual([
      { snapshot_date: '2026-08-01', title: 'Backspace: chat, voice and "video"' },
    ]);
  });
});

describe('formatCsv', () => {
  it('emits a header, sorts by the first column, and ends with a newline', () => {
    const text = formatCsv(['date', 'total'], [
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-01', total: 1 },
    ]);
    expect(text).toBe('date,total\n2026-08-01,1\n2026-08-02,2\n');
  });
});

describe('upsertByDate', () => {
  const existing = [
    { date: '2026-08-01', total: 1 },
    { date: '2026-08-02', total: 2 },
  ];

  it('overwrite mode: fetched values win on collision', () => {
    const result = upsertByDate(existing, [{ date: '2026-08-02', total: 99 }], 'overwrite');
    expect(result).toEqual([
      { date: '2026-08-01', total: 1 },
      { date: '2026-08-02', total: 99 },
    ]);
  });

  it('overwrite mode: overlapping windows produce no duplicates', () => {
    const incoming = [
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-03', total: 3 },
    ];
    const result = upsertByDate(existing, incoming, 'overwrite');
    expect(result.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  });

  it('overwrite mode: re-running with identical input is byte-identical', () => {
    const once = upsertByDate(existing, existing, 'overwrite');
    const twice = upsertByDate(once, existing, 'overwrite');
    expect(formatCsv(['date', 'total'], twice)).toBe(formatCsv(['date', 'total'], once));
  });

  it('if-absent mode: never overwrites a date that already has a row', () => {
    const result = upsertByDate(existing, [{ date: '2026-08-02', total: 99 }], 'if-absent');
    expect(result).toEqual(existing);
  });

  it('if-absent mode: fills only genuinely missing dates', () => {
    const result = upsertByDate(existing, [
      { date: '2026-08-02', total: 99 },
      { date: '2026-08-03', total: 3 },
    ], 'if-absent');
    expect(result).toEqual([
      { date: '2026-08-01', total: 1 },
      { date: '2026-08-02', total: 2 },
      { date: '2026-08-03', total: 3 },
    ]);
  });

  it('leaves gaps absent rather than zero-filling them', () => {
    const result = upsertByDate([], [
      { date: '2026-08-01', total: 1 },
      { date: '2026-08-05', total: 5 },
    ], 'overwrite');
    expect(result.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-05']);
  });

  it('sorts output ascending regardless of input order', () => {
    const result = upsertByDate([], [
      { date: '2026-08-09', total: 9 },
      { date: '2026-08-01', total: 1 },
    ], 'overwrite');
    expect(result.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-09']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — `Failed to resolve import "./series.ts"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/metrics/src/series.ts`:

```ts
import type { IsoDate } from './types.ts';

/** Quotes a CSV field only when it contains a comma, quote, or newline. */
function quote(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Splits one CSV line, honouring quoted fields and doubled escape quotes. */
function splitLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char ?? '';
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char ?? '';
    }
  }
  fields.push(current);
  return fields;
}

export function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter((line) => line.length > 0);
  const headerLine = lines.shift();
  if (headerLine === undefined) return [];
  const header = splitLine(headerLine);
  return lines.map((line) => {
    const fields = splitLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, index) => {
      row[key] = fields[index] ?? '';
    });
    return row;
  });
}

export function formatCsv(
  header: readonly string[],
  rows: ReadonlyArray<Record<string, string | number>>,
): string {
  const sortKey = header[0];
  if (sortKey === undefined) throw new Error('formatCsv requires at least one header column');
  const sorted = [...rows].sort((a, b) =>
    String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')),
  );
  const body = sorted.map((row) => header.map((key) => quote(String(row[key] ?? ''))).join(','));
  return [header.join(','), ...body].join('\n') + '\n';
}

/**
 * Merges `incoming` into `existing`, keyed by `date`, returning a
 * date-ascending array.
 *
 * `overwrite` — the fetched value wins. Used by the daily collector, where the
 * API is authoritative and re-fetching a 14-day window must be idempotent.
 *
 * `if-absent` — an existing row is never replaced. Used by backfill, which
 * reconstructs history from `starred_at` and therefore cannot see stars that
 * were later removed. Overwriting a measured value with a reconstructed one
 * would silently corrupt the series.
 */
export function upsertByDate<T extends { date: IsoDate }>(
  existing: readonly T[],
  incoming: readonly T[],
  mode: 'overwrite' | 'if-absent',
): T[] {
  const byDate = new Map<IsoDate, T>();
  for (const row of existing) byDate.set(row.date, row);
  for (const row of incoming) {
    if (mode === 'if-absent' && byDate.has(row.date)) continue;
    byDate.set(row.date, row);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS, all `series.test.ts` and `no-runtime-deps.test.ts` cases green.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/series.ts scripts/metrics/src/series.test.ts
git commit -m "feat(metrics): add CSV series parse, format, and date upsert"
```

---

## Task 4: NDJSON dimensional series

**Files:**
- Modify: `scripts/metrics/src/series.ts`
- Modify: `scripts/metrics/src/series.test.ts`

**Interfaces:**
- Consumes: `DimensionRow` from `types.ts`.
- Produces:
  - `parseNdjson(text: string): DimensionRow[]`
  - `formatNdjson(rows: readonly DimensionRow[]): string`
  - `upsertDimensional(existing: readonly DimensionRow[], incoming: readonly DimensionRow[]): DimensionRow[]`

Split from Task 3 because the sort contract is different and load-bearing: the wrong secondary sort churns the whole file on every commit, which defeats the plain-text-over-SQLite rationale (spec 5.3).

- [ ] **Step 1: Write the failing tests**

Append to `scripts/metrics/src/series.test.ts`:

```ts
import { parseNdjson, formatNdjson, upsertDimensional } from './series.ts';
import type { DimensionRow } from './types.ts';

function row(snapshot_date: string, dimension: string, count: number): DimensionRow {
  return { snapshot_date, dimension, title: '', count, uniques: 1 };
}

describe('formatNdjson', () => {
  it('sorts by snapshot_date asc, then count desc, then dimension asc', () => {
    const text = formatNdjson([
      row('2026-08-02', 'b.com', 5),
      row('2026-08-01', 'z.com', 1),
      row('2026-08-01', 'a.com', 9),
      row('2026-08-01', 'm.com', 9),
    ]);
    const order = text
      .trim()
      .split('\n')
      .map((line) => {
        const parsed = JSON.parse(line) as DimensionRow;
        return `${parsed.snapshot_date}/${parsed.dimension}`;
      });
    expect(order).toEqual([
      '2026-08-01/a.com',
      '2026-08-01/m.com',
      '2026-08-01/z.com',
      '2026-08-02/b.com',
    ]);
  });

  it('round-trips through parseNdjson', () => {
    const rows = [row('2026-08-01', 'news.ycombinator.com', 118)];
    expect(parseNdjson(formatNdjson(rows))).toEqual(rows);
  });

  it('ignores blank lines when parsing', () => {
    expect(parseNdjson('\n\n')).toEqual([]);
  });
});

describe('upsertDimensional', () => {
  it('replaces a row with the same (snapshot_date, dimension)', () => {
    const existing = [row('2026-08-01', 'a.com', 1)];
    const result = upsertDimensional(existing, [row('2026-08-01', 'a.com', 42)]);
    expect(result).toHaveLength(1);
    expect(result[0]?.count).toBe(42);
  });

  it('keeps rows from other snapshots untouched', () => {
    const existing = [row('2026-08-01', 'a.com', 1)];
    const result = upsertDimensional(existing, [row('2026-08-02', 'a.com', 2)]);
    expect(result).toHaveLength(2);
  });

  it('does not resurrect a dimension that dropped out of the new snapshot', () => {
    const existing = [row('2026-08-01', 'a.com', 1)];
    const result = upsertDimensional(existing, [row('2026-08-02', 'b.com', 2)]);
    const day2 = result.filter((r) => r.snapshot_date === '2026-08-02');
    expect(day2.map((r) => r.dimension)).toEqual(['b.com']);
  });

  it('re-running with identical input is byte-identical', () => {
    const rows = [row('2026-08-01', 'a.com', 1), row('2026-08-01', 'b.com', 2)];
    const once = upsertDimensional([], rows);
    const twice = upsertDimensional(once, rows);
    expect(formatNdjson(twice)).toBe(formatNdjson(once));
  });
});
```

The third test encodes spec 5.3: a dimension absent from a snapshot means "outside the top 10", not zero, so it simply has no row for that day and the dashboard renders a break.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — `parseNdjson is not exported by ./series.ts`.

- [ ] **Step 3: Write the implementation**

First change the existing type import at the top of `scripts/metrics/src/series.ts` to:

```ts
import type { DimensionRow, IsoDate } from './types.ts';
```

Then append to the same file:

```ts
export function parseNdjson(text: string): DimensionRow[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as DimensionRow);
}

/**
 * Serialises dimensional rows with a fixed total order: `snapshot_date`
 * ascending, then `count` descending, then `dimension` ascending as the
 * tie-break.
 *
 * The order is part of the storage contract, not a preference. Any unstable
 * ordering rewrites the whole file on every daily commit, which would defeat
 * the one-line-per-day diff that justified plain text over SQLite.
 */
export function formatNdjson(rows: readonly DimensionRow[]): string {
  const sorted = [...rows].sort((a, b) => {
    if (a.snapshot_date !== b.snapshot_date) {
      return a.snapshot_date.localeCompare(b.snapshot_date);
    }
    if (a.count !== b.count) return b.count - a.count;
    return a.dimension.localeCompare(b.dimension);
  });
  return sorted.map((row) => JSON.stringify(row)).join('\n') + '\n';
}

/** Merges dimensional rows keyed by `(snapshot_date, dimension)`. */
export function upsertDimensional(
  existing: readonly DimensionRow[],
  incoming: readonly DimensionRow[],
): DimensionRow[] {
  const byKey = new Map<string, DimensionRow>();
  for (const row of existing) byKey.set(`${row.snapshot_date} ${row.dimension}`, row);
  for (const row of incoming) byKey.set(`${row.snapshot_date} ${row.dimension}`, row);
  return parseNdjson(formatNdjson([...byKey.values()]));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/series.ts scripts/metrics/src/series.test.ts
git commit -m "feat(metrics): add NDJSON dimensional series with a fixed sort contract"
```

---

## Task 5: GitHub API client with 202 retry and pagination

**Files:**
- Create: `scripts/metrics/src/github.ts`
- Create: `scripts/metrics/src/github.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `class GitHubError extends Error` with a readonly `status: number`
  - `interface GitHubClient { get<T>(path: string, accept?: string): Promise<T>; getStats<T>(path: string): Promise<T | null>; paginate<T>(path: string, accept?: string): Promise<T[]>; }`
  - `createClient(token: string, options?: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; statsAttempts?: number }): GitHubClient`

`getStats` returns `null` on a persistent 202. Callers treat null as "skip", never as zero.

- [ ] **Step 1: Write the failing tests**

Create `scripts/metrics/src/github.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { createClient, GitHubError } from './github.ts';

const noSleep = async (): Promise<void> => {};

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

describe('createClient.get', () => {
  it('sends the token and the API version header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true }));
    const client = createClient('tok_123', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.get('/repos/o/r');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe('https://api.github.com/repos/o/r');
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok_123');
    expect(headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  it('honours a custom Accept header for the star media type', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.get('/stargazers', 'application/vnd.github.star+json');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = call[1].headers as Record<string, string>;
    expect(headers.Accept).toBe('application/vnd.github.star+json');
  });

  it('throws GitHubError carrying the status on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: 'Not Found' }, { status: 404 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.get('/nope')).rejects.toBeInstanceOf(GitHubError);
    await expect(client.get('/nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('createClient.getStats', () => {
  it('retries a 202 and returns the body once it becomes 200', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, { status: 202 }))
      .mockResolvedValueOnce(jsonResponse([{ total: 5 }]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.getStats('/stats/contributors')).resolves.toEqual([{ total: 5 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns null after a persistent 202 rather than an empty body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, { status: 202 }));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      statsAttempts: 3,
    });
    const result = await client.getStats('/stats/contributors');
    expect(result).toBeNull();
    expect(result).not.toEqual({});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('createClient.paginate', () => {
  it('follows rel=next until it is absent and concatenates pages', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse([{ id: 1 }], {
          headers: { link: '<https://api.github.com/x?page=2>; rel="next"' },
        }),
      )
      .mockResolvedValueOnce(jsonResponse([{ id: 2 }]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await expect(client.paginate('/x')).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('requests 100 items per page', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse([]));
    const client = createClient('t', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
    });
    await client.paginate('/x');
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toContain('per_page=100');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — `Failed to resolve import "./github.ts"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/metrics/src/github.ts`:

```ts
const API_ROOT = 'https://api.github.com';

export class GitHubError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitHubClient {
  /** Fetches one resource. Throws GitHubError on any non-2xx response. */
  get<T>(path: string, accept?: string): Promise<T>;
  /**
   * Fetches a `/stats/*` resource, which returns 202 while GitHub computes it.
   * Returns `null` when it is still computing after every attempt. Callers MUST
   * treat null as "leave the previous value alone", never as zero.
   */
  getStats<T>(path: string): Promise<T | null>;
  /** Fetches every page of a list endpoint by following rel="next". */
  paginate<T>(path: string, accept?: string): Promise<T[]>;
}

export interface ClientOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  statsAttempts?: number;
}

function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

export function createClient(token: string, options: ClientOptions = {}): GitHubClient {
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const statsAttempts = options.statsAttempts ?? 5;

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'backspace-metrics',
  };

  function absolute(path: string): string {
    return path.startsWith('http') ? path : `${API_ROOT}${path}`;
  }

  async function request(url: string, accept?: string): Promise<Response> {
    const headers = accept === undefined ? baseHeaders : { ...baseHeaders, Accept: accept };
    return doFetch(url, { headers });
  }

  async function get<T>(path: string, accept?: string): Promise<T> {
    const response = await request(absolute(path), accept);
    if (!response.ok) throw new GitHubError(response.status, await response.text());
    return (await response.json()) as T;
  }

  async function getStats<T>(path: string): Promise<T | null> {
    for (let attempt = 0; attempt < statsAttempts; attempt++) {
      const response = await request(absolute(path));
      // 202 means GitHub is still computing the statistic and the body is `{}`.
      // Reading that as data would write a zero over a real value. The stats
      // cache is keyed by the default branch SHA and reset by every push to
      // main, so on an active repo this is routine, not exceptional.
      if (response.status === 202) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!response.ok) throw new GitHubError(response.status, await response.text());
      return (await response.json()) as T;
    }
    return null;
  }

  async function paginate<T>(path: string, accept?: string): Promise<T[]> {
    const separator = path.includes('?') ? '&' : '?';
    let url: string | null = absolute(`${path}${separator}per_page=100`);
    const items: T[] = [];
    while (url !== null) {
      const response: Response = await request(url, accept);
      if (!response.ok) throw new GitHubError(response.status, await response.text());
      items.push(...((await response.json()) as T[]));
      url = nextLink(response.headers.get('link'));
    }
    return items;
  }

  return { get, getStats, paginate };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/github.ts scripts/metrics/src/github.test.ts
git commit -m "feat(metrics): add GitHub client with 202 stats retry and pagination"
```

---

## Task 6: Filesystem store

**Files:**
- Create: `scripts/metrics/src/store.ts`
- Create: `scripts/metrics/src/store.test.ts`

**Interfaces:**
- Consumes: `parseCsv`, `formatCsv`, `parseNdjson`, `formatNdjson` from `series.ts`; `DimensionRow`, `IsoDate` from `types.ts`.
- Produces:
  - `interface Meta { last_run: string; last_success: string | null; error: string | null; series_last_date: Record<string, IsoDate>; }`
  - `interface Store { readCsv(file: string): Record<string, string>[]; writeCsv(file: string, header: readonly string[], rows: ReadonlyArray<Record<string, string | number>>): void; readNdjson(file: string): DimensionRow[]; writeNdjson(file: string, rows: readonly DimensionRow[]): void; readMeta(): Meta | null; writeMeta(meta: Meta): void; }`
  - `createStore(dataDir: string): Store`

The store is the only module that touches the filesystem. Isolating it here is what lets Task 7 test orchestration against a temp directory with no mocking of `node:fs`.

- [ ] **Step 1: Write the failing tests**

Create `scripts/metrics/src/store.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-store-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('createStore', () => {
  it('returns an empty array for a file that does not exist', () => {
    const store = createStore(dir);
    expect(store.readCsv('stars.csv')).toEqual([]);
    expect(store.readNdjson('traffic/referrers.ndjson')).toEqual([]);
  });

  it('creates nested directories on write', () => {
    const store = createStore(dir);
    store.writeCsv('traffic/views.csv', ['date', 'count'], [{ date: '2026-08-01', count: 3 }]);
    expect(existsSync(path.join(dir, 'traffic/views.csv'))).toBe(true);
  });

  it('round-trips CSV through the filesystem', () => {
    const store = createStore(dir);
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-08-01', total: 56 }]);
    expect(store.readCsv('stars.csv')).toEqual([{ date: '2026-08-01', total: '56' }]);
  });

  it('round-trips NDJSON through the filesystem', () => {
    const store = createStore(dir);
    const rows = [
      { snapshot_date: '2026-08-01', dimension: 'a.com', title: '', count: 5, uniques: 2 },
    ];
    store.writeNdjson('traffic/referrers.ndjson', rows);
    expect(store.readNdjson('traffic/referrers.ndjson')).toEqual(rows);
  });

  it('returns null when meta.json is absent', () => {
    expect(createStore(dir).readMeta()).toBeNull();
  });

  it('writes meta.json as pretty-printed JSON with a trailing newline', () => {
    const store = createStore(dir);
    store.writeMeta({
      last_run: '2026-08-25T03:00:41Z',
      last_success: '2026-08-25T03:00:41Z',
      error: null,
      series_last_date: { 'stars.csv': '2026-08-25' },
    });
    const text = readFileSync(path.join(dir, 'meta.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "last_run"');
    expect(store.readMeta()?.series_last_date['stars.csv']).toBe('2026-08-25');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — `Failed to resolve import "./store.ts"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/metrics/src/store.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
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

export function createStore(dataDir: string): Store {
  function resolve(file: string): string {
    return path.join(dataDir, file);
  }

  function read(file: string): string | null {
    const full = resolve(file);
    if (!existsSync(full)) return null;
    return readFileSync(full, 'utf8');
  }

  function write(file: string, text: string): void {
    const full = resolve(file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text, 'utf8');
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
      return text === null ? null : (JSON.parse(text) as Meta);
    },
    writeMeta(meta) {
      write('meta.json', JSON.stringify(meta, null, 2) + '\n');
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/store.ts scripts/metrics/src/store.test.ts
git commit -m "feat(metrics): add filesystem store for the data branch"
```

---

## Task 7: Daily collection with atomicity

**Files:**
- Create: `scripts/metrics/src/collect.ts`
- Create: `scripts/metrics/src/collect.test.ts`

**Interfaces:**
- Consumes: `GitHubClient` from `github.ts`; `Store`, `Meta` from `store.ts`; `upsertByDate`, `upsertDimensional` from `series.ts`; all row types from `types.ts`.
- Produces:
  - `interface CollectResult { written: string[]; skipped: string[]; }`
  - `collect(options: { client: GitHubClient; store: Store; slug: string; today: IsoDate; now: string }): Promise<CollectResult>`

`today` and `now` are injected rather than read from the clock so tests are deterministic.

This is the task where the spec's two hardest rules become code: **any required fetch failing means nothing is written at all**, and **an optional fetch failing skips without writing a zero**.

- [ ] **Step 1: Write the failing tests**

Create `scripts/metrics/src/collect.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { collect } from './collect.ts';
import type { GitHubClient } from './github.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-collect-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VIEWS = {
  views: [
    { timestamp: '2026-08-23T00:00:00Z', count: 40, uniques: 12 },
    { timestamp: '2026-08-24T00:00:00Z', count: 51, uniques: 15 },
  ],
};
const CLONES = {
  clones: [{ timestamp: '2026-08-24T00:00:00Z', count: 4, uniques: 3 }],
};
const REFERRERS = [{ referrer: 'news.ycombinator.com', count: 118, uniques: 94 }];
const PATHS = [{ path: '/TheZwiss/backspace', title: 'Backspace', count: 402, uniques: 161 }];
const REPO = {
  stargazers_count: 56,
  forks_count: 3,
  subscribers_count: 1,
  open_issues_count: 13,
};
const RELEASES = [
  {
    tag_name: 'v1.0.0',
    name: 'Backspace 1.0.0',
    published_at: '2026-08-01T10:00:00Z',
    assets: [{ download_count: 20 }, { download_count: 17 }],
  },
];
const CONTRIBUTORS = [{ weeks: [{ w: 1771200000, c: 3 }] }, { weeks: [{ w: 1771804800, c: 1 }] }];

function fakeClient(overrides: Partial<Record<string, unknown>> = {}): GitHubClient {
  const routes: Record<string, unknown> = {
    '/repos/o/r/traffic/views': VIEWS,
    '/repos/o/r/traffic/clones': CLONES,
    '/repos/o/r/traffic/popular/referrers': REFERRERS,
    '/repos/o/r/traffic/popular/paths': PATHS,
    '/repos/o/r': REPO,
    '/repos/o/r/releases': RELEASES,
    ...overrides,
  };
  return {
    async get<T>(p: string): Promise<T> {
      const value = routes[p];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`unexpected GET ${p}`);
      return value as T;
    },
    async getStats<T>(p: string): Promise<T | null> {
      if (Object.prototype.hasOwnProperty.call(overrides, p)) {
        return overrides[p] as T | null;
      }
      if (p === '/repos/o/r/stats/contributors') return CONTRIBUTORS as T;
      return null;
    },
    async paginate<T>(): Promise<T[]> {
      throw new Error('collect must not paginate');
    },
  };
}

const base = { slug: 'o/r', today: '2026-08-25', now: '2026-08-25T03:00:41Z' };

describe('collect', () => {
  it('writes traffic keyed by the bucket date, not by today', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('traffic/views.csv')).toEqual([
      { date: '2026-08-23', count: '40', uniques: '12' },
      { date: '2026-08-24', count: '51', uniques: '15' },
    ]);
  });

  it('does not invent a row for today when the window ends yesterday', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const dates = store.readCsv('traffic/views.csv').map((r) => r.date);
    expect(dates).not.toContain('2026-08-25');
  });

  it('tags dimensional snapshots with today', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const rows = store.readNdjson('traffic/referrers.ndjson');
    expect(rows).toEqual([
      {
        snapshot_date: '2026-08-25',
        dimension: 'news.ycombinator.com',
        title: '',
        count: 118,
        uniques: 94,
      },
    ]);
  });

  it('writes stars and forks from the repo object counters, dated today', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual([{ date: '2026-08-25', total: '56' }]);
    expect(store.readCsv('forks.csv')).toEqual([{ date: '2026-08-25', total: '3' }]);
  });

  it('sums every asset download count into repo.csv', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('repo.csv')).toEqual([
      {
        date: '2026-08-25',
        subscribers: '1',
        open_issues: '13',
        downloads_total: '37',
      },
    ]);
  });

  it('records release publish dates for the growth-chart annotations', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'Backspace 1.0.0' },
    ]);
  });

  it('aborts the entire write when a required traffic fetch fails', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/traffic/clones': new Error('boom') });
    await expect(collect({ client, store, ...base })).rejects.toThrow('boom');
    expect(store.readCsv('traffic/views.csv')).toEqual([]);
    expect(store.readCsv('stars.csv')).toEqual([]);
    expect(store.readMeta()).toBeNull();
  });

  it('skips contributors on a persistent 202 without writing a zero', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/stats/contributors': null });
    const result = await collect({ client, store, ...base });
    expect(store.readCsv('contributors.csv')).toEqual([]);
    expect(result.skipped).toContain('contributors.csv');
    expect(store.readCsv('traffic/views.csv')).not.toEqual([]);
  });

  it('preserves a previous contributor value when the stats endpoint is computing', async () => {
    const store = createStore(dir);
    store.writeCsv('contributors.csv', ['date', 'total'], [{ date: '2026-08-24', total: 4 }]);
    const client = fakeClient({ '/repos/o/r/stats/contributors': null });
    await collect({ client, store, ...base });
    expect(store.readCsv('contributors.csv')).toEqual([{ date: '2026-08-24', total: '4' }]);
  });

  it('skips releases without aborting when that optional fetch fails', async () => {
    const store = createStore(dir);
    const client = fakeClient({ '/repos/o/r/releases': new Error('502') });
    const result = await collect({ client, store, ...base });
    expect(result.skipped).toContain('releases.csv');
    expect(store.readCsv('traffic/views.csv')).not.toEqual([]);
  });

  it('is idempotent: a second run over the same data changes nothing', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const first = store.readCsv('traffic/views.csv');
    await collect({ client: fakeClient(), store, ...base });
    expect(store.readCsv('traffic/views.csv')).toEqual(first);
  });

  it('merges a new window over existing history without duplicating dates', async () => {
    const store = createStore(dir);
    store.writeCsv(
      'traffic/views.csv',
      ['date', 'count', 'uniques'],
      [
        { date: '2026-08-01', count: 5, uniques: 2 },
        { date: '2026-08-23', count: 1, uniques: 1 },
      ],
    );
    await collect({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('traffic/views.csv');
    expect(rows.map((r) => r.date)).toEqual(['2026-08-01', '2026-08-23', '2026-08-24']);
    expect(rows[1]?.count).toBe('40');
  });

  it('writes meta.json with last_success and per-file high-water marks', async () => {
    const store = createStore(dir);
    await collect({ client: fakeClient(), store, ...base });
    const meta = store.readMeta();
    expect(meta?.last_run).toBe('2026-08-25T03:00:41Z');
    expect(meta?.last_success).toBe('2026-08-25T03:00:41Z');
    expect(meta?.error).toBeNull();
    expect(meta?.series_last_date['traffic/views.csv']).toBe('2026-08-24');
    expect(meta?.series_last_date['stars.csv']).toBe('2026-08-25');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — `Failed to resolve import "./collect.ts"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/metrics/src/collect.ts`:

```ts
import { upsertByDate, upsertDimensional } from './series.ts';
import type { GitHubClient } from './github.ts';
import type { Meta, Store } from './store.ts';
import type {
  CountPoint,
  DimensionRow,
  IsoDate,
  ReleaseRow,
  RepoPoint,
  TrafficPoint,
} from './types.ts';

interface TrafficBucket {
  timestamp: string;
  count: number;
  uniques: number;
}
interface ViewsResponse {
  views: TrafficBucket[];
}
interface ClonesResponse {
  clones: TrafficBucket[];
}
interface ReferrerResponse {
  referrer: string;
  count: number;
  uniques: number;
}
interface PathResponse {
  path: string;
  title: string;
  count: number;
  uniques: number;
}
interface RepoResponse {
  stargazers_count: number;
  forks_count: number;
  subscribers_count: number;
  open_issues_count: number;
}
interface ReleaseResponse {
  tag_name: string;
  name: string | null;
  published_at: string | null;
  assets: Array<{ download_count: number }>;
}
interface ContributorResponse {
  weeks: Array<{ w: number; c: number }>;
}

export interface CollectResult {
  written: string[];
  skipped: string[];
}

export interface CollectOptions {
  client: GitHubClient;
  store: Store;
  /** `owner/repo`, from `github.repository`. */
  slug: string;
  /** Today in UTC, `YYYY-MM-DD`. Injected for deterministic tests. */
  today: IsoDate;
  /** Run timestamp, ISO 8601. Injected for deterministic tests. */
  now: string;
}

/** Converts an ISO timestamp to its UTC calendar date. */
function toDate(timestamp: string): IsoDate {
  const date = timestamp.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`Unparseable timestamp from the API: ${timestamp}`);
  }
  return date;
}

function toTraffic(buckets: TrafficBucket[]): TrafficPoint[] {
  return buckets.map((bucket) => ({
    date: toDate(bucket.timestamp),
    count: bucket.count,
    uniques: bucket.uniques,
  }));
}

/**
 * Runs the daily collection.
 *
 * Atomicity is the whole design of this function: every required series is
 * fetched into memory before a single byte is written. A required failure
 * propagates, leaving the data directory and `meta.json` untouched, so a
 * half-failed run can never produce a file the next run treats as
 * authoritative. Optional series degrade to a skip instead, because releases
 * and contributor stats are reconstructable at any later date while traffic
 * is not.
 */
export async function collect(options: CollectOptions): Promise<CollectResult> {
  const { client, store, slug, today, now } = options;
  const repoPath = `/repos/${slug}`;
  const skipped: string[] = [];

  // --- Required. Any rejection here aborts before any write. ---
  const [views, clones, referrers, paths, repo] = await Promise.all([
    client.get<ViewsResponse>(`${repoPath}/traffic/views`),
    client.get<ClonesResponse>(`${repoPath}/traffic/clones`),
    client.get<ReferrerResponse[]>(`${repoPath}/traffic/popular/referrers`),
    client.get<PathResponse[]>(`${repoPath}/traffic/popular/paths`),
    client.get<RepoResponse>(repoPath),
  ]);

  // --- Optional. A failure skips the series, never zeroes it. ---
  let releases: ReleaseResponse[] | null = null;
  try {
    releases = await client.get<ReleaseResponse[]>(`${repoPath}/releases`);
  } catch {
    skipped.push('releases.csv');
    skipped.push('repo.csv:downloads_total');
  }

  let contributors: ContributorResponse[] | null = null;
  try {
    contributors = await client.getStats<ContributorResponse[]>(`${repoPath}/stats/contributors`);
  } catch {
    contributors = null;
  }
  if (contributors === null) skipped.push('contributors.csv');

  const written: string[] = [];

  function writeCsvSeries(
    file: string,
    header: readonly string[],
    incoming: ReadonlyArray<Record<string, string | number> & { date: IsoDate }>,
  ): void {
    const existing = store.readCsv(file) as unknown as Array<{ date: IsoDate }>;
    const merged = upsertByDate(existing, incoming, 'overwrite');
    store.writeCsv(file, header, merged as unknown as Array<Record<string, string | number>>);
    written.push(file);
  }

  function writeDimensional(file: string, incoming: readonly DimensionRow[]): void {
    const merged = upsertDimensional(store.readNdjson(file), incoming);
    store.writeNdjson(file, merged);
    written.push(file);
  }

  writeCsvSeries('traffic/views.csv', ['date', 'count', 'uniques'], toTraffic(views.views));
  writeCsvSeries('traffic/clones.csv', ['date', 'count', 'uniques'], toTraffic(clones.clones));

  writeDimensional(
    'traffic/referrers.ndjson',
    referrers.map((item) => ({
      snapshot_date: today,
      dimension: item.referrer,
      title: '',
      count: item.count,
      uniques: item.uniques,
    })),
  );
  writeDimensional(
    'traffic/paths.ndjson',
    paths.map((item) => ({
      snapshot_date: today,
      dimension: item.path,
      title: item.title,
      count: item.count,
      uniques: item.uniques,
    })),
  );

  // Stars and forks come from the repo object's counters rather than by listing
  // stargazers. That is a point-in-time measurement, so it correctly reflects
  // people who starred and later unstarred — which the backfill, working from
  // `starred_at`, structurally cannot see.
  const stars: CountPoint = { date: today, total: repo.stargazers_count };
  const forks: CountPoint = { date: today, total: repo.forks_count };
  writeCsvSeries('stars.csv', ['date', 'total'], [stars]);
  writeCsvSeries('forks.csv', ['date', 'total'], [forks]);

  const downloadsTotal =
    releases === null
      ? 0
      : releases.reduce(
          (sum, release) =>
            sum + release.assets.reduce((assetSum, asset) => assetSum + asset.download_count, 0),
          0,
        );

  const repoPoint: RepoPoint = {
    date: today,
    subscribers: repo.subscribers_count,
    open_issues: repo.open_issues_count,
    downloads_total: downloadsTotal,
  };
  writeCsvSeries('repo.csv', ['date', 'subscribers', 'open_issues', 'downloads_total'], [repoPoint]);

  if (releases !== null) {
    const releaseRows: ReleaseRow[] = releases
      .filter((release) => release.published_at !== null)
      .map((release) => ({
        date: toDate(release.published_at as string),
        tag: release.tag_name,
        name: release.name ?? release.tag_name,
      }));
    writeCsvSeries('releases.csv', ['date', 'tag', 'name'], releaseRows);
  }

  if (contributors !== null) {
    // A contributor counts from the week of their first commit onward, so the
    // series is a cumulative distinct count rather than a weekly total.
    const firstWeeks = contributors
      .map((contributor) => contributor.weeks.find((week) => week.c > 0)?.w)
      .filter((week): week is number => week !== undefined)
      .sort((a, b) => a - b);
    let running = 0;
    const points: CountPoint[] = firstWeeks.map((week) => {
      running += 1;
      return { date: new Date(week * 1000).toISOString().slice(0, 10), total: running };
    });
    if (points.length > 0) {
      writeCsvSeries('contributors.csv', ['date', 'total'], points);
    }
  }

  const lastDate = (file: string): IsoDate | undefined => {
    const rows = store.readCsv(file);
    return rows[rows.length - 1]?.date;
  };

  const seriesLastDate: Record<string, IsoDate> = {};
  for (const file of written) {
    if (!file.endsWith('.csv')) continue;
    const last = lastDate(file);
    if (last !== undefined) seriesLastDate[file] = last;
  }

  const meta: Meta = {
    last_run: now,
    last_success: now,
    error: null,
    series_last_date: seriesLastDate,
  };
  store.writeMeta(meta);

  return { written, skipped };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS, all 14 `collect.test.ts` cases green.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/collect.ts scripts/metrics/src/collect.test.ts
git commit -m "feat(metrics): add daily collection with atomic writes and 202 skips"
```

---

## Task 8: Backfill, write-if-absent

**Files:**
- Create: `scripts/metrics/src/backfill.ts`
- Create: `scripts/metrics/src/backfill.test.ts`

**Interfaces:**
- Consumes: `GitHubClient`, `Store`, `upsertByDate`, row types.
- Produces: `backfill(options: { client: GitHubClient; store: Store; slug: string }): Promise<{ written: string[] }>`

- [ ] **Step 1: Write the failing tests**

Create `scripts/metrics/src/backfill.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from './store.ts';
import { backfill } from './backfill.ts';
import type { GitHubClient } from './github.ts';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'metrics-backfill-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const STARGAZERS = [
  { starred_at: '2026-02-20T10:00:00Z' },
  { starred_at: '2026-02-20T18:00:00Z' },
  { starred_at: '2026-03-01T09:00:00Z' },
];
const FORKS = [{ created_at: '2026-03-05T09:00:00Z' }];
const RELEASES = [
  { tag_name: 'v1.0.0', name: 'Backspace 1.0.0', published_at: '2026-08-01T10:00:00Z' },
];

function fakeClient(pages: Record<string, unknown[]> = {}): GitHubClient {
  const routes: Record<string, unknown[]> = {
    '/repos/o/r/stargazers': STARGAZERS,
    '/repos/o/r/forks?sort=oldest': FORKS,
    '/repos/o/r/releases': RELEASES,
    ...pages,
  };
  return {
    async get<T>(p: string): Promise<T> {
      throw new Error(`backfill must paginate, not get: ${p}`);
    },
    async getStats<T>(): Promise<T | null> {
      return null;
    },
    async paginate<T>(p: string): Promise<T[]> {
      const value = routes[p];
      if (value === undefined) throw new Error(`unexpected paginate ${p}`);
      return value as T[];
    },
  };
}

const base = { slug: 'o/r' };

describe('backfill', () => {
  it('accumulates stars cumulatively by the UTC day of starred_at', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual([
      { date: '2026-02-20', total: '2' },
      { date: '2026-03-01', total: '3' },
    ]);
  });

  it('accumulates forks cumulatively by created_at', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('forks.csv')).toEqual([{ date: '2026-03-05', total: '1' }]);
  });

  it('records release dates', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('releases.csv')).toEqual([
      { date: '2026-08-01', tag: 'v1.0.0', name: 'Backspace 1.0.0' },
    ]);
  });

  it('NEVER overwrites a date the collector already measured', async () => {
    const store = createStore(dir);
    // The collector measured 1 star on 2026-03-01, because someone unstarred.
    // The reconstruction from /stargazers cannot see that and would say 3.
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-03-01', total: 1 }]);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows.find((r) => r.date === '2026-03-01')?.total).toBe('1');
  });

  it('still fills dates the collector never saw', async () => {
    const store = createStore(dir);
    store.writeCsv('stars.csv', ['date', 'total'], [{ date: '2026-03-01', total: 1 }]);
    await backfill({ client: fakeClient(), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows.find((r) => r.date === '2026-02-20')?.total).toBe('2');
  });

  it('never touches traffic files or repo.csv', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    expect(existsSync(path.join(dir, 'traffic'))).toBe(false);
    expect(existsSync(path.join(dir, 'repo.csv'))).toBe(false);
  });

  it('reports exactly the files it may write', async () => {
    const store = createStore(dir);
    const result = await backfill({ client: fakeClient(), store, ...base });
    expect(result.written.sort()).toEqual(['forks.csv', 'releases.csv', 'stars.csv']);
  });

  it('is idempotent across repeated runs', async () => {
    const store = createStore(dir);
    await backfill({ client: fakeClient(), store, ...base });
    const first = store.readCsv('stars.csv');
    await backfill({ client: fakeClient(), store, ...base });
    expect(store.readCsv('stars.csv')).toEqual(first);
  });

  it('handles multi-page stargazer results', async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({
      starred_at: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    }));
    const store = createStore(dir);
    await backfill({ client: fakeClient({ '/repos/o/r/stargazers': many }), store, ...base });
    const rows = store.readCsv('stars.csv');
    expect(rows[rows.length - 1]?.total).toBe('150');
  });
});
```

The fourth test is the point of the whole task. It encodes the exact scenario that would otherwise destroy measured history.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @backspace/metrics test`
Expected: FAIL — `Failed to resolve import "./backfill.ts"`.

- [ ] **Step 3: Write the implementation**

Create `scripts/metrics/src/backfill.ts`:

```ts
import { upsertByDate } from './series.ts';
import type { GitHubClient } from './github.ts';
import type { Store } from './store.ts';
import type { CountPoint, IsoDate, ReleaseRow } from './types.ts';

interface StargazerResponse {
  starred_at: string;
}
interface ForkResponse {
  created_at: string;
}
interface ReleaseResponse {
  tag_name: string;
  name: string | null;
  published_at: string | null;
}

export interface BackfillOptions {
  client: GitHubClient;
  store: Store;
  slug: string;
}

/**
 * Files backfill is permitted to write. Exhaustive and deliberately short.
 *
 * `traffic/*` is excluded because it is unreconstructable, and `repo.csv`
 * because `subscribers` has no historical API at all — a stray rewrite would
 * be a permanent loss with nothing to restore from.
 */
const WRITABLE = ['stars.csv', 'forks.csv', 'releases.csv'] as const;

/** Turns a list of event timestamps into a cumulative daily series. */
function cumulativeByDay(timestamps: readonly string[]): CountPoint[] {
  const perDay = new Map<IsoDate, number>();
  for (const timestamp of timestamps) {
    const date = timestamp.slice(0, 10);
    perDay.set(date, (perDay.get(date) ?? 0) + 1);
  }
  const days = [...perDay.keys()].sort((a, b) => a.localeCompare(b));
  let running = 0;
  return days.map((date) => {
    running += perDay.get(date) ?? 0;
    return { date, total: running };
  });
}

/**
 * Reconstructs history that permanent timestamps make recoverable.
 *
 * Every write is `if-absent`. The reconstruction works from `/stargazers`,
 * which lists only *current* stargazers — anyone who starred and later
 * unstarred is invisible to it. Overwriting a date the collector measured
 * would therefore replace a correct value with a systematically wrong one.
 */
export async function backfill(options: BackfillOptions): Promise<{ written: string[] }> {
  const { client, store, slug } = options;
  const repoPath = `/repos/${slug}`;

  const stargazers = await client.paginate<StargazerResponse>(
    `${repoPath}/stargazers`,
    'application/vnd.github.star+json',
  );
  const forks = await client.paginate<ForkResponse>(`${repoPath}/forks?sort=oldest`);
  const releases = await client.paginate<ReleaseResponse>(`${repoPath}/releases`);

  function mergeIfAbsent(
    file: string,
    header: readonly string[],
    incoming: ReadonlyArray<Record<string, string | number> & { date: IsoDate }>,
  ): void {
    const existing = store.readCsv(file) as unknown as Array<{ date: IsoDate }>;
    const merged = upsertByDate(existing, incoming, 'if-absent');
    store.writeCsv(file, header, merged as unknown as Array<Record<string, string | number>>);
  }

  mergeIfAbsent(
    'stars.csv',
    ['date', 'total'],
    cumulativeByDay(stargazers.map((item) => item.starred_at)),
  );
  mergeIfAbsent(
    'forks.csv',
    ['date', 'total'],
    cumulativeByDay(forks.map((item) => item.created_at)),
  );

  const releaseRows: ReleaseRow[] = releases
    .filter((release) => release.published_at !== null)
    .map((release) => ({
      date: (release.published_at as string).slice(0, 10),
      tag: release.tag_name,
      name: release.name ?? release.tag_name,
    }));
  mergeIfAbsent('releases.csv', ['date', 'tag', 'name'], releaseRows);

  return { written: [...WRITABLE] };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/backfill.ts scripts/metrics/src/backfill.test.ts
git commit -m "feat(metrics): add write-if-absent historical backfill"
```

---

## Task 9: CLI entrypoints

**Files:**
- Create: `scripts/metrics/src/cli-collect.ts`
- Create: `scripts/metrics/src/cli-backfill.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: `collect`, `backfill`, `createClient`, `createStore`.
- Produces: two executables the workflows invoke as `node scripts/metrics/src/cli-collect.ts`.

Kept separate from `collect.ts` so that module stays pure and testable. These files read the environment and the clock; nothing else does.

- [ ] **Step 1: Write the collect entrypoint**

Create `scripts/metrics/src/cli-collect.ts`:

```ts
import { createClient } from './github.ts';
import { createStore } from './store.ts';
import { collect } from './collect.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const token = required('METRICS_TOKEN');
const slug = required('GITHUB_REPOSITORY');
const dataDir = required('METRICS_DATA_DIR');

const nowDate = new Date();
const now = nowDate.toISOString();
const today = now.slice(0, 10);

const result = await collect({
  client: createClient(token),
  store: createStore(dataDir),
  slug,
  today,
  now,
});

console.log(`wrote: ${result.written.join(', ')}`);
if (result.skipped.length > 0) {
  console.log(`skipped (left at previous value): ${result.skipped.join(', ')}`);
}
```

- [ ] **Step 2: Write the backfill entrypoint**

Create `scripts/metrics/src/cli-backfill.ts`:

```ts
import { createClient } from './github.ts';
import { createStore } from './store.ts';
import { backfill } from './backfill.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

const result = await backfill({
  client: createClient(required('METRICS_TOKEN')),
  store: createStore(required('METRICS_DATA_DIR')),
  slug: required('GITHUB_REPOSITORY'),
});

console.log(`backfilled (write-if-absent): ${result.written.join(', ')}`);
```

- [ ] **Step 3: Ignore the workflow's data checkout**

Add to `.gitignore`, under a new labelled section matching the file's existing style:

```gitignore
# Metrics data branch, checked out into the workspace by .github/workflows/metrics.yml
.metrics-data/
```

- [ ] **Step 4: Verify the entrypoints type-check and run**

Run: `pnpm --filter @backspace/metrics test`
Expected: PASS. The `no-runtime-deps` guard now also covers both CLI files.

Then verify Node can actually execute the TypeScript, which nothing so far has proven:

```bash
node --version   # must be >= 22.18
METRICS_TOKEN=x GITHUB_REPOSITORY=o/r METRICS_DATA_DIR=/tmp/mx \
  node scripts/metrics/src/cli-collect.ts
```

Expected: it reaches the network and fails with a GitHub API 401. That is success for this step — it proves type stripping works and the module graph loads. A `SyntaxError` here means an `import type` or `.ts` extension was missed.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/cli-collect.ts scripts/metrics/src/cli-backfill.ts .gitignore
git commit -m "feat(metrics): add collect and backfill CLI entrypoints"
```

---

## Task 10: Daily collection workflow

**Files:**
- Create: `.github/workflows/metrics.yml`

**Interfaces:**
- Consumes: `cli-collect.ts`.
- Produces: the `metrics-data` branch and its daily commits.

- [ ] **Step 1: Look up the current action SHAs**

Every `uses:` must be a full commit SHA with a trailing version comment. Reuse the SHAs already pinned in this repo rather than looking them up fresh — `ci.yml` has `harden-runner` and `checkout` at the versions this repo has standardised on:

```bash
grep -h "uses:" .github/workflows/ci.yml .github/workflows/cla.yml
```

Copy the `step-security/harden-runner` and `actions/checkout` lines verbatim, including the `# vX.Y.Z` comments.

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/metrics.yml`. Substitute the two `uses:` lines with the pinned values from Step 1:

```yaml
name: Metrics

# Snapshots this repo's traffic metrics daily into the orphan `metrics-data`
# branch. Purpose: GitHub's Insights -> Traffic panel discards views, clones,
# referrers, and popular paths after 14 days, and no API can reconstruct them.
# Every day this does not run is a day of history destroyed permanently.
#
# Why two tokens: the traffic endpoints require the "Administration: read"
# permission, and there is no `administration` key in the Actions `permissions:`
# vocabulary at all — so GITHUB_TOKEN cannot reach them under any configuration.
# METRICS_TOKEN (a fine-grained, repo-scoped, read-only PAT) reads; GITHUB_TOKEN
# writes. Neither alone can both read traffic and modify the archive.
#
# Why the deploy job re-declares permissions: a called workflow's permissions can
# only be reduced, never elevated, and anything unlisted becomes `none`. The job
# that calls deploy-pages.yml must therefore hold pages:write and id-token:write
# itself, or the Pages deploy fails with "Resource not accessible by integration".
#
# Why `gh workflow enable`: GitHub disables scheduled workflows after 60 days
# with no repository activity. This workflow's own commits go to a non-default
# branch and are made with GITHUB_TOKEN, so they cannot be relied on to reset
# that timer. Re-enabling on every run is idempotent and costs one API call.
#
# See docs/systems/metrics.md.

on:
  schedule:
    # 03:00 UTC daily. The exact hour does not matter: the traffic API returns a
    # 14-day window, so any gap of 13 days or less is repaired by the next run.
    - cron: '0 3 * * *'
  workflow_dispatch:

permissions:
  contents: read

# Never cancel in progress: metrics.yml and backfill.yml write the same files,
# and cancelling a collection run loses that day irrecoverably.
concurrency:
  group: metrics-data
  cancel-in-progress: false

jobs:
  collect:
    name: Collect metrics
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920 # v2.20.0
        with:
          egress-policy: audit

      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1

      # The data branch must be created BEFORE actions/checkout is asked for it:
      # checkout with a nonexistent ref hard-fails the job, so a bootstrap step
      # placed after it could never run.
      - name: Bootstrap the data branch if absent
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          set -euo pipefail
          if git ls-remote --exit-code --heads origin metrics-data >/dev/null 2>&1; then
            echo "metrics-data exists"
          else
            echo "Creating orphan branch metrics-data"
            git config user.name  "github-actions[bot]"
            git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            git switch --orphan metrics-data
            git commit --allow-empty -m "chore(metrics): initialise data branch"
            git push origin metrics-data
            git switch -
          fi

      - name: Checkout the data branch
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
        with:
          ref: metrics-data
          path: .metrics-data

      - name: Setup Node.js
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          # Pinned to 24: the collector is TypeScript executed directly by Node's
          # native type stripping, with no build step and no dependencies.
          node-version: 24

      - name: Collect
        env:
          METRICS_TOKEN: ${{ secrets.METRICS_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          METRICS_DATA_DIR: ${{ github.workspace }}/.metrics-data
        run: node scripts/metrics/src/cli-collect.ts

      - name: Commit and push
        working-directory: .metrics-data
        run: |
          set -euo pipefail
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then
            echo "No change to commit"
            exit 0
          fi
          git commit -m "chore(metrics): snapshot $(date -u +%Y-%m-%d)"
          # backfill.yml can be dispatched while this runs. Rebase and retry
          # rather than clobbering, then fail loudly if it still will not land.
          for attempt in 1 2 3; do
            if git push origin metrics-data; then
              exit 0
            fi
            echo "Push rejected (attempt $attempt), rebasing"
            git pull --rebase origin metrics-data
          done
          echo "Could not push after 3 attempts"
          exit 1

      # Runs even when collection failed, so a stalled collector is visible on
      # the data branch and in the dashboard header rather than only in this tab.
      - name: Record run outcome
        if: always()
        working-directory: .metrics-data
        env:
          OUTCOME: ${{ job.status }}
        run: |
          set -euo pipefail
          node -e '
            const fs = require("node:fs");
            const now = new Date().toISOString();
            let meta = { last_run: now, last_success: null, error: null, series_last_date: {} };
            if (fs.existsSync("meta.json")) {
              meta = JSON.parse(fs.readFileSync("meta.json", "utf8"));
            }
            meta.last_run = now;
            if (process.env.OUTCOME !== "success") {
              meta.error = `run failed: ${process.env.OUTCOME}`;
            }
            fs.writeFileSync("meta.json", JSON.stringify(meta, null, 2) + "\n");
          '
          git add meta.json
          git diff --cached --quiet || {
            git commit -m "chore(metrics): record run outcome"
            git push origin metrics-data || true
          }

      - name: Keep the schedule alive
        if: always()
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh workflow enable metrics.yml --repo "${{ github.repository }}" || true
```

WS1 deliberately ships with **no deploy job**. WS2 (`plan-b-metrics-bundle-deploy.md`) adds it, declaring `contents: read`, `pages: write`, and `id-token: write` on that job — the header comment above records why those cannot be inherited. Collection is independently valuable without a dashboard, and keeping the Pages change out of this workstream means a regression there cannot block the archive from accruing.

- [ ] **Step 3: Validate the workflow syntax**

Run: `gh workflow view metrics.yml --repo TheZwiss/backspace 2>&1 | head -5`
Expected: an error that the workflow does not exist yet, since it is not pushed. That is fine — this step is only to confirm `gh` is authenticated for Step 5.

Validate the YAML parses:

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/metrics.yml')); print('valid yaml')"
```

Expected: `valid yaml`.

- [ ] **Step 4: Confirm the action pins match the rest of the repo**

```bash
grep -o "uses: [^ ]*@[a-f0-9]\{40\}" .github/workflows/metrics.yml
```

Expected: three lines, each a 40-character SHA. If any `uses:` lacks a SHA, fix it before committing — the repo pins every action without exception.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/metrics.yml
git commit -m "ci(metrics): add daily traffic collection workflow"
```

---

## Task 11: Backfill workflow

**Files:**
- Create: `.github/workflows/backfill.yml`

**Interfaces:**
- Consumes: `cli-backfill.ts`, and the `metrics-data` branch created by Task 10.
- Produces: a manually dispatched historical reconstruction.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/backfill.yml`, reusing the same pinned SHAs as `metrics.yml`:

```yaml
name: Metrics backfill

# Reconstructs history that permanent timestamps make recoverable: stars from
# `starred_at`, forks from `created_at`, releases from `published_at`.
#
# Dispatch only, never scheduled. It is safe to run at any time because every
# write is if-absent: it fills dates that have no row and never replaces one the
# daily collector measured. That rule matters because /stargazers lists only
# CURRENT stargazers, so a reconstruction cannot see anyone who starred and
# later unstarred — overwriting a measured value with a reconstructed one would
# replace a correct number with a systematically wrong one.
#
# Traffic is not backfillable by any means and this workflow never touches it.
#
# See docs/systems/metrics.md.

on:
  workflow_dispatch:

permissions:
  contents: read

# Shares metrics.yml's group so a dispatched backfill cannot race the daily
# cron and clobber it.
concurrency:
  group: metrics-data
  cancel-in-progress: false

jobs:
  backfill:
    name: Backfill history
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - name: Harden the runner
        uses: step-security/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920 # v2.20.0
        with:
          egress-policy: audit

      - name: Checkout
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1

      - name: Checkout the data branch
        uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5.0.1
        with:
          ref: metrics-data
          path: .metrics-data

      - name: Setup Node.js
        uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: 24

      - name: Backfill
        env:
          # Must be the PAT, not GITHUB_TOKEN: the latter carries a 1,000
          # requests/hour per-repository limit rather than 5,000.
          METRICS_TOKEN: ${{ secrets.METRICS_TOKEN }}
          GITHUB_REPOSITORY: ${{ github.repository }}
          METRICS_DATA_DIR: ${{ github.workspace }}/.metrics-data
        run: node scripts/metrics/src/cli-backfill.ts

      - name: Commit and push
        working-directory: .metrics-data
        run: |
          set -euo pipefail
          git config user.name  "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add -A
          if git diff --cached --quiet; then
            echo "No change to commit"
            exit 0
          fi
          git commit -m "chore(metrics): backfill reconstructable history"
          git push origin metrics-data
```

Note this workflow deliberately has **no bootstrap step**. Backfill is meaningless before the collector exists, so requiring `metrics.yml` to have run once is the correct dependency. If the branch is absent, the checkout fails loudly, which is the right outcome.

- [ ] **Step 2: Validate the YAML**

```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/backfill.yml')); print('valid yaml')"
```

Expected: `valid yaml`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/backfill.yml
git commit -m "ci(metrics): add dispatch-only historical backfill workflow"
```

---

## Task 12: Documentation and maintainer checklist

**Files:**
- Create: `docs/systems/metrics.md`
- Modify: `CLAUDE.md`
- Modify: `docs/systems/security-scanning.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the subsystem record CLAUDE.md's documentation rule requires.

- [ ] **Step 1: Write the subsystem doc**

Create `docs/systems/metrics.md` covering, in this order:

1. **Why this exists** — GitHub retains traffic for 14 days; no API reconstructs it; every uncollected day is destroyed permanently.
2. **What is and is not recoverable** — copy the table from spec section 1.
3. **Architecture** — `scripts/metrics` package, orphan `metrics-data` branch, the two workflows.
4. **Data schemas** — every file, every column, copied from spec section 5.1 and 5.3, including that dimensional rows are trailing-14-day aggregates and that an absent dimension means "outside the top 10", never zero.
5. **Write semantics** — fetch-wins for the collector, write-if-absent for backfill, atomicity, no zero-filling. State the unstar hazard explicitly.
6. **The 202 problem** — `/stats/contributors` returns 202 while computing, the cache is reset by every push to `main`, and a persistent 202 is a skip and never a zero.
7. **Field-name traps** — copy spec section 5.6 verbatim: `watchers_count` is stars and `subscribers_count` is watchers; the repo object's `open_issues` includes PRs; `/stargazers` is admin/collaborator-gated as of July 2026.
8. **Token setup** — a fine-grained PAT, this repo only, `Administration: read` plus `Contents: read`, stored as `METRICS_TOKEN`. Note there is no `administration` key in the Actions permissions vocabulary, so this cannot be replaced by `GITHUB_TOKEN`.
9. **The 60-day hazard** — scheduled workflows are disabled after 60 days of no repository activity; the collector's commits go to a non-default branch with `GITHUB_TOKEN` and cannot be relied on to reset that timer; `gh workflow enable` runs every execution; the dashboard's staleness warning is the backstop.
10. **Operations** — how to run a backfill, how to recover from a gap (any gap of 13 days or less self-heals), what a rejected push means, and how to read `meta.json`.
11. **Adding a repo** — the slug comes from `github.repository`; a second repo needs a file-layout decision first, since paths are currently flat.

- [ ] **Step 2: Add the CLAUDE.md subsystem table row**

Add to the subsystem documentation table in `CLAUDE.md`, keeping the existing column format:

```markdown
| [metrics.md](docs/systems/metrics.md) | Traffic archive: daily collection into the `metrics-data` branch, CSV/NDJSON schemas, upsert and write-if-absent semantics, backfill, the 202 stats problem, PAT scopes, the 60-day schedule hazard, dashboard | Any repo-analytics work, changing collected series, debugging a stalled collector |
```

- [ ] **Step 3: Add the monorepo structure entry**

In the `## Monorepo Structure` block in `CLAUDE.md`, add below the `packages/` tree:

```
scripts/
  metrics/  — @backspace/metrics: repo traffic collector (workspace package)
```

Then add this sentence after the block: "The metrics subsystem spans `scripts/metrics` (a workspace package) and `site/insights` (a static page, not a workspace)."

- [ ] **Step 4: Add the maintainer checklist entries**

In `docs/systems/security-scanning.md`, under the existing "Maintainer checklist (one-time GitHub settings — NOT code)" heading, append:

```markdown
- [ ] Create a fine-grained PAT scoped to this repository only, with
      **Administration: read** and **Contents: read**, and store it as the
      `METRICS_TOKEN` repository secret. Traffic endpoints are unreachable
      without it — there is no `administration` key in the Actions
      `permissions:` vocabulary, so `GITHUB_TOKEN` cannot substitute.
- [ ] Create a ruleset on the `metrics-data` branch blocking **deletion** and
      **force-push**, with no bypass actors, matching the existing
      `cla-signatures` ruleset. Do NOT require pull requests or status checks:
      the collector commits directly. This branch holds the only irreplaceable
      data in the repository.
```

- [ ] **Step 5: Verify nothing is stale**

```bash
grep -c "metrics.md" CLAUDE.md
grep -c "METRICS_TOKEN" docs/systems/security-scanning.md docs/systems/metrics.md
```

Expected: `1` for CLAUDE.md, and at least `1` for each of the other two files.

- [ ] **Step 6: Commit**

```bash
git add docs/systems/metrics.md docs/systems/security-scanning.md CLAUDE.md
git commit -m "docs(metrics): document the traffic archive subsystem"
```

---

## Task 13: End-to-end verification against the live repo

**Files:** none created. This task proves the pipeline works before it is trusted with irreplaceable data.

**Interfaces:**
- Consumes: everything above.
- Produces: the Definition-of-Done evidence.

- [ ] **Step 1: Confirm the maintainer prerequisites exist**

Task 12 Step 4 lists two settings only the repo owner can apply. Confirm both before proceeding:

```bash
gh secret list --repo TheZwiss/backspace | grep METRICS_TOKEN
gh api repos/TheZwiss/backspace/rulesets --jq '.[] | .name'
```

Expected: `METRICS_TOKEN` is listed, and a ruleset covering `metrics-data` appears. If either is missing, stop and ask the maintainer — do not proceed.

- [ ] **Step 2: Run the collector once by hand**

```bash
gh workflow run metrics.yml --repo TheZwiss/backspace
sleep 60
gh run list --workflow metrics.yml --repo TheZwiss/backspace --limit 1
```

Expected: the run concludes `success`.

- [ ] **Step 3: Verify the data landed**

```bash
git fetch origin metrics-data
git show origin/metrics-data:traffic/views.csv | head -5
git show origin/metrics-data:meta.json
```

Expected: `views.csv` has a header plus up to 14 dated rows, and `meta.json` has a non-null `last_success`.

- [ ] **Step 4: Prove idempotency, which is the core storage guarantee**

```bash
BEFORE=$(git show origin/metrics-data:traffic/views.csv | sha256sum)
gh workflow run metrics.yml --repo TheZwiss/backspace
sleep 60
git fetch origin metrics-data
AFTER=$(git show origin/metrics-data:traffic/views.csv | sha256sum)
echo "before: $BEFORE"
echo "after:  $AFTER"
```

Expected: identical for every date before today. Today's row may legitimately differ, because the traffic window is still accumulating — this is why the Definition of Done says "byte-identical for all dates before the current UTC day" rather than "a no-op".

If dates *before* today changed, stop: the upsert is not stable and the archive cannot be trusted.

- [ ] **Step 5: Run the backfill and prove it preserved measured data**

```bash
BEFORE=$(git show origin/metrics-data:stars.csv | sha256sum)
gh workflow run backfill.yml --repo TheZwiss/backspace
sleep 90
git fetch origin metrics-data
git show origin/metrics-data:stars.csv | head -5
git show origin/metrics-data:stars.csv | wc -l
```

Expected: many more rows than before, reaching back to 2026-02-18, **and** every date that already existed still carries its original value. Spot-check today's row against `BEFORE`.

- [ ] **Step 6: Confirm backfill did not touch traffic**

```bash
git log origin/metrics-data --oneline -1 --name-only
```

Expected: the backfill commit lists only `stars.csv`, `forks.csv`, and `releases.csv`. If any `traffic/` path appears, the write-if-absent guard has a hole — stop and fix it before the next daily run.

- [ ] **Step 7: Confirm two consecutive daily runs**

Wait for the next scheduled 03:00 UTC run, then:

```bash
gh run list --workflow metrics.yml --repo TheZwiss/backspace --limit 3
git log origin/metrics-data --oneline -5
```

Expected: two successful scheduled runs on consecutive days, each with its own snapshot commit.

- [ ] **Step 8: Final check of the whole workspace**

```bash
pnpm -r test
```

Expected: PASS, including `@backspace/metrics`.

WS1 is complete. The archive is accruing. WS2 (`plan-b-metrics-bundle-deploy.md`) and WS3 (`plan-c-metrics-dashboard.md`) can now proceed at any pace without further data being at risk.
