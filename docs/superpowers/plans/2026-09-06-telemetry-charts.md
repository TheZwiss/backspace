# Telemetry Charts (Track F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw the instance-telemetry charts on the existing insights page behind the ten-instance publication threshold, and clear the six deferred review findings the telemetry branch left open.

**Architecture:** `site/insights/index.html` gains one more panel and one more registered section, built the way the four existing sections are: it reads only the already-published `telemetry` block of `data.json`, draws two time-series cards through the page's single `INSIGHTS_CHARTS.mount` path, and renders three ranked lists with the existing `.rank-*` markup. Below the threshold, or on a bundle built before telemetry existed, the section renders a short stated reason instead of charts. Nothing about the collector, the bundle contract or the archive changes for the charts; the six deferred findings are separate, self-contained fixes across `scripts/metrics`, `packages/server` and `packages/web`.

**Tech Stack:** Plain ES5-style browser JavaScript inline in one HTML file, vendored uPlot 1.6.32, TypeScript with Node type stripping (`scripts/metrics`), Fastify + Drizzle (`packages/server`), React 18 + i18next (`packages/web`), Vitest everywhere.

**Spec:** `docs/superpowers/specs/2026-09-06-instance-telemetry-design.md` (section 9 is Track F; sections 6 to 8 define the collector output the charts consume). Deferred findings source: the review ledger's deferred-minor lines, quoted verbatim in each task.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **No new dependencies.** uPlot is vendored under `site/insights/vendor/`; use it. No other chart library, no DOM test harness, no polyfill.
- **The insights bundle stays under 2 MB.** `BUNDLE_BUDGET_BYTES` is `2 * 1024 * 1024`. The charts read only from `data.json`; the page makes no extra network request of any kind.
- **The telemetry section must render identically whether or not the `telemetry` block exists in `data.json`.** A bundle built before telemetry shipped has no `telemetry` key at all. That case degrades to the same explanatory empty state, never to a thrown section and never to a blank panel.
- **Section label:** exactly `opt-in numbers, lower bound`. It is the section's `<h2>`, with a leading capital as every other `<h2>` on the page has (`Opt-in numbers, lower bound`); the words themselves are not altered.
- **Below the threshold the section shows a short explanatory empty state that names the threshold (10) and the current count**, never nothing and never an empty frame.
- **Copy rules for all text, comments and commit messages:** no em dashes, no buzzword register, plain sentences.
- **Any user-facing string on the insights page is plain English.** The page is not localized. Any new string in `packages/web` goes through the i18n catalogs (`packages/web/src/locales/{en,de,ru}/*.json`) and passes `node scripts/check-i18n.mjs`.
- **TDD per task:** failing test first, then implementation. Test commands:
  - metrics: `pnpm --filter @backspace/metrics test` (or `cd scripts/metrics && npx vitest run` for a single file)
  - server: `pnpm --filter @backspace/server test`
  - web: `pnpm --filter @backspace/web test`
  - receiver: `cd scripts/telemetry-receiver && pnpm test`
- **Server tests need a `better-sqlite3` binary for the local Node.** The repo pins Node 20 but the local shell is Node 25, and `better-sqlite3` 12.11.1 ships a prebuild for the local Node and not for 20. Recipe, run once, touches only `node_modules`:
  ```bash
  cd /Users/jbraun/backspace-public/.claude/worktrees/instance-telemetry/node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3
  npm_config_cache=<scratchpad>/npmcache npx prebuild-install -r node
  ```
- **Receiver tests from a nested worktree** may pick up an orphaned `@vitest` from the parent checkout and refuse to start ("ChaiStyleAssertions" missing from `@vitest/expect`). Workaround: symlink each `@vitest/*` from `node_modules/.pnpm/vitest@<ver>/node_modules/@vitest/` into `scripts/telemetry-receiver/node_modules/@vitest/`. Never commit a `public-hoist-pattern` for this. Task 10 is the one task that needs it, and repeats the exact commands.
- **`site/insights/index.html` has no automated tests** (`docs/systems/metrics.md` section 11 states this, and adding a DOM harness would need a new dependency, which is forbidden). Page tasks therefore run the fixture verification in the appendix instead of a unit test: build a bundle from a controlled archive, serve the page, and check the stated observations. Where a page behaviour depends on a bundler guarantee, that guarantee is pinned by a real test in `scripts/metrics`.
- **Docs:** `docs/systems/metrics.md` and `docs/systems/telemetry.md` are updated inside the task that changes the contract they describe, never in a separate docs task.
- **Commit messages** follow the repo's conventional style (`git log --oneline -30`): `type(scope): lower-case summary`. No attribution trailers of any kind, no session links.
- **Do not run `cli-bundle.ts` with `METRICS_OUTPUT_PATH` pointing inside `site/insights/`.** It rewrites `site/insights/index.html`'s `BUILD:SUMMARY` region in place. The appendix recipe copies the page to a temp directory first.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `site/insights/index.html` | The dashboard. Gains: `.ch-rose` label colour, a nav link, the `#instances` panel with slot `telemetry`, `"telemetry"` in `SLOT_IDS`, a `telemetry`-aware branch in `validateBundle`, and one new section IIFE at the end of the body. | F1, F2, F3, M4 |
| `docs/systems/metrics.md` | Bundle contract, page states, section inventory, weekly bucketing, backfill semantics, JSON-LD inventory. | F1, F2, F3, M1, M3, M4 |
| `docs/systems/telemetry.md` | Section 9 currently says the charts come later; section 4's activity-write rule and section 8's receiver contract both change too. | F1, M5, M7 |
| `scripts/metrics/src/backfill.ts` + `backfill.test.ts` | Historical reconstruction; the oldest-ping boundary. | M1 |
| `scripts/metrics/src/datapage.ts` + `datapage.test.ts` | Static data tables and their own `Dataset` block. | M2, M4 |
| `scripts/metrics/src/bundle.ts` + `bundle.telemetry.test.ts` | `instances7d` on the downsampled path. | M3 |
| `scripts/metrics/src/summary.ts` + `summary.test.ts` | `SummaryFacts` and the regenerated `Dataset` block for the charted page. | M4 |
| `scripts/metrics/src/cli-support.ts` + `cli-support.test.ts`, `cli-collect.ts`, `cli-backfill.ts` | The testable core of the entrypoints: the missing-token notice and the endpoint override. | M8 |
| `.github/workflows/metrics.yml`, `.github/workflows/backfill.yml` | One `env:` line each for `vars.TELEMETRY_ENDPOINT`. SHA pins, permissions and fork guards untouched. | M8 |
| `scripts/telemetry-receiver/src/{index,store,validate}.ts` + `index.test.ts` | The export's row and byte caps, the truncation header, and the calendar check on the range. | M7 |
| `packages/server/src/ws/handler.ts` + `src/ws/activityTouch.test.ts` | The warning throttle and the per-connection once-a-day activity write. | M5 |
| `packages/web/src/components/telemetry/TelemetryAsk.tsx` + `.test.tsx`, `PayloadPreview.tsx`, `src/utils/telemetryAsk.ts`, `src/stores/settingsStore.ts`, `src/locales/{en,de,ru}/telemetry.json` | The ask's fetch gating and its preview error state. | M6 |

---

## Task 1 (F1): The telemetry panel, the threshold gate and the empty state

