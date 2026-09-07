/*
 * Builds a throwaway metrics archive, and a throwaway copy of the site, for
 * checking `site/insights/index.html` by hand.
 *
 * The page has no automated tests and cannot get any without a new
 * dependency (`docs/systems/metrics.md` section 11), so this script and
 * `insights-check.mjs` beside it stand in for them. Committed rather than
 * kept in a scratchpad so the next person can reproduce an observation
 * without rebuilding the harness first.
 *
 * It writes nothing inside the repository. Everything lands under the output
 * directory given on the command line, which is disposable.
 *
 * Usage:
 *   node scripts/metrics/fixtures/insights-fixture.mjs <outDir> [mode]
 *   node scripts/metrics/fixtures/insights-fixture.mjs <outDir> --strip-telemetry
 *
 * Modes:
 *   none         no telemetry files in the archive, so the bundle holds a
 *                telemetry block with no rows and the page says no instance
 *                has reported yet
 *   low          four instances in the last seven days, below the mark
 *   threshold    exactly ten, the mark itself, which is the value the
 *                published promise turns on
 *   high         fourteen, above the mark, with all three dimension files
 *                populated
 *   high-other   fourteen, with the three dimensions shaped to show what
 *                `high` cannot: `other` ranked mid-list on one card and first
 *                on another, and a dimension holding a single row
 *   high-nodims  above the mark, but the three dimension files are empty
 *   sparse       above the mark on the last row only, with every earlier
 *                gauge blank
 *
 * `--strip-telemetry` is a second pass, run after `cli-bundle.ts` rather than
 * before it. `buildDashboardData` always writes a `telemetry` key, so no set
 * of archive files can produce the bundle a page built before the pings
 * existed would read. Deleting the key from the built `data.json` is the only
 * way to reach that state, and it is the one wording of the section's three
 * the modes above cannot show.
 *
 * The output directory mirrors the deployed layout, so `../assets/logo.png`
 * and `../assets/dm-sans.woff2` resolve from the page exactly as they do in
 * production:
 *
 *   <outDir>/archive/          the metrics archive `cli-bundle.ts` reads
 *   <outDir>/site/assets/      copied from `site/assets`
 *   <outDir>/site/insights/    copied from `site/insights`
 *
 * Serve `<outDir>/site` and open `/insights/`.
 */
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../src/store.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const MODES = new Set(['none', 'low', 'threshold', 'high', 'high-other', 'high-nodims', 'sparse']);

const [, , outDirArg, mode = 'high'] = process.argv;
if (outDirArg === undefined) {
  console.error('usage: node insights-fixture.mjs <outDir> [mode|--strip-telemetry]');
  process.exit(2);
}
if (mode === '--strip-telemetry') {
  // Edits the bundle in place and touches nothing else, so the archive and
  // the copied site stay exactly as the earlier pass left them.
  const dataPath = path.join(path.resolve(outDirArg), 'site/insights/data.json');
  const data = JSON.parse(readFileSync(dataPath, 'utf8'));
  if (data.telemetry === undefined) {
    console.error(`${dataPath} has no telemetry key. Run the bundle step first.`);
    process.exit(2);
  }
  delete data.telemetry;
  writeFileSync(dataPath, JSON.stringify(data));
  console.log(`telemetry key removed from ${dataPath}`);
  process.exit(0);
}
if (!MODES.has(mode)) {
  console.error(`unknown mode "${mode}". One of: ${[...MODES].join(', ')}`);
  process.exit(2);
}

const outDir = path.resolve(outDirArg);
const archive = path.join(outDir, 'archive');
const site = path.join(outDir, 'site');
rmSync(outDir, { recursive: true, force: true });
mkdirSync(archive, { recursive: true });
cpSync(path.join(REPO_ROOT, 'site/insights'), path.join(site, 'insights'), { recursive: true });
// The page loads `../assets/logo.png` and `../assets/dm-sans.woff2`. Without
// these the run reports two 404s, which makes a clean-console check
// impossible to pass and hides a real failure behind expected noise.
cpSync(path.join(REPO_ROOT, 'site/assets'), path.join(site, 'assets'), { recursive: true });

const day = (i) => new Date(Date.UTC(2026, 7, 1 + i)).toISOString().slice(0, 10);
const DAYS = 40;
const s = createStore(archive);

// Traffic, so the bundle is not `empty` and the range control has an anchor.
s.writeCsv('traffic/views.csv', ['date', 'count', 'uniques'],
  Array.from({ length: DAYS }, (_, i) => ({ date: day(i), count: 40 + i, uniques: 10 + i })));
s.writeCsv('traffic/clones.csv', ['date', 'count', 'uniques'],
  Array.from({ length: DAYS }, (_, i) => ({ date: day(i), count: 5 + i, uniques: 3 })));
s.writeCsv('stars.csv', ['date', 'total'],
  Array.from({ length: DAYS }, (_, i) => ({ date: day(i), total: 60 + i })));
s.writeCsv('forks.csv', ['date', 'total'],
  Array.from({ length: DAYS }, (_, i) => ({ date: day(i), total: 4 })));
s.writeCsv('contributors.csv', ['date', 'total'], [{ date: day(0), total: 2 }]);
s.writeCsv('workflows.csv', ['date', 'runs'],
  Array.from({ length: DAYS }, (_, i) => ({ date: day(i), runs: 12 })));