**Files:**
- Modify: `site/insights/index.html` (CSS near line 267, nav near line 522, markup after the `#paths` panel near line 679, `SLOT_IDS` at line 759, `validateBundle` at line 984, new `<script>` block immediately before `</body>` at line 5798)
- Modify: `docs/systems/metrics.md` (section 10.6, and a new section 10.8)
- Modify: `docs/systems/telemetry.md` (section 9, the paragraph beginning "Everything collected is published from the first day")
- Test: `scripts/metrics/src/bundle.telemetry.test.ts` (one new test pinning the guarantee the page's gate relies on)

**Interfaces:**
- Consumes: `window.INSIGHTS` (`registerSection`, `rangeWindow`, `formatCount`, `formatDay`, `parseDay`, `DASH`) and `window.INSIGHTS_CHARTS` (nothing yet in this task), both already published by the page's earlier scripts.
- Produces, for Tasks 2 and 3, inside the new IIFE:
  - `var THRESHOLD = 10;`
  - `function el(tag, className, text) -> Element`
  - `function pair(key, value) -> HTMLSpanElement` (a `.k`/`.v` pair for a `.chart-meta` line)
  - `function telemetryOf(data) -> object | null` (the block, or null when the bundle carries none)
  - `function stateNote(sentences) -> HTMLDivElement` (a `div.slot-note.slot-note-detail` holding one `<p>` per sentence)
  - `var live = [];` and `function teardown()` releasing every uPlot instance in it
  - `function render(slot, data, rangeKey)` registered as `I.registerSection("telemetry", render, teardown)`

- [ ] **Step 1: Write the failing test**

The page's gate reads `data.telemetry.instances7d` and compares it with 10. The bundler guarantee it depends on is that a block whose latest day did not measure `instances_7d` yields `null`, and that a block with no telemetry files at all still yields a well-formed object. The second half is already covered; the first half is covered for the daily path only. Add the case the gate actually meets on the live archive: an archive whose telemetry files exist but hold no rows at all.

Append to `describe('telemetry block', ...)` in `scripts/metrics/src/bundle.telemetry.test.ts`:

```ts
  it('yields a well-formed block with a null threshold when the files exist but hold no rows', () => {
    // The state between the collector's first telemetry-enabled run and the
    // first archived ping. The page reads `instances7d` and nothing else to
    // decide whether to draw, so this must be a clean null rather than an
    // absent field: `undefined < 10` is false, and a gate written against it
    // would publish charts over an empty fleet.
    const s = store();
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, []);
    s.writeNdjson('telemetry/versions.ndjson', []);

    const block = buildDashboardData(s, '2026-09-06T00:00:00Z').telemetry;

    expect(block.instances7d).toBeNull();
    expect(block.network.dates).toEqual([]);
    expect(block.versions.latest).toEqual([]);
    expect(block.versions.snapshots).toEqual([]);
  });
```

- [ ] **Step 2: Run the test and confirm it passes or fails for the right reason**

Run: `cd scripts/metrics && npx vitest run src/bundle.telemetry.test.ts`

Expected: PASS. This one pins existing behaviour rather than driving new code, which is the honest shape for a guarantee the untested page relies on. If it FAILS, stop: the gate's premise is wrong and the bundler must be fixed before the page is written.

- [ ] **Step 3: Add the label colour and the nav link**

In `site/insights/index.html`, after the `.ch-amber::before` rule (line 267):

```css
.ch-rose::before { color: var(--rose); }
```

In the header nav, after the `#paths` link (line 522):

```html
    <a class="nav-link" href="#instances">Instances</a>
```

- [ ] **Step 4: Add the panel markup**

After the closing `</section>` of the `#paths` panel and before `</main>`:

```html
  <section class="panel" id="instances">
    <div class="wrap">
      <p class="ch-label ch-rose">opt-in-numbers</p>
      <h2>Opt-in numbers, lower bound</h2>
      <p class="sec-copy">
        Everything above measures this repository on GitHub. This section measures something
        else: the Backspace instances people actually run. A self-hosted instance can choose
        to send one small ping a day, and most do not, so <strong>every figure here is a lower
        bound</strong> rather than a total. An instance that never opts in is invisible, counts
        arrive rounded to two significant digits, and an instance is counted only once it has
        reported on two separate days inside the last thirty. A ping carries no domain, no
        instance or account name, no message content, no file names and no address.
      </p>
      <p class="sec-copy">
        Nothing is charted until at least ten instances have reported inside the same seven
        days. Three points plotted as a line claim a shape the data does not have, so below that
        mark this section states the count instead of drawing it. The figures themselves are
        public from the first archived ping either way, in the
        <a href="data/">plain tables</a>.
      </p>
      <div class="slot" id="telemetry"></div>
    </div>
  </section>
```

- [ ] **Step 5: Register the slot with the shell**

At line 759, extend `SLOT_IDS` so the loading and empty page states fill this slot too:

```js
  var SLOT_IDS = ["header-stats", "chart-reach", "chart-growth", "ranked-referrers", "ranked-paths", "telemetry"];
```

- [ ] **Step 6: Validate the telemetry block when it is present**

`validateBundle` currently ignores `telemetry` entirely. Metrics section 10.7's trap 2 says every series a renderer indexes into must be checked here, but a hard check would reject every bundle built before telemetry shipped. So: absent is fine, present is fully checked.

Add these two helpers immediately after `checkDimension` (which ends at line 966):

```js
  /*
   * The telemetry block, checked only when the bundle carries one.
   *
   * ABSENT IS VALID and that is the whole point of splitting this out. The
   * `telemetry` key entered the contract long after the first bundles were
   * built, and a page that rejected a bundle without it would answer an old
   * artefact with "the archive is not available" -- a claim about the archive,
   * made because of a key the archive predates.
   *
   * PRESENT AND MALFORMED IS NOT VALID, for the reason every other series is
   * checked here: the telemetry section indexes these arrays without
   * re-checking them, and a ragged column would shift a whole chart sideways
   * with nothing on the page to show it.
   */
  function checkTelemetry(value) {
    if (value === undefined) return null;
    if (!isPlainObject(value)) return "telemetry is neither an object nor absent";
    var problem = checkSeries(value.network, "telemetry.network", [
      "instances_1d", "instances_7d", "instances_30d",
      "users_registered", "users_active1d", "users_active7d", "users_active30d",
      "messages7d", "storage_mib", "voice_instances", "federation_instances"
    ]) ||
      checkDimension(value.versions, "telemetry.versions") ||
      checkDimension(value.countries, "telemetry.countries") ||
      checkDimension(value.clients, "telemetry.clients");
    if (problem !== null) return problem;
    if (!isNumberOrNull(value.instances7d)) {
      return "telemetry.instances7d is neither a number nor null";
    }
    return null;
  }
```

and change `validateBundle`'s final statement (line 1006) from

```js
    return checkDimension(d.dimensions.referrers, "dimensions.referrers") ||
      checkDimension(d.dimensions.paths, "dimensions.paths");
```

to

```js
    return checkDimension(d.dimensions.referrers, "dimensions.referrers") ||
      checkDimension(d.dimensions.paths, "dimensions.paths") ||
      checkTelemetry(d.telemetry);
```

- [ ] **Step 7: Add the section script**

Insert this whole `<script>` block immediately before `</body>`, after the ranked-dimensions script:

```html
<script>
/*
 * Section "telemetry" -- spec section 9's opt-in fleet figures.
 *
 * Registered like every other section, so it inherits the same guarantees: it
 * is called only with a validated, non-empty bundle, its slot is emptied
 * before every call, and a throw is contained to this slot.
 *
 * Two things make it different from the four sections above it.
 *
 * 1. THE BLOCK MAY NOT BE THERE. `telemetry` entered the bundle contract long
 *    after the page shipped, and `validateBundle` accepts a bundle without it
 *    on purpose. So every read starts from `telemetryOf`, which answers null
 *    for an old bundle, and the section says so rather than throwing.
 *
 * 2. IT IS GATED. Nothing is drawn until the latest `instances_7d` reaches
 *    ten. The gate reads `telemetry.instances7d`, which the bundler carries as
 *    its own field precisely so this comparison is a comparison and not
 *    arithmetic over a parallel array, and which is the LAST day's value
 *    rather than the last measured one -- a threshold answered from an older
 *    row would publish charts on a bar that is no longer cleared.
 *
 * Below the gate the section prints the count and the mark. Printing nothing
 * would read as a broken collector, and the figures are public in the data
 * tables regardless: the threshold governs drawing a line, not disclosing a
 * number.
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var C = window.INSIGHTS_CHARTS;

  /* Spec section 9. Ten instances inside the trailing seven days. */
  var THRESHOLD = 10;

  /* Every uPlot instance this section has built, for teardown. Empty until
   * Task 2 puts charts in it; the teardown is written now so the section owes
   * one from its first render, as the shell's contract requires. */
  var live = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pair(key, value) {
    var span = el("span");
    span.appendChild(el("span", "k", key));
    span.appendChild(document.createTextNode(" "));
    span.appendChild(el("span", "v", value));
    return span;
  }

  /*
   * The telemetry block, or null when this bundle carries none.
   *
   * `validateBundle` has already accepted whatever is here, so a non-null
   * answer is structurally sound and every later read can index it directly.
   */
  function telemetryOf(data) {
    var block = data.telemetry;
    return block === undefined || block === null ? null : block;
  }

  /*
   * A stated reason, not a failure. `slot-note-detail` is the page's existing
   * variant for exactly this: solid rather than dashed, and readable rather
   * than dimmed, because the words are the content here and not a placeholder
   * standing in for it.
   */
  function stateNote(sentences) {
    var box = el("div", "slot-note slot-note-detail");
    for (var i = 0; i < sentences.length; i++) {
      box.appendChild(el("p", null, sentences[i]));
    }
    return box;
  }

  /* The newest snapshot date across the whole block, as the page prints dates,
   * or null when nothing is dated. Used to say WHEN the count below the
   * threshold was taken, so the reader is not left to assume it is current. */
  function latestDay(block) {
    var dates = block.network.dates;
    if (dates.length === 0) return null;
    var ms = I.parseDay(dates[dates.length - 1]);
    return isNaN(ms) ? null : I.formatDay(ms);
  }

  /* The sentence naming the current count and the mark. Three cases, because
   * "no bundle", "no rows" and "some rows, not enough" are three different
   * statements and collapsing them would have the page assert one it cannot
   * support. */
  function belowThresholdNote(block) {
    if (block === null) {
      return stateNote([
        "This page was built from a bundle made before the instance pings were collected, so it carries no fleet figures at all.",
        "Charts appear here once at least " + THRESHOLD +
          " instances have reported inside the same seven days. Until then the figures, when there are any, are in the plain tables linked above."
      ]);
    }
    var count = block.instances7d;
    var day = latestDay(block);
    if (typeof count !== "number") {
      return stateNote([
        block.network.dates.length === 0
          ? "No instance has reported yet, so there is nothing to count."
          : "The most recent archived day did not measure how many instances reported in the seven days ending on it, so the count for that day is unknown rather than low.",
        "Charts appear here once at least " + THRESHOLD +
          " instances have reported inside the same seven days."
      ]);
    }
    return stateNote([
      I.formatCount(count) + " " + (count === 1 ? "instance" : "instances") +
        " reported inside the seven days ending " + (day === null ? "on the archive's most recent day" : day) + ".",
      "Charts appear here once that count reaches " + THRESHOLD +
        ". A line through a handful of points says more about those instances than about the project, so below the mark this section states the count instead of drawing it. Every figure the archive holds is in the plain tables linked above from the first archived ping."
    ]);
  }

  function render(slot, data, rangeKey) {
    var block = telemetryOf(data);
    if (block === null || typeof block.instances7d !== "number" || block.instances7d < THRESHOLD) {
      slot.appendChild(belowThresholdNote(block));
      return;
    }
    /* The cleared-threshold branch. It states the count until the cards below
     * it exist, and is replaced wholesale once they do. */
    var day = latestDay(block);
    slot.appendChild(stateNote([
      I.formatCount(block.instances7d) + " instances reported inside the seven days ending " +
        (day === null ? "on the archive's most recent day" : day) + ".",
      "The charts for this section are not built yet."
    ]));
  }

  /*
   * Runs before the slot is emptied, including after a render that threw, so
   * it must be safe on a partial build. `live` is cleared first so a destroy
   * that throws cannot leave a half-released instance to be destroyed twice;
   * the first failure is re-thrown once the rest are released.
   */
  function teardown() {
    var pending = live;
    live = [];
    var failure = null;
    for (var i = 0; i < pending.length; i++) {
      try {
        pending[i].destroy();
      } catch (error) {
        if (failure === null) failure = error;
      }
    }
    if (failure !== null) throw failure;
  }

  I.registerSection("telemetry", render, teardown);
})();
</script>
```

- [ ] **Step 8: Verify against fixtures**

Run the appendix recipe three times and confirm each observation:

1. `--telemetry none` (no `telemetry/` files at all): the panel renders, and the note is the "built from a bundle made before the instance pings were collected" wording. Nothing in the console.
2. `--telemetry low` (latest `instances_7d` is 4): the note reads `4 instances reported inside the seven days ending <date>.` and names 10.
3. `--telemetry high` (latest `instances_7d` is 14): the note reads `14 instances reported ...` followed by "The charts for this section are not built yet."

Also confirm in every case that the four existing sections still render and that `#instances` is reachable from the nav.

- [ ] **Step 9: Update the docs**

In `docs/systems/metrics.md` section 10.6, the `ok` row of the page-status table currently reads "the five sections render". Change it to "the six sections render". Then add a new section immediately after 10.7:

```markdown
### 10.8 The telemetry section and its publication threshold

The sixth section, slot `telemetry`, draws the opt-in fleet figures. Two rules
govern it and neither is negotiable from inside the section.

**The `telemetry` block may be absent, and that is valid.** `validateBundle`
checks it only when it is present (`checkTelemetry`). A bundle built before the
key entered the contract must still load: rejecting it would answer an old
artefact with "the archive is not available", which is a claim about the
archive made because of a key the archive predates. Present and malformed is
still rejected, for the reason every other series is checked -- the section
indexes these arrays without re-checking them.

**Nothing is charted until the latest `instances_7d` reaches 10** (spec section
9). The gate reads `telemetry.instances7d`, which the bundler carries as its own
field so the page compares rather than computes, and which is the last DAY's
value rather than the last measured one. Below the mark the section prints the
count and the threshold in a `slot-note-detail`, in one of three wordings: no
block at all, a block whose latest day did not measure the column, and a real
count below ten. They are three different statements and the page does not
collapse them into one. Printing nothing would read as a broken collector, and
the figures are public in `/insights/data/` from the first archived ping either
way: the threshold governs drawing a line, not disclosing a figure.

**`telemetry.network` is deliberately absent from `SERIES_NAMES`**, the list of
dated series allowed to anchor the range window (section 10.7, trap 1). That
list reads `data.series[name]` and telemetry is a sibling of `series`, not a
member of it -- but the substantive reason is that it must not anchor: the
collector writes the telemetry files only inside a run that also wrote the
traffic series, so a telemetry date can never lie outside the traffic history
and can never be clipped by a window the traffic anchored. Trap 1 does not
apply here, and adding it would be the change that makes it apply.
```

In `docs/systems/telemetry.md` section 9, replace the paragraph beginning "Everything collected is published from the first day it is collected" with:

```markdown
Everything collected is published from the first day it is collected, as static
tables under `/insights/data/`. The charted section on the insights page reads
the same aggregates and stays hidden until the latest 7-day instance count
reaches 10, because a chart of three instances says more about those three
instances than about the project. Below that mark the section prints the count
and the threshold rather than nothing, so a reader can see how far off it is.
See [metrics.md](metrics.md) section 10.8 for the gate and its three wordings.
```

- [ ] **Step 10: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md docs/systems/telemetry.md scripts/metrics/src/bundle.telemetry.test.ts
git commit -m "feat(insights): add the telemetry section and its publication threshold"
```

---

## Task 2 (F2): Instances and active users over time

**Files:**
- Modify: `site/insights/index.html` (the `telemetry` section IIFE added in Task 1)
- Modify: `docs/systems/metrics.md` (section 10.8, one added paragraph)

**Interfaces:**
- Consumes from Task 1: `THRESHOLD`, `el`, `pair`, `telemetryOf`, `stateNote`, `latestDay`, `belowThresholdNote`, `live`, `render`, `teardown`.
- Consumes from the chart toolkit: `C.expand(columns, win, stepDays)` where `columns` is `[{ series, field }, ...]` and `series` is any object with a `dates` array plus the named value arrays; `C.mount(host, xs, defs, settings)` returning `{ plot, destroy }`; `C.colour(token, fallback)`; `C.zeroBasedCounts`.
- Produces for Task 3: `function cardHost(stack, title, metaNodes) -> HTMLDivElement` (the card element, already appended to the stack), and `var stack`, the `div.chart-stack` built inside `render`.

Note on why `C.bind` is not used: `bind` resolves `data.series[declared.series]`, and the telemetry network series lives at `data.telemetry.network`, outside `series`. `expand` takes `[{ series, field }]` directly, so the columns are built here and named at the point of use.

- [ ] **Step 1: Write the failing test**

The bundler guarantee this task leans on is that the network series is index-aligned and that a weekly bundle keeps its columns aligned with its bucket dates, because `expand` indexes them together. `bundle.telemetry.test.ts` covers the last-value rule but not the alignment. Append:

```ts
  it('keeps every network column aligned with its dates on both paths', () => {
    // `expand` in the page walks `dates` and reads each column at the same
    // index. A column one element short would shift a whole chart sideways
    // with nothing on the page to show it, which is the failure the page's
    // own validator exists to catch and this test exists to prevent.
    const s = store();
    const rows = Array.from({ length: 10 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), i),
    );
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const daily = buildDashboardData(s, '2026-09-11T00:00:00Z').telemetry.network;
    const weekly = downsampleWeekly(buildDashboardData(s, '2026-09-11T00:00:00Z')).telemetry.network;

    for (const series of [daily, weekly]) {
      for (const name of NETWORK_HEADER.slice(1)) {
        expect((series as unknown as Record<string, unknown[]>)[name]).toHaveLength(
          series.dates.length,
        );
      }
    }
  });
```

- [ ] **Step 2: Run the test**

Run: `cd scripts/metrics && npx vitest run src/bundle.telemetry.test.ts`

Expected: PASS (it pins an existing guarantee). If it FAILS, the bundler is broken and must be fixed before any chart is drawn.

- [ ] **Step 3: Add the chart declarations and the card builder**

Inside the section IIFE, after the `THRESHOLD` declaration, add:

```js
  /*
   * The two time-series cards, and the columns each one draws.
   *
   * Both cards are counts with a true floor at zero and all three lines in a
   * card are the same kind of thing measured over three windows, so they share
   * one y scale honestly. Colours come from the Aether Drift tokens, read at
   * draw time, so the canvas stroke is the same resolved value the page uses
   * everywhere else.
   *
   * Every column here is a GAUGE describing the fleet on its date, never a
   * per-day event count. `users_active7d` and `messages7d` read like daily
   * totals and are not: they are trailing-window figures the instances
   * computed themselves. The card captions say so, because a reader who adds
   * two of these rows together gets a number that means nothing.
   */
  var CARDS = [
    {
      title: "Instances reporting",
      note: "Each line counts instances that sent a ping inside the window it names, ending on that date. " +
        "An instance is counted only after it has reported on two separate days inside the last thirty, so a single visit to the endpoint never moves a line.",
      lines: [
        { field: "instances_1d", label: "Reported that day", token: "--sky", fallback: "#7dd3fc" },
        { field: "instances_7d", label: "Within 7 days", token: "--lavender", fallback: "#c4b5fd" },
        { field: "instances_30d", label: "Within 30 days", token: "--mint", fallback: "#86efac" }
      ]
    },
    {
      title: "Active users on reporting instances",
      note: "People, not instances, and only the ones on instances that opted in. " +
        "A user counts as active on a day their client held an authenticated connection, at day precision and no finer.",
      lines: [
        { field: "users_active1d", label: "Active that day", token: "--amber", fallback: "#fcd34d" },
        { field: "users_active7d", label: "Active within 7 days", token: "--peach", fallback: "#fca5a5" },
        { field: "users_active30d", label: "Active within 30 days", token: "--coral", fallback: "#fb923c" }
      ]
    }
  ];
```

and after `stateNote`, the shared card builder:

```js
  /*
   * A card shell in the page's chart language: a title and a meta line, with
   * the body left to the caller. Returned unfinished so a chart card and a
   * ranked card can share the top of it.
   *
   * The card is appended to the stack BEFORE it is returned, because uPlot is
   * given an explicit pixel size and that size is measured from a container
   * that has to already be in the document.
   */
  function cardHost(stack, title, metaNodes) {
    var card = el("div", "chart-card");
    card.appendChild(el("p", "chart-title", title));
    if (metaNodes.length > 0) {
      var meta = el("p", "chart-meta");
      for (var i = 0; i < metaNodes.length; i++) meta.appendChild(metaNodes[i]);
      card.appendChild(meta);
    }
    stack.appendChild(card);
    return card;
  }
```

- [ ] **Step 4: Add the chart builder**

After `cardHost`:

```js
  /* The columns one card draws, in the order its lines are declared. */
  function columnsFor(network, card) {
    var columns = [];
    for (var i = 0; i < card.lines.length; i++) {
      columns.push({ series: network, field: card.lines[i].field });
    }
    return columns;
  }

  /* How much of the window this card was actually measured on, stated on the
   * card rather than only in the section copy. */
  function chartMeta(axis) {
    var measured = 0;
    for (var i = 0; i < axis.measured.length; i++) {
      if (axis.measured[i] > measured) measured = axis.measured[i];
    }
    var steps = axis.xs.length;
    var unit = axis.stepDays === 7 ? "week" : "day";
    return [
      pair("span", I.formatDay(axis.startMs) + " to " + I.formatDay(axis.endMs)),
      pair("measured", I.formatCount(measured) + " of " + I.formatCount(steps) + " " +
        unit + (steps === 1 ? "" : "s")),
      pair("reading", "a gauge on each date, never a total to add up")
    ];
  }

  /*
   * One card. Returns the mounted plot, or null when the card had no measured
   * step inside the window -- in which case the card states that instead, for
   * the reason the reach section does the same: uPlot answers an empty frame
   * with an invented 0..1 axis, and a chart that looks broken is worse than a
   * sentence that is true.
   */
  function buildCard(stack, card, axis) {
    var shell = cardHost(stack, card.title, chartMeta(axis));

    var drawable = false;
    var i;
    for (i = 0; i < axis.measured.length; i++) {
      if (axis.measured[i] > 0) drawable = true;
    }
    if (!drawable) {
      shell.appendChild(el("p", "slot-note",
        "No ping falls inside this window, so there is no line to draw. An empty frame would look like a failure rather than an absence."));
      shell.appendChild(el("p", "chart-hint", card.note));
      return null;
    }

    var host = el("div", "chart-scroll");
    shell.appendChild(host);
    shell.appendChild(el("p", "chart-hint", card.note));

    var defs = [];
    for (i = 0; i < card.lines.length; i++) {
      defs.push({
        label: card.lines[i].label,
        stroke: C.colour(card.lines[i].token, card.lines[i].fallback),
        width: 2,
        values: axis.values[i]
      });
    }
    /* Stated rather than left to the default: every line here is a count of
     * instances or of people, with a true floor at zero. */
    return C.mount(host, axis.xs, defs, { yRange: C.zeroBasedCounts });
  }
```

- [ ] **Step 5: Draw the charts from `render`**

Replace the cleared-threshold branch at the end of `render` (the `var day = latestDay(block); slot.appendChild(stateNote([...]))` block Task 1 left there) with:

```js
    var win = I.rangeWindow(data, rangeKey);
    /* Reachable on a non-empty bundle: one holding only releases or only
     * dimension snapshots has no dated series row to anchor a window to. */
    if (win === null) {
      slot.appendChild(el("p", "slot-note",
        "The archive holds no dated measurement, so there is no time axis to draw these charts on."));
      return;
    }

    var note = el("p", "chart-window");
    note.appendChild(pair("showing", win.title.toLowerCase()));
    note.appendChild(pair("window",
      I.formatDay(win.startMs) + " → " + I.formatDay(win.endMs) + I.resolutionSuffix()));
    slot.appendChild(note);

    var stepDays = I.resolutionStepDays();
    var stack = el("div", "chart-stack");
    slot.appendChild(stack);

    var created = [];
    try {
      for (var i = 0; i < CARDS.length; i++) {
        var axis = C.expand(columnsFor(block.network, CARDS[i]), win, stepDays);
        /* Before the `empty` branch: an overrun sets `empty` too, as a
         * fail-safe, and the specific reason is the more useful of the two.
         * An impossible date is a fault in the ARCHIVE, so it stops the
         * section rather than being reported as a page bug. */
        if (axis.overrun) {
          slot.appendChild(el("p", "slot-note slot-note-detail",
            "The telemetry series would run from " + I.formatDay(axis.startMs) + " to " +
            I.formatDay(axis.endMs) + ", which needs " + I.formatCount(axis.overrunSteps) +
            " points on the time axis. That is far longer than this archive can cover, so a date in the archive itself is wrong and no chart is drawn."));
          return;
        }
        var plot = buildCard(stack, CARDS[i], axis);
        if (plot !== null) created.push(plot);
      }
    } catch (error) {
      /* `live` is assigned only once every card is built, so a throw part-way
       * leaves `created` referenced by nothing but this frame and the shell's
       * teardown would release nothing. Destroy what was built here, then let
       * the shell render its failure note. */
      for (var j = 0; j < created.length; j++) {
        try {
          created[j].destroy();
        } catch (cleanupError) {
          if (typeof console !== "undefined" && typeof console.error === "function") {
            console.error("insights: releasing a telemetry chart after a failed render also failed.",
              cleanupError);
          }
        }
      }
      throw error;
    }
    live = created;
```

Note that `block` is already in scope from the gate at the top of `render`.

- [ ] **Step 6: Verify against fixtures**

Run the appendix recipe with `--telemetry high` and confirm:

1. Two chart cards appear, titled "Instances reporting" and "Active users on reporting instances", each with three lines and a legend.
2. Hovering either chart moves the cursor on the Reach and Growth charts too (one shared cursor group), and dragging sideways on any chart puts them all on the same span.
3. Each card's meta line reports a span and a measured count that match the fixture.
4. Switching the range control to 30d, 90d and all re-renders the section each time with no console error and no leaked canvas (check `document.querySelectorAll('.uplot').length` is stable across several switches).
5. Run with `--telemetry sparse` (rows present but every gauge blank on the days inside the 30d window): the card prints the "No ping falls inside this window" sentence instead of a frame.

- [ ] **Step 7: Update the docs**

Append to `docs/systems/metrics.md` section 10.8:

```markdown
**The two time-series cards do not go through `bind`.** `bind` resolves a
card's declared columns out of `data.series[...]`, and `telemetry.network` is a
sibling of `series` rather than a member of it. The section builds its
`[{ series, field }]` array directly and hands it to `expand`, which takes that
shape as its argument. Everything `bind` exists to prevent is still prevented:
each card names its own columns in its own declaration and the lines are built
from that same declaration in the same loop, so a card cannot be drawn from a
column it does not name.

Each card is expanded on its own columns, so its axis spans the days that card
was measured on. In practice both cards share a history, since a network row
carries every gauge or none, but the per-card expansion costs nothing and keeps
the section on the same rule as Reach (section 10.7).
```

- [ ] **Step 8: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md scripts/metrics/src/bundle.telemetry.test.ts
git commit -m "feat(insights): chart instances and active users over time"
```

---

## Task 3 (F3): Version, country and client rankings

**Files:**
- Modify: `site/insights/index.html` (the `telemetry` section IIFE)
- Modify: `docs/systems/metrics.md` (section 10.8, one added paragraph)

**Interfaces:**
- Consumes from Tasks 1 and 2: `el`, `pair`, `stateNote`, `cardHost`, `stack` inside `render`, `I.formatCount`, `I.parseDay`, `I.formatDay`, `C.colour`.
- Produces: nothing later tasks consume.

The three dimension series carry the same `DimensionSeries` shape the referrers and paths sections read, but this section renders `latest` only, as ranked bars, with no trajectory chart. That is deliberate: on this page a coloured bar means "this row has a line below it in that colour", so with no lines every bar takes the neutral fill and the list reads as one ranking, which is what it is.

- [ ] **Step 1: Write the failing test**

The guarantee this task leans on is that the collector's fold has already run, so `latest` can never name a value held by fewer than three instances, and that `other` sorts by the same total order as every other row. `telemetry.test.ts` covers the fold; what is not pinned is that the bundler's `latest` ordering is count-descending with the dimension as tie-break for the telemetry files specifically. Append to `scripts/metrics/src/bundle.telemetry.test.ts`:

```ts
  it('orders each telemetry ranking by count descending with the dimension as tie-break', () => {
    // The page renders `latest` in array order and scales every bar against
    // the first row's count. An unordered `latest` would put a short bar at
    // the top and read as a ranking that is not one.
    const s = store();
    s.writeNdjson('telemetry/versions.ndjson', [
      { snapshot_date: '2026-09-05', dimension: '1.1.0', title: '', count: 4, uniques: 4 },
      { snapshot_date: '2026-09-05', dimension: 'other', title: '', count: 9, uniques: 9 },
      { snapshot_date: '2026-09-05', dimension: '1.1.2', title: '', count: 4, uniques: 4 },
    ]);

    const latest = buildDashboardData(s, '2026-09-06T00:00:00Z').telemetry.versions.latest;

    expect(latest.map((r) => r.dimension)).toEqual(['other', '1.1.0', '1.1.2']);
  });
```

- [ ] **Step 2: Run the test**

Run: `cd scripts/metrics && npx vitest run src/bundle.telemetry.test.ts`