s.writeCsv('repo.csv',
  ['date', 'subscribers', 'open_issues', 'downloads_total', 'downloads_app', 'downloads_updates'],
  Array.from({ length: DAYS }, (_, i) => ({
    date: day(i), subscribers: 9, open_issues: 3,
    downloads_total: 100 + i, downloads_app: 40 + i, downloads_updates: 60,
  })));
s.writeCsv('releases.csv', ['date', 'tag', 'name'], [{ date: day(10), tag: 'v1.1.2', name: '1.1.2' }]);
s.writeNdjson('traffic/referrers.ndjson',
  [{ snapshot_date: day(DAYS - 1), dimension: 'github.com', title: '', count: 30, uniques: 12 }]);
s.writeNdjson('traffic/paths.ndjson',
  [{ snapshot_date: day(DAYS - 1), dimension: '/TheZwiss/backspace', title: 'backspace', count: 40, uniques: 15 }]);
s.writeMeta({
  last_run: '2026-09-09T15:19:00.000Z', last_success: '2026-09-09T15:19:00.000Z',
  error: null, series_last_date: {},
});

const NETWORK = ['date', 'instances_1d', 'instances_7d', 'instances_30d', 'users_registered',
  'users_active1d', 'users_active7d', 'users_active30d', 'messages7d', 'storage_mib',
  'voice_instances', 'federation_instances'];

/* The last row's `instances_7d`, which is the only figure the gate reads. */
const TOP = { low: 4, threshold: 10 };

if (mode !== 'none') {
  const top = TOP[mode] ?? 14;
  const rows = Array.from({ length: 20 }, (_, i) => {
    const n = Math.max(1, top - (19 - i));
    const blank = mode === 'sparse';
    const v = (x) => (blank ? '' : x);
    return {
      date: day(DAYS - 20 + i),
      instances_1d: v(Math.max(1, n - 2)), instances_7d: blank ? '' : n, instances_30d: v(n + 2),
      users_registered: v(n * 9), users_active1d: v(n * 2), users_active7d: v(n * 4),
      users_active30d: v(n * 6), messages7d: v(n * 120), storage_mib: v(n * 40),
      voice_instances: v(Math.floor(n / 2)), federation_instances: v(Math.floor(n / 3)),
    };
  });
  // `sparse` still needs the threshold cleared, so its final row measures the gate.
  if (mode === 'sparse') rows[rows.length - 1].instances_7d = top;
  s.writeCsv('telemetry/network.csv', NETWORK, rows);

  const snap = day(DAYS - 1);
  if (mode === 'high-nodims') {
    s.writeNdjson('telemetry/versions.ndjson', []);
    s.writeNdjson('telemetry/countries.ndjson', []);
    s.writeNdjson('telemetry/clients.ndjson', []);
  } else if (mode === 'high-other') {
    // `high` gives `other` the lowest count, tied for last, so a run against
    // it cannot tell "ranked where its count places it" from "pinned to the
    // bottom". These counts can: `other` sits second among the versions and
    // first among the client kinds. Countries holds a single row, and the
    // client kinds are dominated by the folded remainder, so the two ranking
    // shapes with no second example anywhere else are covered here too.
    s.writeNdjson('telemetry/versions.ndjson', [
      { snapshot_date: snap, dimension: '1.1.2', title: '', count: 8, uniques: 8 },
      { snapshot_date: snap, dimension: 'other', title: '', count: 5, uniques: 5 },
      { snapshot_date: snap, dimension: '1.1.0', title: '', count: 3, uniques: 3 },
    ]);
    s.writeNdjson('telemetry/countries.ndjson', [
      { snapshot_date: snap, dimension: 'DE', title: '', count: 14, uniques: 14 },
    ]);
    s.writeNdjson('telemetry/clients.ndjson', [
      { snapshot_date: snap, dimension: 'other', title: '', count: 97, uniques: 97 },
      { snapshot_date: snap, dimension: 'web', title: '', count: 40, uniques: 40 },
      { snapshot_date: snap, dimension: 'desktop', title: '', count: 1, uniques: 1 },
    ]);
  } else {
    s.writeNdjson('telemetry/versions.ndjson', [
      { snapshot_date: snap, dimension: '1.1.2', title: '', count: 8, uniques: 8 },
      { snapshot_date: snap, dimension: '1.1.0', title: '', count: 3, uniques: 3 },
      { snapshot_date: snap, dimension: 'other', title: '', count: 3, uniques: 3 },
    ]);
    s.writeNdjson('telemetry/countries.ndjson', [
      { snapshot_date: snap, dimension: 'DE', title: '', count: 7, uniques: 7 },
      { snapshot_date: snap, dimension: 'US', title: '', count: 4, uniques: 4 },
      { snapshot_date: snap, dimension: 'ZZ', title: '', count: 3, uniques: 3 },
    ]);
    s.writeNdjson('telemetry/clients.ndjson', [
      { snapshot_date: snap, dimension: 'web', title: '', count: 40, uniques: 40 },
      { snapshot_date: snap, dimension: 'desktop', title: '', count: 12, uniques: 12 },
      { snapshot_date: snap, dimension: 'mobile', title: '', count: 1, uniques: 1 },
    ]);
  }
}
console.log(`fixture ready: mode ${mode}, archive ${archive}, site ${site}`);