Expected: PASS (the bundler's `compareByCountDesc` already does this). If it FAILS, fix the bundler before writing the page code, because the page cannot repair an ordering it is handed.

- [ ] **Step 3: Add the ranking declarations**

Inside the section IIFE, after `CARDS`:

```js
  /*
   * The three rankings, each from the latest snapshot only.
   *
   * `unit` is what a row's `count` counts, and the three are not the same:
   * a version's figure and a country's figure are counts of INSTANCES, and a
   * client kind's is a count of PEOPLE. Printing "12" under all three with no
   * unit is how a reader ends up citing the wrong number.
   */
  var RANKINGS = [
    {
      key: "versions",
      title: "Server versions",
      one: "instance",
      many: "instances",
      note: "Which release each reporting instance runs. A version string that is not shaped like a release is counted as " +
        "“other” before anything is written, so the archive never names free text an instance chose."
    },
    {
      key: "countries",
      title: "Countries",
      one: "instance",
      many: "instances",
      note: "A two-letter code the receiver derives from the connecting address at the edge. The address itself is neither stored nor published, and a code that cannot be resolved is recorded as ZZ."
    },
    {
      key: "clients",
      title: "Client kinds",
      one: "user",
      many: "users",
      note: "How people reach their instance. This one counts users rather than instances, and the fold threshold still protects the instance: a kind is published only when at least three instances report it. A narrow browser window reports as mobile."
    }
  ];

  /* A ranked row with no line of its own. Every bar here takes it, because on
   * this page a palette colour means "this row has a line below it in this
   * colour" and this section draws no per-dimension lines. */
  var NEUTRAL = { token: "--txt4", fallback: "#5c5c68" };
```

- [ ] **Step 4: Add the ranking renderer**

After `buildCard`:

```js
  /* The snapshot date of a dimension series, printed as the page prints dates,
   * or null when it has none or it cannot be placed on a calendar day. */
  function snapshotDay(series) {
    if (series.snapshots.length === 0) return null;
    var ms = I.parseDay(series.snapshots[series.snapshots.length - 1]);
    return isNaN(ms) ? null : I.formatDay(ms);
  }

  function rankedRow(row, rank, max, unit) {
    var box = el("div", "rank-row");
    box.appendChild(el("p", "rank-n", String(rank)));

    var body = el("div", "rank-body");
    var head = el("div", "rank-head");
    var name = el("p", "rank-name", row.dimension);
    /* Set whether or not the CSS ellipsis bites, so the full value stays
     * reachable at every width. */
    name.title = row.dimension;
    head.appendChild(name);
    head.appendChild(el("p", "rank-num", I.formatCount(row.count) + " " + unit));
    body.appendChild(head);

    var track = el("div", "rank-track");
    var fill = el("div", "rank-fill");
    var share = max > 0 ? (row.count / max) * 100 : 0;
    if (!isFinite(share) || share < 0) share = 0;
    if (share > 100) share = 100;
    fill.style.width = share + "%";
    fill.style.background = C.colour(NEUTRAL.token, NEUTRAL.fallback);
    track.appendChild(fill);
    body.appendChild(track);

    box.appendChild(body);
    return box;
  }

  function buildRanking(stack, spec, series) {
    var day = snapshotDay(series);
    var shell = cardHost(stack, spec.title, [
      pair("snapshot", day === null
        ? (series.snapshots.length === 0 ? "none recorded" : "recorded, but its date cannot be placed on a calendar day")
        : "taken " + day),
      pair("rows", I.formatCount(series.latest.length) + " listed"),
      pair("folded", "values held by fewer than 3 instances are counted as other")
    ]);

    if (series.latest.length === 0) {
      shell.appendChild(el("p", "slot-note",
        "The latest snapshot carries no rows for this dimension, so there is nothing to rank."));
      shell.appendChild(el("p", "chart-hint", spec.note));
      return;
    }

    var max = 0;
    var i;
    for (i = 0; i < series.latest.length; i++) {
      if (series.latest[i].count > max) max = series.latest[i].count;
    }
    var list = el("div", "ranked");
    for (i = 0; i < series.latest.length; i++) {
      var row = series.latest[i];
      list.appendChild(rankedRow(row, i + 1, max,
        row.count === 1 ? spec.one : spec.many));
    }
    shell.appendChild(list);
    shell.appendChild(el("p", "chart-hint", spec.note));
  }
```

- [ ] **Step 5: Draw the rankings from `render`**

Immediately after the `live = created;` line at the end of `render`, add:

```js
    /*
     * Outside the try above on purpose. The rankings hold no uPlot instance
     * and nothing to release, so a throw here is the shell's to report and
     * there is nothing for this frame to clean up. Putting them inside would
     * mean a ranking bug destroys two working charts.
     */
    for (var r = 0; r < RANKINGS.length; r++) {
      buildRanking(stack, RANKINGS[r], block[RANKINGS[r].key]);
    }
```

- [ ] **Step 6: Verify against fixtures**

Run the appendix recipe with `--telemetry high` and confirm:

1. Three ranked cards follow the two charts, titled "Server versions", "Countries" and "Client kinds".
2. Row counts read `12 instances` / `1 instance` / `40 users` with the right unit per card, and the widest bar belongs to the top row of each card.
3. The `other` row appears where its count places it, not pinned to the bottom.
4. Run with `--telemetry high-nodims` (network rows present, the three ndjson files empty): each ranking card prints "The latest snapshot carries no rows for this dimension" and the two charts still draw.
5. Switching the range control does not change the rankings, because they are a snapshot rather than a window.

- [ ] **Step 7: Update the docs**

Append to `docs/systems/metrics.md` section 10.8:

```markdown
**The three rankings render `latest` only, with no trajectory chart.** They use
the same `.rank-*` markup as the referrer and path sections, and every bar takes
the neutral fill rather than a palette colour, because on this page a palette
colour means "this row has a line below it in this colour" and this section
draws no per-dimension lines. A ranking's `count` is not the same unit across
the three: versions and countries count INSTANCES, clients counts PEOPLE, and
each card names its own unit on every row. The rankings are a snapshot rather
than a window, so the range control does not move them, and each card states the
snapshot date it drew.
```

- [ ] **Step 8: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md scripts/metrics/src/bundle.telemetry.test.ts
git commit -m "feat(insights): rank versions, countries and client kinds"
```

---

## Task 4 (M1): Backfill writes no all-zero telemetry row on the oldest ping day

**Deferred finding, verbatim:** "backfill still writes an all-zero network row on oldestPing itself (day <= oldestPing should skip)".

**Files:**
- Modify: `scripts/metrics/src/backfill.ts:485-492`
- Test: `scripts/metrics/src/backfill.test.ts`
- Modify: `docs/systems/metrics.md` section 4.2 (the telemetry backfill paragraph)

**Interfaces:**
- Consumes: `aggregateTelemetry(pings, day)` from `telemetry.ts`, unchanged.
- Produces: nothing new. The exported `backfill()` signature is untouched.

Why this is a real fault and not a nicety: eligibility requires an instance to have reported on **two distinct days** inside `[D-29, D]`. On `D = oldestPing` every ping in the export falls on `D` itself, so no instance is eligible and `aggregateTelemetry` returns an all-zero network row. Metrics section 4.3 forbids writing a fabricated zero, and the code's own comment three lines above says the same thing about the day before it.

- [ ] **Step 1: Write the failing test**

Add to `scripts/metrics/src/backfill.test.ts`, inside the telemetry describe block:

```ts
  it('writes no network row for the oldest day the export carries', async () => {
    // Eligibility needs two distinct reporting days inside the trailing
    // thirty. On the oldest day the export holds, there is exactly one, so the
    // aggregate is all zeros by construction. Writing it would state a
    // measured empty fleet for the first day evidence exists, which is the
    // fabricated zero section 4.3 forbids.
    const oldest = daysBeforeToday(40);
    const next = daysBeforeToday(39);
    const store = createStore(dir);
    await backfill({
      store,
      client: emptyClient(),
      slug: 'o/r',
      today: TODAY,
      now: NOW,
      telemetry: async () => [
        ping('i1', oldest),
        ping('i1', next),
        ping('i2', oldest),
        ping('i2', next),
      ],
    });

    const dates = store.readCsv('telemetry/network.csv').map((row) => row['date']);
    expect(dates).not.toContain(oldest);
    expect(dates[0]).toBe(next);
  });
```

Use the file's existing fixture helpers. If `daysBeforeToday`, `ping` or `emptyClient` do not exist under those names, reuse whatever the neighbouring telemetry backfill tests already build and keep the assertions identical.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd scripts/metrics && npx vitest run src/backfill.test.ts -t "oldest day the export carries"`

Expected: FAIL, with `dates` containing the oldest day and `dates[0]` equal to it.

- [ ] **Step 3: Fix the boundary**

In `scripts/metrics/src/backfill.ts`, change the skip inside the reconstruction loop from

```ts
      const day = daysBefore(today, offset);
      if (day < oldestPing) continue;
```

to

```ts
      const day = daysBefore(today, offset);
      // `<=`, not `<`. Eligibility needs two distinct reporting days inside
      // the trailing thirty, and on `oldestPing` itself there is exactly one
      // by definition, so the aggregate is all zeros by construction. Writing
      // it would state a measured empty fleet for the first day any evidence
      // exists, which is the fabricated zero section 4.3 forbids -- the same
      // argument the loop's start offset already makes one day further out.
      if (day <= oldestPing) continue;
```

- [ ] **Step 4: Run the tests**

Run: `cd scripts/metrics && npx vitest run src/backfill.test.ts`

Expected: PASS, all of them. Then `pnpm --filter @backspace/metrics test` for the whole suite plus typecheck.

- [ ] **Step 5: Update the doc**

In `docs/systems/metrics.md` section 4.2, in the telemetry backfill paragraph, change the sentence

> An empty export therefore writes nothing at all.

to

> An empty export therefore writes nothing at all, and neither does the oldest day the export does carry: eligibility needs two distinct reporting days inside the trailing thirty, and that day has exactly one by definition, so its aggregate is all zeros by construction. The fill starts one day after it.

- [ ] **Step 6: Commit**

```bash
git add scripts/metrics/src/backfill.ts scripts/metrics/src/backfill.test.ts docs/systems/metrics.md
git commit -m "fix(metrics): stop backfilling an empty fleet on the oldest ping day"
```

---

## Task 5 (M2): The data page stops claiming a seven-day basis for the same-day columns

**Deferred finding, verbatim:** "data page sentence claims seven-day snapshot for all columns though instances_1d/users_active1d are same-day"; plus "no test for measured 0 surviving as 0 or for escaping in telemetryDimensionTable".

**Files:**
- Modify: `scripts/metrics/src/datapage.ts:172-177` (the paragraph beginning "Each row describes the fleet on its date")
- Test: `scripts/metrics/src/datapage.test.ts`

**Interfaces:**
- Consumes: `DashboardData['telemetry']` unchanged.
- Produces: nothing new; `renderDataPage`'s signature is untouched.

- [ ] **Step 1: Write the failing tests**

Add three tests to `scripts/metrics/src/datapage.test.ts`. Build the `DashboardData` with the file's existing fixture helper.

```ts
  it('does not claim the seven-day basis for the same-day columns', () => {
    const html = renderDataPage(withTelemetry());

    // The snapshot rule governs most of the row, but `instances_1d` and
    // `users_active1d` are restricted to the day itself; a blanket claim would
    // have the page describe two of its own columns wrongly.
    expect(html).toContain('reported that day rather than over the week');
  });

  it('renders a measured zero in a telemetry ranking as 0', () => {
    const data = withTelemetry();
    data.telemetry.clients.latest = [
      { dimension: 'mobile', title: '', count: 0, uniques: 0 },
    ];

    const html = renderDataPage(data);

    expect(html).toContain('<td class="n">0</td>');
    expect(html).not.toContain('not measured');
  });

  it('escapes a dimension value in a telemetry ranking', () => {
    const data = withTelemetry();
    data.telemetry.versions.latest = [
      { dimension: '<script>x</script>', title: '', count: 3, uniques: 3 },
    ];

    const html = renderDataPage(data);

    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(html).not.toContain('<script>x</script>');
  });
```

If `withTelemetry()` does not exist, add it beside the file's existing fixture builder: the same base `DashboardData` with `telemetry.network.dates` holding at least one date (so `telemetrySection` renders at all) and each dimension series holding one row.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd scripts/metrics && npx vitest run src/datapage.test.ts`

Expected: the first test FAILS (the phrase is not there). The zero and escaping tests should PASS, since `telemetryDimensionTable` uses `toLocaleString` and `escapeHtml` already. If either FAILS, that is a real defect and is fixed in Step 3 along with the wording.

- [ ] **Step 3: Correct the paragraph**

In `scripts/metrics/src/datapage.ts`, replace

```ts
<p>Each row describes the fleet on its date, built from the most recent ping per instance in the
seven days ending on that date, so a quiet instance keeps its last reported figures for up to a
week. Every column is a reading taken on that day, not a daily total: rows are comparable to each
other but must not be added together.</p>
```

with

```ts
<p>Each row describes the fleet on its date, built from the most recent ping per instance in the
seven days ending on that date, so a quiet instance keeps its last reported figures for up to a
week. Two columns are narrower than that: <em>instances reporting today</em> and <em>active
today</em> count only what reported that day rather than over the week, so an instance whose ping
was late is absent from those two and present in the rest. Every column is a reading taken on that
date, not a daily total: rows are comparable to each other but must not be added together.</p>
```

- [ ] **Step 4: Run the tests**

Run: `cd scripts/metrics && npx vitest run src/datapage.test.ts`

Expected: PASS, all three. Then `pnpm --filter @backspace/metrics test`.

- [ ] **Step 5: Commit**

```bash
git add scripts/metrics/src/datapage.ts scripts/metrics/src/datapage.test.ts
git commit -m "fix(metrics): name the two same-day telemetry columns on the data page"
```

---

## Task 6 (M3): `instances7d` means the same thing on both bundle paths

**Deferred finding, verbatim:** "instances7d doc claim ('last day, not last measured') does not hold on the downsampled path".

**Files:**
- Modify: `scripts/metrics/src/bundle.ts` (`downsampleTelemetry`, near line 966, and the `TelemetryBlock.instances7d` doc comment near line 158)
- Test: `scripts/metrics/src/bundle.telemetry.test.ts`
- Modify: `docs/systems/metrics.md` section 10.2 (the `instances7d` paragraph) and section 10.3 (the telemetry bullet's closing clause)

**Interfaces:**
- Consumes: `TelemetryBlock` unchanged.
- Produces: `downsampleTelemetry` keeps its signature; only the value of `instances7d` on the weekly path changes, and only in the case where the daily path already answered `null`.

The analysis, so the implementer does not have to redo it: `lastBucket` picks the measured value with the highest **date** in a bucket, and `readDatedRows` sorts by date, so whenever the final day carries a measured `instances_7d`, that day is the highest measured date in the final bucket and the recomputed weekly figure equals the daily one. The two paths can therefore differ in exactly one case: the final day did **not** measure the column. There the daily path answers `null` and the recompute reaches back up to six days for a value. Carrying the daily figure through fixes that and keeps both invariants: the answer is still the last day's, and a non-null answer still appears in the published bucketed series, because it is that series' final element.

- [ ] **Step 1: Write the failing test**

Append to `scripts/metrics/src/bundle.telemetry.test.ts`:

```ts
  it('keeps instances7d null on the weekly path when the last day did not measure it', () => {
    // The threshold is a claim about the trailing seven days. Recomputing it
    // from the bucketed series reached back up to six days for a value when
    // the final day was blank, which published charts off a bar that was last
    // cleared the previous week.
    const s = store();
    const rows = Array.from({ length: 14 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), 12),
    );
    rows[rows.length - 1] = { ...rows[rows.length - 1], instances_7d: '' };
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const daily = buildDashboardData(s, '2026-09-15T00:00:00Z');
    const weekly = downsampleWeekly(daily);

    expect(daily.telemetry.instances7d).toBeNull();
    expect(weekly.telemetry.instances7d).toBeNull();
  });

  it('keeps instances7d equal to the last published bucket when the last day measured it', () => {
    const s = store();
    const rows = Array.from({ length: 14 }, (_, i) =>
      flatRow(new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10), i),
    );
    s.writeCsv('telemetry/network.csv', NETWORK_HEADER, rows);

    const weekly = downsampleWeekly(buildDashboardData(s, '2026-09-15T00:00:00Z'));

    expect(weekly.telemetry.instances7d).toBe(13);
    expect(weekly.telemetry.network.instances_7d.at(-1)).toBe(13);
  });
```

- [ ] **Step 2: Run the tests and watch the first fail**

Run: `cd scripts/metrics && npx vitest run src/bundle.telemetry.test.ts -t "instances7d"`

Expected: the first new test FAILS with `weekly.telemetry.instances7d` equal to `12` rather than `null`. The second PASSES already.

- [ ] **Step 3: Carry the daily figure through**

In `scripts/metrics/src/bundle.ts`, change `downsampleTelemetry`'s return from `instances7d: latestInstances7d(network)` to `instances7d: block.instances7d`, and replace the paragraph of its doc comment that begins "`instances7d` is RECOMPUTED" with:

```
 * `instances7d` is CARRIED THROUGH rather than recomputed, and the two are
 * the same value in every case but one. `lastBucket` picks the measured value
 * with the highest date in a bucket and the rows are date-sorted, so whenever
 * the final day measured the column it is the final bucket's pick and the two
 * agree. They diverge only when the final day did NOT measure it: the daily
 * figure is null, and a recompute would reach back up to six days for a value.
 * The threshold is a claim about the trailing seven days, so reaching back
 * would publish charts off a bar last cleared the previous week. Carrying the
 * daily figure keeps both properties the field is for: it is the last DAY's
 * value, and when it is not null it is also the final element of the published
 * bucketed series, so the threshold figure is always verifiable from the
 * bundle itself.
```

Then, in the `TelemetryBlock.instances7d` doc comment near line 158, replace the closing sentence "`downsampleWeekly` recomputes it from the bucketed series so the two can never disagree." with "`downsampleWeekly` carries it through unchanged; see `downsampleTelemetry` for why that is what keeps the daily and weekly bundles saying the same thing."

- [ ] **Step 4: Run the tests**

Run: `cd scripts/metrics && npx vitest run src/bundle.telemetry.test.ts`

Expected: PASS. Then `pnpm --filter @backspace/metrics test`.

- [ ] **Step 5: Update the docs**

In `docs/systems/metrics.md` section 10.2, in the `instances7d` paragraph, replace the final sentence "A last day that did not measure the column reads as `null`, which fails the threshold." with:

```markdown
A last day that did not measure the column reads as `null`, which fails the
threshold, and it reads as `null` on the weekly path too: `downsampleWeekly`
carries the daily figure through rather than recomputing it. The two agree in
every other case, because the final bucket's last measured value is the final
day whenever that day measured anything, and recomputing would differ only by
reaching back up to six days for a value the threshold is not about.
```

In section 10.3, in the telemetry bullet, change the closing clause "and `instances7d` is recomputed from the bucketed series so the published threshold figure always appears in the published series" to "and `instances7d` is carried through from the daily bundle, which is the same value as the final bucket's whenever the final day measured the column and is `null` when it did not".

- [ ] **Step 6: Commit**

```bash
git add scripts/metrics/src/bundle.ts scripts/metrics/src/bundle.telemetry.test.ts docs/systems/metrics.md
git commit -m "fix(metrics): keep the telemetry threshold on the last day in weekly bundles"
```

---

## Task 7 (M4): The Dataset metadata names the telemetry data

**Deferred finding, verbatim:** "JSON-LD Dataset and meta description still describe GitHub data only (controller decision: extend in Track F with the charts)".

**Files:**
- Modify: `scripts/metrics/src/summary.ts` (`SummaryFacts`, `buildSummary`, `buildDatasetJsonLd`)
- Modify: `scripts/metrics/src/datapage.ts` (the `dataset` object and the `<meta name="description">` in `renderDataPage`)
- Modify: `site/insights/index.html` (the committed `BUILD:JSONLD` block and the head `<meta name="description">`)
- Test: `scripts/metrics/src/summary.test.ts`, `scripts/metrics/src/datapage.test.ts`
- Modify: `docs/systems/metrics.md` (the "Static content baked into the charted page" subsection, the `BUILD:JSONLD` bullet)

**Interfaces:**
- Produces: `SummaryFacts` gains one field, consumed by `buildDatasetJsonLd` in the same file.
  ```ts
  /** The newest measured `instances_7d` and the day it was measured, or null. */
  telemetryInstances: DatedValue | null;
  ```

The telemetry variables and the extra sentence are **gated on the archive actually holding telemetry**, matching `telemetrySection`'s own guard on the data page. Declaring a variable the archive has never measured would be the page asserting a measurement it does not hold, which is the one thing this subsystem exists not to do.

- [ ] **Step 1: Write the failing tests**

In `scripts/metrics/src/summary.test.ts`, inside `describe('renderDatasetJsonLd', ...)` (or the neighbouring `buildSummary` describe, matching the file's existing structure):

```ts
  it('declares the telemetry variables once the archive holds a ping', () => {
    const data = dataWithTelemetry();
    const json = buildDatasetJsonLd(buildSummary(data), 'https://x.test');
    const names = (json['variableMeasured'] as Array<{ name: string }>).map((v) => v.name);

    expect(names).toContain('reporting instances');
    expect(names).toContain('active users on reporting instances');
    expect(names).toContain('server versions in use');
    expect(String(json['description'])).toContain('opt-in');
  });

  it('declares no telemetry variables while the archive holds no ping', () => {
    const json = buildDatasetJsonLd(buildSummary(data()), 'https://x.test');
    const names = (json['variableMeasured'] as Array<{ name: string }>).map((v) => v.name);

    // A variable the archive has never measured is a claimed measurement.
    expect(names).not.toContain('reporting instances');
    expect(String(json['description'])).not.toContain('opt-in');
  });
```

`buildDatasetJsonLd` is currently module-private; export it beside `renderDatasetJsonLd` so the tests read the object rather than regex-stripping a `<script>` wrapper, which is the reason `renderDatasetJsonLd` was split in the first place. Add `dataWithTelemetry()` beside the file's existing `data()` helper: the same base bundle with `telemetry.network.dates` holding one date and `instances_7d` holding one number.

In `scripts/metrics/src/datapage.test.ts`:

```ts
  it('names the usage pings in the page description and the Dataset once they exist', () => {
    const html = renderDataPage(withTelemetry());

    expect(html).toContain('opt-in usage pings');
    expect(html).toContain('"reporting instances"');
  });

  it('leaves the description and the Dataset to the GitHub data while no ping exists', () => {
    const html = renderDataPage(data());

    expect(html).not.toContain('opt-in usage pings');
    expect(html).not.toContain('"reporting instances"');
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd scripts/metrics && npx vitest run src/summary.test.ts src/datapage.test.ts`

Expected: the four new tests FAIL. The summary ones fail on the missing export first.

- [ ] **Step 3: Extend `SummaryFacts`**

In `scripts/metrics/src/summary.ts`, add to the interface after `latestRelease`:

```ts
  /**
   * The newest measured `instances_7d` with the day it was measured, or null
   * when the archive holds no ping at all.
   *
   * Carried so the Dataset block can declare the telemetry variables only when
   * they exist. A variable the archive has never measured is a claimed
   * measurement, and this file's whole rule is that a figure with no
   * measurement behind it loses its clause rather than printing a placeholder.
   */
  telemetryInstances: DatedValue | null;
```

and in `buildSummary`, populate it with the same `newestMeasured` helper the other counters use:

```ts
    telemetryInstances: newestMeasured(
      data.telemetry.network.dates,
      data.telemetry.network.instances_7d,
    ),
```

- [ ] **Step 4: Extend the Dataset block in `summary.ts`**

Export `buildDatasetJsonLd`. Inside it, after the existing `for (const name of [...])` loop that pushes the nameless variables, add:

```ts
  // Declared only when the archive holds a ping. These come from a second
  // source entirely -- the opt-in instance pings, not GitHub -- and a crawler
  // told the dataset measures "reporting instances" while it holds none has
  // been told something untrue.
  if (facts.telemetryInstances !== null) {
    variables.push({
      '@type': 'PropertyValue',
      name: 'reporting instances',
      value: facts.telemetryInstances.value,
    });
    for (const name of [
      'active users on reporting instances',
      'server versions in use',
      'countries instances report from',
      'client kinds in use',
    ]) {
      variables.push({ '@type': 'PropertyValue', name });
    }
  }
```

and make the description carry the second source when it exists. Replace the literal `description:` value with a built one:

```ts
  const description =
    "Daily archive of the Backspace repository's GitHub traffic, stars, forks, contributors " +
    'and releases. GitHub discards repository traffic data after 14 days; this archive records ' +
    'it once per day and retains it indefinitely. Every figure is measured, never estimated; a ' +
    'value that was not measured is recorded as absent rather than as zero.' +
    (facts.telemetryInstances === null
      ? ''
      : ' It also carries opt-in usage pings from self-hosted Backspace instances: rounded ' +
        'counts of instances, active users, versions, countries and client kinds, published as ' +
        'a lower bound because an instance that never opts in is not counted.');
```

and use `description` in the object literal.

- [ ] **Step 5: Extend the Dataset block and the meta description in `datapage.ts`**

`renderDataPage` already has `data`, so it gates directly on the archive rather than on a facts object:

```ts
  const hasTelemetry = data.telemetry.network.dates.length > 0;
```

Add the same four extra `variableMeasured` names (as bare strings, matching this file's simpler array) and the same extra description sentence, both behind `hasTelemetry`. Then change the `<meta name="description">` line to interpolate:

```ts
<meta name="description" content="The complete Backspace repository traffic and growth archive as plain tables: daily page views, clones, stars, forks, contributors, referrers and paths${hasTelemetry ? ', plus opt-in usage pings from self-hosted instances' : ''}. Measured daily, never estimated, retained past GitHub's 14-day window." />
```

- [ ] **Step 6: Update the committed page**

The committed `BUILD:JSONLD` block in `site/insights/index.html` is the fallback that stands when `METRICS_SITE_URL` is unset, and its comment says it is kept in sync by hand with what `datapage.ts` emits. The live archive already holds pings, so the committed block takes the extended form. Add to `variableMeasured`:

```json
    "reporting instances", "active users on reporting instances",
    "server versions in use", "countries instances report from", "client kinds in use"
```

and append the same sentence to its `description`. Then extend the page's own head `<meta name="description">` to:

```html
<meta name="description" content="Traffic, growth and referral figures for the Backspace repository, plus opt-in usage pings from self-hosted instances, collected daily into a public archive and rendered from a single static bundle." />
```

- [ ] **Step 7: Run the tests**

Run: `cd scripts/metrics && npx vitest run` then `pnpm --filter @backspace/metrics test`

Expected: PASS. Then run the appendix recipe with `--telemetry high` and confirm the generated `data/index.html` carries the telemetry sentence and the five variables, and that the copied `index.html`'s `BUILD:SUMMARY` region was rewritten without error.

- [ ] **Step 8: Update the doc**

In `docs/systems/metrics.md`, in the "Static content baked into the charted page" subsection, extend the `BUILD:JSONLD` bullet with:

```markdown
  The telemetry variables (`reporting instances`, `active users on reporting
  instances`, `server versions in use`, `countries instances report from`,
  `client kinds in use`) and the sentence naming the second source are emitted
  only when the archive holds at least one ping, gated on
  `SummaryFacts.telemetryInstances` in `summary.ts` and on
  `telemetry.network.dates` in `datapage.ts`. A variable declared over an
  archive that has never measured it is a claimed measurement, which is the one
  thing this subsystem exists not to publish.
```

- [ ] **Step 9: Commit**

```bash
git add scripts/metrics/src/summary.ts scripts/metrics/src/summary.test.ts scripts/metrics/src/datapage.ts scripts/metrics/src/datapage.test.ts site/insights/index.html docs/systems/metrics.md
git commit -m "feat(metrics): declare the usage pings in the dataset metadata"
```

---

## Task 8 (M5): One activity write per connection per day, and an hourly warning instead of permanent silence

**Deferred findings, verbatim:** "activityWriteWarned never resets (permanent silence after first failure; hourly throttle suggested); `(err as Error).message` cast; guard test order couples to the one-shot flag" and "the pong path calls touchUserActivity on every 30 s pong".

**Files:**
- Modify: `packages/server/src/ws/handler.ts` (lines 1089 to 1119 for the warning and the day gate, and the auth/pong wiring at lines 1776 to 1787)
- Test: `packages/server/src/ws/activityTouch.test.ts`
- Modify: `docs/systems/telemetry.md` section 4 (the `last_active_day` row)

**Interfaces:**
- Consumes: `touchUserActivity(db, userId, today, client?) -> boolean` from `packages/server/src/telemetry/activity.ts`, unchanged, and `utcDay(now) -> string` from `packages/server/src/telemetry/day.ts`.
- Produces, from `handler.ts`, one widened export the tests and the socket wiring both use:
  ```ts
  export function recordConnectionActivity(
    userId: string,
    authMessage: Record<string, unknown> | null,
    now: Date,
    connection?: object,
  ): void;
  ```
  `connection` is any per-socket object used as a `WeakMap` key. Passing it makes the pong path skip the database entirely once the day is already recorded for that socket; omitting it keeps the old behaviour, which is what the auth path and the existing tests want.

Why the gate belongs in the handler and not in `activity.ts`: `touchUserActivity` already refuses to change a row that holds today, through its `or(isNull, ne(lastActiveDay, today))` predicate, so the stored day is never rewritten. What it does not avoid is the round trip. An `UPDATE` statement runs for every socket on every pong, which is every 30 seconds per connection, and on an instance holding a few hundred desktop clients open that is steady write-lock churn on `users` for a column that moves once a day. The connection is the only thing that knows it has already asked today, so the memo lives there.

- [ ] **Step 1: Write the failing tests**

Replace the existing "swallows a failed write instead of throwing at the caller" test in `packages/server/src/ws/activityTouch.test.ts` with the warning pair below. The replacement also removes that test's coupling to a process-lifetime flag, which made it order-dependent.

```ts
  it('swallows a failed write and warns at most once an hour', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    sqlite.close();

    const at = (iso: string) => new Date(iso);
    expect(() => recordConnectionActivity('u1', null, at('2026-09-06T10:00:00Z'))).not.toThrow();
    // The pong path runs every 30 seconds per socket, so a database that keeps
    // refusing the write must not flood the log.
    recordConnectionActivity('u1', null, at('2026-09-06T10:00:30Z'));
    recordConnectionActivity('u1', null, at('2026-09-06T10:59:59Z'));
    expect(warn).toHaveBeenCalledTimes(1);

    // ...and must not go silent for the life of the process either: an outage
    // that outlives the first warning has to stay visible in the log.
    recordConnectionActivity('u1', null, at('2026-09-06T11:00:00Z'));
    expect(warn).toHaveBeenCalledTimes(2);

    warn.mockRestore();
  });
```

Then add the day-gate tests. They prove the absence of a statement rather than its presence, by moving the row out from under the connection between two calls: a second `UPDATE` would put it back, so a row that still reads `1999-01-01` is proof that no statement ran at all.

```ts
  it('touches the row at most once per calendar day per connection', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const connection = {};
    const stored = () =>
      testDb.select({ d: schema.users.lastActiveDay }).from(schema.users)
        .where(eq(schema.users.id, 'u1')).get()?.d;

    recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:00Z'), connection);
    expect(stored()).toBe('2026-09-06');

    // Move the row out from under the connection. A second write inside the
    // same day would put it back, so the old value surviving is the proof that
    // no statement ran, not merely that one ran and changed nothing.
    testDb.update(schema.users).set({ lastActiveDay: '1999-01-01' })
      .where(eq(schema.users.id, 'u1')).run();
    recordConnectionActivity('u1', null, new Date('2026-09-06T23:59:59Z'), connection);
    expect(stored()).toBe('1999-01-01');

    // The first pong after the day rolls over writes again. A desktop client
    // left open for a week is exactly the case the pong path exists for, and
    // it must not stop reporting on day two.
    recordConnectionActivity('u1', null, new Date('2026-09-07T00:00:01Z'), connection);
    expect(stored()).toBe('2026-09-07');
  });

  it('gives each connection its own memo and never skips the auth path', async () => {
    const { recordConnectionActivity } = await import('./handler.js');
    const first = {};
    const second = {};
    const stored = () =>
      testDb.select({ d: schema.users.lastActiveDay, c: schema.users.lastClient })
        .from(schema.users).where(eq(schema.users.id, 'u1')).get();

    recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:00Z'), first);
    testDb.update(schema.users).set({ lastActiveDay: '1999-01-01' })
      .where(eq(schema.users.id, 'u1')).run();

    // A second socket for the same user carries its own memo: it has not asked
    // today, so it writes.
    recordConnectionActivity('u1', null, new Date('2026-09-06T10:00:01Z'), second);
    expect(stored()?.d).toBe('2026-09-06');

    // And an auth message is never skipped, whatever the memo holds: it carries
    // the client kind, which can differ between two connections on one day.
    testDb.update(schema.users).set({ lastActiveDay: '1999-01-01', lastClient: 'web' })
      .where(eq(schema.users.id, 'u1')).run();
    recordConnectionActivity('u1', { type: 'auth', token: 't', client: 'desktop' },
      new Date('2026-09-06T10:00:02Z'), second);
    expect(stored()).toEqual({ d: '2026-09-06', c: 'desktop' });
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/server && npx vitest run src/ws/activityTouch.test.ts`

Expected: the warning test FAILS at the second assertion pair, with `warn` called once rather than twice, because the flag never resets. The first day-gate test FAILS at the middle assertion, reading `2026-09-06` rather than `1999-01-01`, because every pong writes. The second FAILS on the fourth argument being ignored.

(If the whole file errors on `new Database(':memory:')`, that is the environment, not the code. Run the `prebuild-install` recipe from Global Constraints and try again.)

- [ ] **Step 3: Replace the warning flag with a throttle, and add the memo**

In `packages/server/src/ws/handler.ts`, replace

```ts
// One warning per process is enough: the pong path runs every 30s per socket,
// so a database that keeps refusing the write would otherwise flood the log.
let activityWriteWarned = false;
```

with

```ts
// The pong path runs every 30 seconds per socket, so a database that keeps
// refusing this write would flood the log at one line per socket per pong. One
// line per hour is the compromise: quiet enough that a persistent fault does
// not bury everything else, loud enough that an outage lasting a week stays
// visible for the whole week. A one-shot flag was the earlier form and it went
// permanently silent after the first failure, so an outage that began before
// anyone looked left no trace at all.
const ACTIVITY_WARN_INTERVAL_MS = 60 * 60 * 1000;
let activityWarnedAt = 0;

/**
 * The last UTC day each live connection recorded activity for.
 *
 * Keyed on the socket, so it dies with the socket and holds nothing across
 * reconnects. `touchUserActivity` already refuses to rewrite a row that holds
 * today, so this memo changes no stored value; what it avoids is the round
 * trip. Without it an `UPDATE` runs for every socket on every pong, which on an
 * instance holding a few hundred desktop clients open is constant write-lock
 * churn on `users` for a column that moves once a day.
 *
 * A miss is always safe: a connection with no memo simply writes, and the
 * statement's own predicate makes that a no-op when the day is already there.
 */
const activityDayByConnection: WeakMap<object, string> = new WeakMap();
```

- [ ] **Step 4: Gate the write and fix the cast**

Replace the body of `recordConnectionActivity` with:

```ts
export function recordConnectionActivity(
  userId: string,
  authMessage: Record<string, unknown> | null,
  now: Date,
  connection?: object,
): void {
  const today = utcDay(now);
  // The auth path is never skipped: it carries the client kind, which can
  // differ from what the row holds even on a day already recorded. Only the
  // pong path, which touches the day and nothing else, has anything to skip.
  if (authMessage === null && connection !== undefined
    && activityDayByConnection.get(connection) === today) {
    return;
  }
  try {
    const db = getDb();
    if (authMessage) {
      touchUserActivity(db, userId, today, parseClientKind(authMessage.client));
    } else {
      touchUserActivity(db, userId, today);
    }
    // Recorded only after the write did not throw, so a failing database is
    // retried on the next pong rather than memoised as done.
    if (connection !== undefined) activityDayByConnection.set(connection, today);
  } catch (err) {
    const at = now.getTime();
    if (activityWarnedAt === 0 || at - activityWarnedAt >= ACTIVITY_WARN_INTERVAL_MS) {
      activityWarnedAt = at;
      console.warn(`[ws] could not record activity: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
```

The `instanceof` check replaces the `as Error` cast: a thrown string or a rejected non-Error would have printed `undefined` through the cast. The function's doc comment keeps its first two paragraphs and gains a third:

```
 * `connection` is the socket, used as the key of a per-connection memo of the
 * day already recorded. Given, a pong that has already recorded today returns
 * without touching the database. Omitted, every call writes.
```

- [ ] **Step 5: Pass the socket in from the pong closure**

At the auth handler (around line 1780) the auth call stays exactly as it is, so the client kind is always recorded, and the pong call gains the socket:

```ts
          recordConnectionActivity(activeUserId, parsed, new Date());

          // Mark alive for heartbeat detection; browsers auto-respond to ping frames (RFC 6455)
          wsIsAlive.set(ws, true);
          ws.on('pong', () => {
            wsIsAlive.set(ws, true);
            // `ws` is the memo key: this socket writes the day once and then
            // stops asking until the day rolls over.
            recordConnectionActivity(activeUserId, null, new Date(), ws);
          });
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/server && npx vitest run src/ws/activityTouch.test.ts` then `pnpm --filter @backspace/server test`

Expected: PASS.

- [ ] **Step 7: Update the doc**

In `docs/systems/telemetry.md` section 4, in the `last_active_day` row, replace "Written on auth and on every heartbeat pong, guarded so the write is skipped when the stored value already equals today." with:

```
Written on auth, and on the first heartbeat pong of each UTC day per connection. Two guards at two levels: the connection remembers the day it last recorded and skips the statement entirely for the rest of that day, and the statement itself is predicated on the stored value differing from today, so a connection with no memo still writes nothing new. The first is what keeps a few hundred long-lived desktop sockets from running an `UPDATE` every 30 seconds each.
```

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/ws/handler.ts packages/server/src/ws/activityTouch.test.ts docs/systems/telemetry.md
git commit -m "perf(server): record activity once per connection per day and warn hourly"
```

---

## Task 9 (M6): The ask stops polling after a permanent dismissal, and says when the preview failed

**Deferred finding, verbatim:** "failed preview fetch leaves 'Putting the message together' forever (no preview-error key); fetchTelemetry runs on every page load for every admin even after permanent dismissal".

**Files:**
- Modify: `packages/web/src/utils/telemetryAsk.ts`
- Modify: `packages/web/src/components/telemetry/TelemetryAsk.tsx`
- Modify: `packages/web/src/components/telemetry/PayloadPreview.tsx`
- Modify: `packages/web/src/locales/en/telemetry.json`, `.../de/telemetry.json`, `.../ru/telemetry.json`
- Test: `packages/web/src/utils/telemetryAsk.test.ts`, `packages/web/src/components/telemetry/TelemetryAsk.test.tsx`

**Interfaces:**
- Produces, from `packages/web/src/utils/telemetryAsk.ts`:
  ```ts
  /** True when this browser has dismissed the ask its last permitted time. */
  export function askIsOver(storage: Store): boolean;
  ```
- Produces, in `PayloadPreview`: a new optional prop
  ```ts
  /** True when the preview fetch failed, so the loading line is replaced by a reason. */
  failed?: boolean;
  ```
- New i18n key: `telemetry:ask.previewError`.

The status fetch is what the ask is for, and the settings panel fetches its own. A browser that has spent both dismissals will never show the ask again, so a status request on every page load for the rest of that admin's life buys nothing. The panel is unaffected because it calls `fetchTelemetry` itself.

- [ ] **Step 1: Write the failing tests**

In `packages/web/src/utils/telemetryAsk.test.ts`:

```ts
  it('reports the ask as over once the dismissals are spent', () => {
    const storage = memoryStorage();
    for (let i = 0; i < ASK_MAX_DISMISSALS; i += 1) recordDismissal(storage, 0);

    expect(askIsOver(storage)).toBe(true);
  });

  it('reports the ask as not over before then, and on a storage that throws', () => {
    const storage = memoryStorage();
    expect(askIsOver(storage)).toBe(false);
    recordDismissal(storage, 0);
    expect(askIsOver(storage)).toBe(false);

    // A browser that refuses storage must not be treated as one that already
    // answered: the ask is the point of the feature, and losing it silently is
    // worse than showing it once more.
    const throwing = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    expect(askIsOver(throwing)).toBe(false);
  });
```

Also replace the existing test's two literal `recordDismissal` calls with a loop over `ASK_MAX_DISMISSALS`, so the constant and the test cannot drift.

In `packages/web/src/components/telemetry/TelemetryAsk.test.tsx`:

```tsx
  it('does not fetch the status once this browser has spent its dismissals', () => {
    for (let i = 0; i < ASK_MAX_DISMISSALS; i += 1) recordDismissal(localStorage, Date.now());
    const fetchTelemetry = vi.fn().mockResolvedValue(undefined);
    useSettingsStore.setState({ fetchTelemetry });

    render(<TelemetryAsk />);

    expect(fetchTelemetry).not.toHaveBeenCalled();
  });

  it('says so when the preview could not be fetched', async () => {
    useSettingsStore.setState({
      telemetry: { enabled: null, lastDay: null, lastError: null, id: null },
      fetchTelemetryPreview: vi.fn().mockRejectedValue(new Error('offline')),
    });

    render(<TelemetryAsk />);
    await userEvent.click(await screen.findByRole('button', { name: /show the message/i }));

    expect(await screen.findByText(/could not be put together/i)).toBeInTheDocument();
    expect(screen.queryByText(/putting the message together/i)).not.toBeInTheDocument();
  });
```

Adapt the store setup and the admin-session setup to whatever the file's existing tests already do.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd packages/web && npx vitest run src/utils/telemetryAsk.test.ts src/components/telemetry/TelemetryAsk.test.tsx`

Expected: FAIL. The util tests fail on the missing `askIsOver` export; the component tests fail because the status is fetched unconditionally and the preview has no error state.

- [ ] **Step 3: Add `askIsOver`**

In `packages/web/src/utils/telemetryAsk.ts`, after `shouldShowAsk`:

```ts
/**
 * True when this browser has spent every dismissal the ask allows, so it will
 * never be shown here again whatever the server says.
 *
 * Separate from `shouldShowAsk` because it answers a question that does not
 * need the server: it is what lets the caller skip the status request
 * altogether rather than fetch a status only to discard it. A storage that
 * throws reads as "not over", the same way `read` treats an unreadable record
 * as never dismissed: losing the ask because a browser blocked storage is the
 * worse of the two failures.
 */
export function askIsOver(storage: Store): boolean {
  return read(storage).dismissals >= ASK_MAX_DISMISSALS;
}
```

- [ ] **Step 4: Gate the fetch and track the preview failure**

In `packages/web/src/components/telemetry/TelemetryAsk.tsx`:

```tsx
import { askIsOver, recordDismissal, shouldShowAsk } from '../../utils/telemetryAsk';
```

Add state for the failure and gate the status fetch. `over` is read once per mount rather than on every render, because the only thing that changes it is this component's own dismissal, which also unmounts the modal:

```tsx
  const [previewFailed, setPreviewFailed] = useState(false);
  // Read once per mount. Nothing but this component's own dismissal changes
  // it, and that closes the modal in the same gesture.
  const over = useRef(askIsOver(localStorage));

  useEffect(() => {
    // The status request exists to decide whether to ask. A browser that has
    // spent both dismissals will never ask again, so requesting it on every
    // page load for the rest of this admin's life buys nothing. The settings
    // panel fetches its own status and is unaffected.
    if (!isAdmin || over.current) return;
    void fetchTelemetry().catch(() => undefined);
  }, [isAdmin, fetchTelemetry]);

  useEffect(() => {
    if (!isAdmin || asked.current) return;
    if (!shouldShowAsk(telemetry, isAdmin, localStorage, Date.now())) return;
    asked.current = true;
    setOpen(true);
    void fetchPreview().catch(() => setPreviewFailed(true));
  }, [isAdmin, telemetry, fetchPreview]);
```

and pass it down:

```tsx
  return <HelloModal open onAnswer={onAnswer} onDismiss={onDismiss} preview={preview} previewFailed={previewFailed} />;
```

Thread `previewFailed` through `HelloModal`'s props to `PayloadPreview`'s new `failed` prop, keeping `HelloModal`'s existing prop style.

In `packages/web/src/components/telemetry/PayloadPreview.tsx`, add the prop and the branch:

```tsx
  /**
   * The preview fetch failed. Without this the collapsed body sat on
   * "Putting the message together" for the life of the modal, which reads as a
   * request still in flight rather than one that already failed.
   */
  failed?: boolean;
```

```tsx
          {preview === null ? (
            <p className="text-xs text-txt-tertiary">
              {failed ? t('ask.previewError') : t('ask.previewLoading')}
            </p>
          ) : (
```

- [ ] **Step 5: Add the catalog key in all three languages**

`packages/web/src/locales/en/telemetry.json`, inside `ask`, after `previewLoading`:

```json
    "previewError": "The message could not be put together just now. Nothing has been sent, and you can still decide either way.",
```

`de`:

```json
    "previewError": "Die Nachricht konnte gerade nicht zusammengestellt werden. Es wurde nichts gesendet, und du kannst dich trotzdem so oder so entscheiden.",
```

`ru`:

```json
    "previewError": "Сейчас не удалось собрать сообщение. Ничего не отправлено, и вы всё равно можете выбрать любой вариант.",
```

- [ ] **Step 6: Run the tests and the i18n check**

Run:

```bash
cd packages/web && npx vitest run src/utils/telemetryAsk.test.ts src/components/telemetry/TelemetryAsk.test.tsx
node ../../scripts/check-i18n.mjs
```

Expected: PASS, and `i18n check: no findings.` Then `pnpm --filter @backspace/web test`.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/utils/telemetryAsk.ts packages/web/src/utils/telemetryAsk.test.ts packages/web/src/components/telemetry/TelemetryAsk.tsx packages/web/src/components/telemetry/TelemetryAsk.test.tsx packages/web/src/components/telemetry/HelloModal.tsx packages/web/src/components/telemetry/PayloadPreview.tsx packages/web/src/locales/en/telemetry.json packages/web/src/locales/de/telemetry.json packages/web/src/locales/ru/telemetry.json
git commit -m "fix(web): stop polling after the ask is over and report a failed preview"
```

---

## Task 10 (M7): The export is bounded and its range is a real calendar range

**Deferred findings, verbatim:** "no export row cap (D1 result-size ceiling at large fleets)" and "export from/to not calendar-checked (Feb 30 widens the 31-day cap by up to 3 days; isCalendarDay is private in validate.ts)".

**Files:**
- Modify: `scripts/telemetry-receiver/src/validate.ts:78` (export `isCalendarDay`)
- Modify: `scripts/telemetry-receiver/src/store.ts` (`exportRange` gains a limit)
- Modify: `scripts/telemetry-receiver/src/index.ts` (`handleExport`: the calendar check, the caps, the truncation header)
- Test: `scripts/telemetry-receiver/src/index.test.ts`
- Modify: `docs/systems/telemetry.md` section 8 (the `GET /v1/export` row of the routes table, and one paragraph after it)

**Interfaces:**
- Produces, from `validate.ts`:
  ```ts
  /** True only for a day that exists. `Date.parse` accepts 2026-02-30 and rolls it into March. */
  export function isCalendarDay(day: string): boolean;
  ```
- Produces, from `store.ts`:
  ```ts
  export async function exportRange(
    db: D1Database, from: string, to: string, limit: number,
  ): Promise<StoredPing[]>;
  ```
  `limit` is required rather than optional: an unbounded read is the defect being fixed, and an optional parameter leaves the unbounded call one omission away.
- Produces, from `index.ts` (module-private, but named here because the doc and the tests both quote them):
  `MAX_EXPORT_ROWS = 10_000`, `MAX_EXPORT_BYTES = 8 * 1024 * 1024`.

**Choosing the caps.** Two independent bounds, whichever bites first, because the two failure modes are different.

- **Rows.** The collector asks for 31 days at a time and one instance writes at most one row per day, so a range holds at most `31 x fleet` rows. `10_000` is 31 days times about 320 instances reporting every single day, which is far above any fleet this project will see before somebody revisits the number, and far below a read that could hurt D1.
- **Bytes.** A row's `body` is bounded at `MAX_BODY_BYTES` (4096) by `parsePing`, and the envelope adds under 200 bytes, so 10,000 rows is about 6 MB at the payload the spec actually defines (roughly 450 bytes) and about 43 MB if every instance padded its body to the maximum. A Worker building a 43 MB string in memory is the thing the row cap does not prevent, so an 8 MiB body budget stops it. At real payload sizes it never bites; the row cap is the one that governs.

**Truncation is announced, not hidden.** When either cap bites, the response carries `x-export-truncated: 1`. The NDJSON body keeps its exact current shape, so today's collector is unaffected, and a future collector change can read the header rather than having to infer a short answer from a full-looking one. Rows come back ordered by `day` then `instance`, which `exportRange` already does, so truncation always drops the same tail rather than an arbitrary slice; the test below pins that ordering so it cannot quietly become arbitrary.

**Running these tests.** From this nested worktree the Workers pool may pick up an orphaned `@vitest` from the parent checkout and refuse to start, with `ChaiStyleAssertions` missing from `@vitest/expect`. Workaround, before the first run:

```bash
cd scripts/telemetry-receiver
mkdir -p node_modules/@vitest
for d in ../../node_modules/.pnpm/vitest@*/node_modules/@vitest/*; do ln -sfn "$(cd "$d" && pwd)" "node_modules/@vitest/$(basename "$d")"; done
pnpm test
```

Never commit a `public-hoist-pattern` for this. The symlinks are git-ignored and the real fix belongs in the parent checkout, not here.

- [ ] **Step 1: Write the failing tests**

Add to `describe('GET /v1/export', ...)` in `scripts/telemetry-receiver/src/index.test.ts`. The over-cap fixture is written straight into D1 rather than through 12,000 POSTs, which would take minutes and hit the rate limiter.

```ts
  it('rejects a range whose ends are not real calendar days', async () => {
    const h = { headers: { authorization: 'Bearer test-export-token' } };
    // `Date.parse` rolls 2026-02-30 into March, so the shape check passed and
    // the 31-day span was measured from a day that does not exist, widening
    // the window by up to three days.
    expect((await call(new Request('https://hello.test/v1/export?from=2026-02-30&to=2026-03-05', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-02-01&to=2026-02-30', h))).status).toBe(400);
    expect((await call(new Request('https://hello.test/v1/export?from=2026-13-01&to=2026-13-02', h))).status).toBe(400);
    // A real range still passes, including a leap day.
    expect((await call(new Request('https://hello.test/v1/export?from=2028-02-28&to=2028-02-29', h))).status).toBe(200);
  });

  it('truncates at the row cap and says so, keeping the earliest rows', async () => {
    const OVER = 10_001;
    const stmt = env.DB.prepare(
      'INSERT INTO pings (instance, day, received_at, country, schema, body) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
    );
    // One instance per row, spread over the range, so the day-then-instance
    // ordering has something to order.
    await env.DB.batch(
      Array.from({ length: OVER }, (_, i) =>
        stmt.bind(
          `${String(i).padStart(8, '0')}-1b2c-4d5e-8f90-1234567890ab`,
          `2026-01-${String((i % 31) + 1).padStart(2, '0')}`,
          '2026-01-31T00:00:00.000Z',
          'DE',
          1,
          '{"schema":1}',
        ),
      ),
    );

    const res = await call(new Request('https://hello.test/v1/export?from=2026-01-01&to=2026-01-31', {
      headers: { authorization: 'Bearer test-export-token' },
    }));

    expect(res.status).toBe(200);
    expect(res.headers.get('x-export-truncated')).toBe('1');
    const lines = (await readText(res)).trim().split('\n');
    expect(lines).toHaveLength(10_000);
    // Ordered by day then instance, so the cap always drops the same tail.
    const days = lines.map((l) => (JSON.parse(l) as { day: string }).day);
    expect(days[0]).toBe('2026-01-01');
    expect([...days]).toEqual([...days].sort());
  });

  it('does not claim truncation on a range that fits', async () => {
    await call(post(ping()));
    const d = today();
    const res = await call(new Request(`https://hello.test/v1/export?from=${d}&to=${d}`, {
      headers: { authorization: 'Bearer test-export-token' },
    }));
    expect(res.headers.get('x-export-truncated')).toBeNull();
  });
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd scripts/telemetry-receiver && pnpm test`

Expected: the calendar test FAILS with `200` on the Feb 30 ranges, the truncation test FAILS with 10,001 lines and a null header, and the third test PASSES already (nothing sets the header yet).

- [ ] **Step 3: Export the calendar check**

In `scripts/telemetry-receiver/src/validate.ts`, change `function isCalendarDay(day: string): boolean {` to `export function isCalendarDay(day: string): boolean {` and extend its doc comment with a second sentence:

```
 * Exported because the export route needs the same check: its range ends go
 * through the same `Date.parse` rollover, and a `from` of `2026-02-30` silently
 * became March 2nd, moving the 31-day span with it.
```

- [ ] **Step 4: Bound the read**

In `scripts/telemetry-receiver/src/store.ts`, give `exportRange` the limit and say why it is required:

```ts
/**
 * Reads the rows whose `day` falls in the inclusive range `[from, to]`, at most
 * `limit` of them.
 *
 * The order is by day and then by instance so two calls for the same range
 * return the same file, which keeps a re-run of the collector comparable with
 * the run before it, and so a range that hits the limit always drops the same
 * tail rather than an arbitrary slice.
 *
 * `limit` is required rather than defaulted. An unbounded read of this table is
 * the defect this parameter exists to close, and a default would leave the
 * unbounded call one omission away from being written again.
 */
export async function exportRange(
  db: D1Database,
  from: string,
  to: string,
  limit: number,
): Promise<StoredPing[]> {
  const { results } = await db
    .prepare(
      'SELECT instance, day, received_at, country, schema, body FROM pings WHERE day >= ?1 AND day <= ?2 ORDER BY day, instance LIMIT ?3',
    )
    .bind(from, to, limit)
    .all<PingRow>();
  return results.map((r) => ({
    instance: r.instance,
    day: r.day,
    receivedAt: r.received_at,
    country: r.country,
    schema: r.schema,
    body: r.body,
  }));
}
```

- [ ] **Step 5: Apply the caps in the route**

In `scripts/telemetry-receiver/src/index.ts`, import the calendar check and add the two constants beside `MAX_EXPORT_DAYS`:

```ts
import { parsePing, normaliseCountry, isCalendarDay, MAX_BODY_BYTES } from './validate';
```

```ts
/**
 * Largest number of rows one export answers with.
 *
 * A range holds at most `MAX_EXPORT_DAYS x fleet` rows, since an instance
 * writes one row per day, so this is 31 days times about 320 instances
 * reporting every single day. That is far above any fleet in sight and far
 * below a read that could hurt D1. Whoever raises it should read
 * `MAX_EXPORT_BYTES` below first: the two bound different things.
 */
const MAX_EXPORT_ROWS = 10_000;

/**
 * Largest body this route will build, in bytes.
 *
 * The row cap alone does not bound the response: `parsePing` allows a stored
 * body of up to 4096 bytes, so 10,000 rows is about 6 MB at the payload the
 * spec defines and about 43 MB if every instance padded its unknown fields to
 * the maximum. A Worker assembling a 43 MB string in memory is the case this
 * stops. At real payload sizes it never bites and the row cap governs.
 */
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
```

Then replace the body of `handleExport` from the range check down:

```ts
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return new Response(null, { status: 400 });
  // Shape is not enough. `Date.parse` rolls `2026-02-30` into March, so a range
  // ending on a day that does not exist measured its span from a different day
  // than the one it named and could reach past the 31-day limit.
  if (!isCalendarDay(from) || !isCalendarDay(to)) return new Response(null, { status: 400 });
  const span = daysBetween(from, to);
  if (!Number.isFinite(span) || span < 0 || span >= MAX_EXPORT_DAYS) return new Response(null, { status: 400 });

  const rows = await exportRange(env.DB, from, to, MAX_EXPORT_ROWS);

  // NDJSON: one row per line, a trailing newline only when there is a line to
  // end. An empty range answers with an empty body, which the collector reads
  // as a day nobody reported on.
  //
  // Lines are accumulated rather than mapped so the byte budget can stop
  // partway. The body's shape is unchanged either way, so a collector that
  // knows nothing about truncation still parses what it gets; the header is
  // what tells one that does.
  const lines: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const line = JSON.stringify(row);
    const size = new TextEncoder().encode(line).byteLength + 1;
    if (bytes + size > MAX_EXPORT_BYTES) break;
    bytes += size;
    lines.push(line);
  }
  const truncated = lines.length < rows.length || rows.length === MAX_EXPORT_ROWS;

  const body = lines.join('\n') + (lines.length > 0 ? '\n' : '');
  const headers: Record<string, string> = {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-store',
  };
  // Announced rather than inferred. A truncated answer looks exactly like a
  // complete one, and a collector that silently archived a short day would
  // publish a fleet smaller than the one that reported.
  if (truncated) headers['x-export-truncated'] = '1';
  return new Response(body, { status: 200, headers });
```

- [ ] **Step 6: Run the tests**

Run: `cd scripts/telemetry-receiver && pnpm test`

Expected: PASS, every test in the package. `pnpm test` runs `tsc --noEmit` first, which is what catches a missed `exportRange` call site.

- [ ] **Step 7: Update the doc**

In `docs/systems/telemetry.md` section 8, replace the `GET /v1/export?from=&to=` row of the routes table with:

```
| `GET /v1/export?from=&to=` | requires `Authorization: Bearer <EXPORT_TOKEN>`, compared with `crypto.subtle.timingSafeEqual`. Both ends must be real calendar days, not merely `YYYY-MM-DD` shaped, and the inclusive range is at most 31 days. Returns NDJSON, one `{ instance, day, receivedAt, country, schema, body }` per line, ordered by day then instance, at most 10,000 rows and at most 8 MiB. `401` without the token, `400` for a bad range |
```

and add this paragraph immediately after the table:

```markdown
**The export is bounded at both ends, and says when a bound bit.** A range holds
at most 31 days times the fleet, so `MAX_EXPORT_ROWS` (10,000) is roughly 320
instances reporting every day for the whole window: far above any fleet in sight
and far below a read that could hurt D1. It does not bound the response on its
own, because a stored body may be up to 4096 bytes, so `MAX_EXPORT_BYTES`
(8 MiB) stops the Worker assembling a body it cannot hold. Whichever bites
first, the response carries `x-export-truncated: 1` and the NDJSON keeps its
exact shape, so a collector that knows nothing about the header still parses
what it gets. The rows are ordered by day then instance, so a truncated export
always drops the same tail rather than an arbitrary slice, and re-requesting a
narrower range recovers the rest. Both ends of the range are checked against the
real calendar with the same `isCalendarDay` the ping route uses: `Date.parse`
accepts `2026-02-30` and rolls it into March, which measured the 31-day span
from a day that does not exist and could widen the window by up to three days.
```

- [ ] **Step 8: Commit**

```bash
git add scripts/telemetry-receiver/src/validate.ts scripts/telemetry-receiver/src/store.ts scripts/telemetry-receiver/src/index.ts scripts/telemetry-receiver/src/index.test.ts docs/systems/telemetry.md
git commit -m "fix(telemetry-receiver): bound the export and check its range against the calendar"
```

---

## Task 11 (M8): The missing-token notice reaches stderr, and the endpoint is wired into CI

**Deferred findings, verbatim:** "missing token produces no logged notice (spec 8 asks for one; plan-mandated snippet)" and "TELEMETRY_ENDPOINT not wired into either workflow (only the token is), local runs only can target a staging receiver".

**Files:**
- Modify: `scripts/metrics/src/cli-support.ts` (two new exported helpers)
- Modify: `scripts/metrics/src/cli-collect.ts:45-49`, `scripts/metrics/src/cli-backfill.ts:38-41`
- Modify: `.github/workflows/metrics.yml` (the `Collect` step's `env:` block, around line 164)
- Modify: `.github/workflows/backfill.yml` (the `Backfill` step's `env:` block, around line 154)
- Test: `scripts/metrics/src/cli-support.test.ts`
- Modify: `docs/systems/metrics.md` section 9 ("Running collection locally", the optional-variables paragraph) and section 2 (the collection workflows), plus the telemetry paragraph in section 3

**Interfaces:**
- Produces, from `cli-support.ts`:
  ```ts
  /** The receiver the collector talks to when nothing overrides it. */
  export const DEFAULT_TELEMETRY_ENDPOINT = 'https://hello.backspacechat.com';

  /** The endpoint to use, honouring an override and treating a blank one as unset. */
  export function telemetryEndpoint(env: Readonly<Record<string, string | undefined>>): string;

  /** The notice to print when the export token is unset, or null when it is set. */
  export function telemetrySkipNotice(env: Readonly<Record<string, string | undefined>>): string | null;
  ```

Two reasons both helpers land in `cli-support.ts` rather than inline in the entrypoints. First, the `cli-*.ts` files have no test files of their own by design (metrics.md section 11: they are thin `process.env` and clock wrappers, and their testable cores live here), so a notice written inline is a notice with no test. Second, the default endpoint URL is currently written out twice, once in each entrypoint, and a third copy is one workflow away.

**The blank-value trap, which is why `telemetryEndpoint` exists at all.** Both entrypoints read the endpoint as `process.env['TELEMETRY_ENDPOINT'] ?? 'https://hello.backspacechat.com'`. An Actions `env:` entry interpolating an unset `vars.TELEMETRY_ENDPOINT` sets the variable to the **empty string**, not to nothing, and `?? ` does not catch that. Wiring the variable in without this fix would hand `createTelemetryFetcher` an empty base URL on every repository that has not set the variable, which is every repository including this one. The helper treats blank and whitespace-only as unset.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/metrics/src/cli-support.test.ts`:

```ts
describe('telemetryEndpoint', () => {
  it('defaults when the variable is absent', () => {
    expect(telemetryEndpoint({})).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });

  it('treats an empty or whitespace-only value as absent', () => {
    // An Actions `env:` entry interpolating an unset repository variable sets
    // the empty string rather than nothing, so `?? default` would hand the
    // fetcher an empty base URL on every repo that has not set it.
    expect(telemetryEndpoint({ TELEMETRY_ENDPOINT: '' })).toBe(DEFAULT_TELEMETRY_ENDPOINT);
    expect(telemetryEndpoint({ TELEMETRY_ENDPOINT: '   ' })).toBe(DEFAULT_TELEMETRY_ENDPOINT);
  });

  it('honours an override and trims it', () => {
    expect(telemetryEndpoint({ TELEMETRY_ENDPOINT: 'https://staging.test\n' })).toBe('https://staging.test');
  });
});

describe('telemetrySkipNotice', () => {
  it('names the variable when the token is unset', () => {
    const notice = telemetrySkipNotice({});
    expect(notice).not.toBeNull();
    // The variable's exact name, because the reader of a green CI log has to be
    // able to grep for the thing that is missing.
    expect(notice).toContain('TELEMETRY_EXPORT_TOKEN');
    expect(telemetrySkipNotice({ TELEMETRY_EXPORT_TOKEN: '  ' })).toBe(notice);
  });

  it('says nothing when the token is set', () => {
    expect(telemetrySkipNotice({ TELEMETRY_EXPORT_TOKEN: 'abc' })).toBeNull();
  });

  it('never repeats the token', () => {
    expect(telemetrySkipNotice({ TELEMETRY_EXPORT_TOKEN: '' })).not.toContain('=');
  });
});
```

Add `telemetryEndpoint`, `telemetrySkipNotice` and `DEFAULT_TELEMETRY_ENDPOINT` to the file's existing import from `./cli-support.ts`.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd scripts/metrics && npx vitest run src/cli-support.test.ts`

Expected: FAIL, on the three missing exports.

- [ ] **Step 3: Add the helpers**

Append to `scripts/metrics/src/cli-support.ts`:

```ts
/**
 * The receiver the collector talks to when nothing overrides it.
 *
 * One copy. It was written out in both `cli-collect.ts` and `cli-backfill.ts`,
 * which is two places to change on a move and two chances to change one.
 */
export const DEFAULT_TELEMETRY_ENDPOINT = 'https://hello.backspacechat.com';

/**
 * The receiver base URL for this run.
 *
 * Blank and whitespace-only read as absent, which is not pedantry: a GitHub
 * Actions `env:` entry interpolating an unset repository variable sets the
 * EMPTY STRING rather than leaving the variable out, so `?? default` would hand
 * `createTelemetryFetcher` an empty base URL on every repository that has not
 * set `TELEMETRY_ENDPOINT` -- which is every repository by default. Trimmed for
 * the reason `requiredEnv` trims: the only realistic way whitespace reaches an
 * Actions variable is a stray newline from a prior step.
 */
export function telemetryEndpoint(env: Readonly<Record<string, string | undefined>>): string {
  const raw = env['TELEMETRY_ENDPOINT'];
  const value = raw === undefined ? '' : raw.trim();
  return value === '' ? DEFAULT_TELEMETRY_ENDPOINT : value;
}

/**
 * The line to print when the telemetry export token is not set, or null when it
 * is.
 *
 * Spec section 8 asks for a logged notice rather than a silent skip: without
 * one, a secret rotated away stops the telemetry collection for as long as
 * nobody happens to look at the archive, and every run stays green. The line
 * names the variable so a reader can grep the log for it, and never repeats the
 * value, because this text goes into a public CI log.
 *
 * Returned rather than printed so it can be tested at all. The `cli-*.ts`
 * entrypoints have no test files by design; their testable cores live here.
 */
export function telemetrySkipNotice(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const raw = env['TELEMETRY_EXPORT_TOKEN'];
  const value = raw === undefined ? '' : raw.trim();
  if (value !== '') return null;
  return 'telemetry: skipped, TELEMETRY_EXPORT_TOKEN is not set. The traffic series are unaffected.';
}
```

- [ ] **Step 4: Use them in both entrypoints**

In `scripts/metrics/src/cli-collect.ts`, extend the import from `./cli-support.ts` with `telemetryEndpoint` and `telemetrySkipNotice`, then replace

```ts
  const telemetryToken = process.env['TELEMETRY_EXPORT_TOKEN'] ?? '';
  if (telemetryToken !== '') assertHeaderSafeToken(telemetryToken);
  else console.log('telemetry: skipped, TELEMETRY_EXPORT_TOKEN is not set');
  const telemetryEndpoint = process.env['TELEMETRY_ENDPOINT'] ?? 'https://hello.backspacechat.com';
```

with

```ts
  const telemetryToken = (process.env['TELEMETRY_EXPORT_TOKEN'] ?? '').trim();
  if (telemetryToken !== '') assertHeaderSafeToken(telemetryToken);
  const notice = telemetrySkipNotice(process.env);
  // stderr, not stdout. The run stays green and the exit code is untouched, but
  // the line sits where the bundle's budget warning already sits rather than
  // among the summary lines, so a skip is visible in an otherwise clean log
  // instead of being read as part of the report.
  if (notice !== null) console.warn(notice);
  const endpoint = telemetryEndpoint(process.env);
```

and change the `createTelemetryFetcher(globalThis.fetch, telemetryEndpoint, telemetryToken)` call to use `endpoint`.

Make the identical change in `scripts/metrics/src/cli-backfill.ts`, keeping its own comment above the block ("Optional, exactly as in `cli-collect.ts`...") and dropping its now-duplicated `else console.log(...)` line.

- [ ] **Step 5: Wire the variable into both workflows**

In `.github/workflows/metrics.yml`, in the `Collect` step's `env:` block, directly under the `TELEMETRY_EXPORT_TOKEN` line:

```yaml
          # Optional repository VARIABLE, not a secret: it is a hostname, it is
          # already in the docs, and a secret here would be a secret nobody
          # could read back to check. Unset, `vars` interpolates the empty
          # string and the collector falls back to the default receiver.
          TELEMETRY_ENDPOINT: ${{ vars.TELEMETRY_ENDPOINT }}
```

Make the identical addition in `.github/workflows/backfill.yml`, in the `Backfill` step's `env:` block under its own `TELEMETRY_EXPORT_TOKEN` line. Change nothing else in either file: every `uses:` SHA pin, every `permissions:` block and every fork guard stays exactly as it is.

- [ ] **Step 6: Run the tests and the linters**

Run:

```bash
cd scripts/metrics && npx vitest run
pnpm --filter @backspace/metrics test
cd ../.. && actionlint .github/workflows/metrics.yml .github/workflows/backfill.yml
```

Expected: PASS, and actionlint clean. Then confirm the notice lands on stderr and the exit code is unchanged:

```bash
METRICS_TOKEN=x GITHUB_REPOSITORY=o/r METRICS_DATA_DIR=<scratchpad>/empty \
  node scripts/metrics/src/cli-collect.ts 2>&1 1>/dev/null | head -1
```

Expected: the notice line, on stderr. (The run itself fails afterwards on the fake token; the point of the check is which stream the notice used.)

- [ ] **Step 7: Update the docs**

In `docs/systems/metrics.md` section 3, in the paragraph beginning "**The step is off until the receiver has a token.**", replace the sentence "Unset, `cli-collect.ts` passes no fetcher and the four files are never touched" with:

```markdown
Unset, `cli-collect.ts` passes no fetcher, the four files are never touched, and
the run prints a one-line notice naming `TELEMETRY_EXPORT_TOKEN` on **stderr**
before finishing green. The notice is the point: a secret rotated away would
otherwise stop the telemetry collection silently, for as long as nobody looked
at the archive, with every run still passing.
```

and in the same paragraph replace "`TELEMETRY_ENDPOINT` overrides the default `https://hello.backspacechat.com` and is only needed to point at a staging receiver" with:

```markdown
`TELEMETRY_ENDPOINT` overrides the default `https://hello.backspacechat.com` and
is only needed to point at a staging receiver. It is wired into both workflows
as an optional repository **variable** (`vars.TELEMETRY_ENDPOINT`), not a
secret: it is a hostname, it is documented here, and a secret would be one
nobody could read back to check what it was set to. An unset `vars` entry
interpolates the empty string rather than nothing, so `telemetryEndpoint` in
`cli-support.ts` treats blank as absent; reading it with `?? default` would hand
the fetcher an empty base URL on every repository that has not set it.
```

In section 9's optional-variables paragraph, add the same "variable, not secret" clause after the existing `TELEMETRY_ENDPOINT` sentence, and note that both entrypoints read it through `telemetryEndpoint`.

- [ ] **Step 8: Commit**

```bash
git add scripts/metrics/src/cli-support.ts scripts/metrics/src/cli-support.test.ts scripts/metrics/src/cli-collect.ts scripts/metrics/src/cli-backfill.ts .github/workflows/metrics.yml .github/workflows/backfill.yml docs/systems/metrics.md
git commit -m "feat(metrics): report a skipped telemetry step and allow a staging receiver from CI"
```

---

## Final verification

- [ ] `pnpm --filter @backspace/metrics test`
- [ ] `pnpm --filter @backspace/server test`
- [ ] `pnpm --filter @backspace/web test`
- [ ] `cd scripts/telemetry-receiver && pnpm test` (with the `@vitest` symlinks from Task 10 in place)
- [ ] `node scripts/check-i18n.mjs`
- [ ] `pnpm typecheck`
- [ ] `actionlint .github/workflows/metrics.yml .github/workflows/backfill.yml`
- [ ] The appendix fixture run once more at `--telemetry high`, checking every observation from Tasks 1, 2, 3 and 7 in one page.
- [ ] `git diff --stat main...HEAD` names only the files this plan lists, and no `uses:` SHA pin moved.

---

## Not in this plan

Deferred minors left deferred, all cosmetic or test-internal, none changing a published figure or a contract: A1's unchecked `res.changes` on the `installed_at` log line and its hand-rolled migration fixture; A2's `ne`-rather-than-newer day comparison, its missing other-users-untouched assertion and `addDays`'s absent error contract; A4's missing `res.changes` guard on the `id=1` update, its repeated `parsed as` casts and unclosed handles; A5's fixture values that would survive a swap, its tautological os/arch/node assertions and the thrice-spelled `registrationOpen` precedence; A6's unasserted user-agent and timeout, its uncleared `log.debug` and the nil-effect `lastDay === today` gate; A8's `.env.example` wording, its skipped teaser on an invalid value and `echo -e` without escapes; B1's harness test checking only table existence and its `D1Migration` import from the test package; B2's untested lower-casing, untested `+2` drift boundary, silently skipped non-object count group and inclusive `MAX_COUNT`; B3's ping tests sitting on the limiter budget; B4's two Node stories between the workflow and `ci.yml`; C1's second-pass `instances_30d`, its inline `foldSmall` tiebreaker and its untested input edges; C2's `formatBackfillSummary` wording, its duplicated `daysBefore` and `WRITABLE` omitting `workflows.csv`; C3's consumed blank line before the Releases heading; D1's uncovered 767/768 breakpoint and missing `restoreAllMocks`; D2's untested throwing storage and its stale `recordDismissal` comment; D3's 40 ms pulse stagger, its `useEffect` reduced-motion cross-fade, its per-instance stylesheet and its accumulating dev host divs; D4's untested scrim-click dismissal, its hover class bypassing `accent-primary-hover` and its `bg-surface-elevated` resting state; D5's untested failed-write toast, its headingless loading branch and `formatDay` living alone in web.

---

## Appendix: the fixture verification recipe

`site/insights/index.html` has no automated tests and cannot get any without a new dependency. This is what stands in for them. Run it from the worktree root.

**Do not point `METRICS_OUTPUT_PATH` inside `site/insights/`.** `cli-bundle.ts` rewrites the `BUILD:SUMMARY` region of the `index.html` beside its output path, so pointing it at the real page would edit a committed file as a side effect of a test run. The recipe copies the page to a temp directory first.

The recipe lives in the repository rather than in a scratchpad, so an observation can be reproduced without rebuilding the harness. Two scripts, both Node built-ins only, no dependency added:

- `scripts/metrics/fixtures/insights-fixture.mjs` writes a throwaway archive and a throwaway copy of the site.
- `scripts/metrics/fixtures/insights-check.mjs` loads that copy in whatever Chrome the machine has and reports what it found.

```bash
SP=<scratchpad>
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx" high
METRICS_DATA_DIR="$SP/fx/archive" METRICS_OUTPUT_PATH="$SP/fx/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console
```

To look at it yourself instead, serve the same directory and open `/insights/`:

```bash
python3 -m http.server 8765 --directory "$SP/fx/site"
```

**The fixture copies `site/assets/` as well as `site/insights/`,** and lays them out the way the deployed site lays them out (`<outDir>/site/insights/` beside `<outDir>/site/assets/`). The page loads `../assets/logo.png` and `../assets/dm-sans.woff2`; a copy of `site/insights` alone answers both with a 404, which makes "nothing in the console" impossible to satisfy and hides a real failure behind two expected ones. Serve `<outDir>/site` and open `/insights/`, rather than serving the page directory itself, so `../assets/` resolves the way it resolves in production instead of relying on the browser clamping `..` at the document root.

**Modes.** The second argument to `insights-fixture.mjs` is one of:

| Mode | State |
|---|---|
| `none` | no telemetry files at all, as a bundle built before the pings existed |
| `low` | four instances in the last seven days, below the mark |
| `threshold` | exactly ten, the mark itself, which is the value the published promise turns on |
| `high` | fourteen, above the mark, with all three dimension files populated |
| `high-nodims` | above the mark, but the three dimension files are empty |
| `sparse` | above the mark on the last row only, with every earlier gauge blank |

Rerun both commands after switching modes. Nothing this writes is committed; `$SP/fx` is disposable.

**Prove the console capture before trusting it.** `--prove-console` plants a `console.warn` in the page before any page script runs and exits non-zero if it does not come back. A capture that was never attached and a page that logged nothing look identical from outside, so a clean console reported without this proves nothing. Run it at least once per session.

**What `insights-check.mjs` reports.**

- every console message, page exception and browser log entry, in arrival order
- every request that failed or answered 4xx/5xx
- the rendered telemetry section: the window line, any state note, and per card the title, meta line, note, hint, whether it holds a plot, and each ranked row with its rendered bar width and resolved fill colour
- the ranking rows under every range button, so "the rankings are a snapshot and the range control does not move them" is measured rather than argued
- whether a synthetic drag across the first telemetry chart rezoomed every other chart on the page, by digesting each chart canvas before and after

Two details in the drag are load-bearing and easy to get wrong. uPlot discards a move whose `movementX` and `movementY` are both zero, which is what a synthetic `MouseEvent` reports unless told otherwise, and it needs a frame between the events. Get either wrong and the run reports "nothing moved" for a reason that has nothing to do with the page.
