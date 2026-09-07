# Insights Page Facelift (Track E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `site/insights/index.html` around four figure groups (Reach, Following, Adoption, Delivery), each with one hero chart and a band of compact cards under it, three of them with a band of detail cards as well, plus a lead figure row of four at the top and a `#method` section at the bottom that holds every paragraph of standing prose the group headers give up.

**Architecture:** The page keeps its existing shape: one static HTML file, a shell IIFE that validates the bundle and drives a slot registry, a chart toolkit IIFE that owns the single `new uPlot(...)`, and one IIFE per registered section. The redesign adds two shared surfaces beside them (`INSIGHTS_FIGURES` for the figure and trend arithmetic that the at-a-glance section owns today, `INSIGHTS_GROUPS` for the band and card builders the four groups share), gives `INSIGHTS_CHARTS.mount` a size profile and a release-lane option, and replaces the six section renderers with six of its own: the lead figure row, one per group, and the method coverage line. No series is added, no series is dropped, and the bundle contract is untouched.

**Tech Stack:** Plain ES5-style browser JavaScript inline in one HTML file, inline CSS with Aether Drift tokens declared on `:root`, vendored uPlot 1.6.32, and the committed fixture harness under `scripts/metrics/fixtures/` (Node built-ins only, run under Node 22.18+).

**Spec:** `docs/superpowers/specs/2026-09-06-insights-facelift-design.md`. Read it alongside this plan. Section 2 of the spec is the element inventory the finished page is checked against; section 16 lists twelve calls the owner may reverse, and every task that depends on one says so.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **No new dependencies.** uPlot 1.6.32 stays vendored under `site/insights/vendor/` at its recorded SHA-256 digests; `scripts/metrics/vendor.json` and `vendor-check.test.ts` are untouched. No second chart library, no framework, no build step, no CSS preprocessor, no module system, no DOM test harness, no polyfill, no web font beyond the DM Sans file the page already self-hosts. The page stays one static HTML file with its CSS and JavaScript inline.
- **No network request** beyond the single relative, same-origin `fetch("data.json")` with its 15-second abort. Every colour, font and asset is inline, self-hosted or a system font.
- **The published bundle stays under its 2 MB budget.** `BUNDLE_BUDGET_BYTES` is `2 * 1024 * 1024`. Nothing in this plan changes `bundle.ts`, `downsampleWeekly`, `serialiseWithinBudget`, the budget or the 80 percent warning.
- **The telemetry publication threshold is not weakened.** Nothing telemetry is charted until `telemetry.instances7d` is a number and is at least 10. It is a public promise in the project's privacy copy. The gate stays one positively-expressed line (`cleared = block !== null && typeof block.instances7d === "number" && block.instances7d >= THRESHOLD`), it keeps reading the bundler's precomputed field rather than computing over a parallel array, and its three below-threshold wordings are not collapsed into one.
- **Nothing is cut.** Every series on the charted page today keeps a place on the charted page, inside one of the four groups, at small size when it is not its group's headline. **No figure printed on the charted page today stops being printed either:** where a figure changes place, the task that moves it names the new place and asserts it. Nothing is removed from the `metrics-data` archive, from `data.json`, or from the static tables under `/insights/data/`. `scripts/metrics/src/datapage.ts` is not edited by this plan. Only prose is removed from the charted page, and spec section 7.3 says where each paragraph goes.
- **One idiom per chip.** Every flow chip on the page prints a signed change, computed by `flowTrend` (spec section 4.3). A lead figure printing a change beside a card head printing a one-window total puts two quantities into one idiom with nothing but a `+` sign between them. The one-window 30-day total the chip used to carry is printed in the meta line of the card that draws the series, as a `30d total` pair. The at-a-glance grid keeps its `flowDelta` chips until Task 9 deletes it, so between Tasks 6 and 9 the two idioms are on screen together, which is deliberate: the new pair and the old chip must read the same number.
- **One window statement.** No group renders a `.chart-window` line. `#method`'s coverage line states the selected range and the dates it resolves to once for the page, and each card states in its own meta line the span it actually drew. The three window lines the page renders today are deleted with the sections that render them.
- **The page has no automated tests and cannot get any.** Page behaviour is verified through the committed fixture harness (the recipe below). Where a task leans on a bundler-side guarantee, that guarantee is pinned by a real test in `scripts/metrics`. No task in this plan turns out to need a new one; if a task's implementer finds it does, the test is written in that task and not deferred.
- **The harness needs Node 22.18 or newer.** Both fixture commands run TypeScript through Node's own type stripping with no flag. The repository root allows `>=20.0.0`, so a shell left on Node 20 fails the first command with `ERR_UNKNOWN_FILE_EXTENSION` and names nothing useful.
- **Copy rules for all text, comments and commit messages:** no em dashes, no buzzword register, plain sentences. The page is plain English and is not entering the i18n system. Copy that moves from one place to another moves verbatim, except that an em dash used as punctuation is replaced by the comma, colon or full stop the sentence needs. A string that stays exactly where it is keeps its punctuation; a sweep of untouched strings is not part of this plan. The `DASH` glyph the page prints for an unmeasured value is a glyph in a data cell, not punctuation, and is unchanged.
- **Accessibility:** keyboard navigable, `prefers-reduced-motion` respected, and no worse without JavaScript than the page is today. No element gains a click handler without being a `<button>` or an `<a>`. No new animation of any kind, and specifically no count-up on a figure and no chart draw-in.
- **A reading that the bug also produces is not evidence.** Two separate proofs on this plan have been invalid this way. A fixture asserted a release trend of `0`, which a swapped window, an off-by-one and a double count all produce equally. And Task 6 cited `canvasWidth` 1034 and 311 as proof that a band is in the document before its cards mount, when those are the numbers under the broken ordering too, because the `ResizeObserver` repairs the size immediately afterwards. **Band ordering is proved by instrumenting the `C.mount` call site and reading `inDoc` and `clientWidth` at construction**, which gives `inDoc=true clientWidth=1034` when correct and `inDoc=false clientWidth=0` when not. Tasks 7, 8 and 9 each build a group; none of them may cite the observable size for this. More generally, before writing an assertion, name the change that would make it fail, and if the answer is "none, the repair mechanism hides it", the reading is the wrong one.
- **A step may not assert something the harness report cannot show.** This has already bitten three tasks: Task 2's release caption, and Task 3's `.lead` string and provenance values, were all asserted by steps while the page walk in `insights-check.mjs` collected nothing that could carry them. The failure is quiet in the worst way, because the implementer either proves it out of band and the evidence never reaches the report a reviewer reads, or believes a passing run said something it did not. When a task needs a reading the walk does not collect, that task widens the walk in the same commit, and its report says which reading it added. Widening a reading changes the report and not the page, so the eight-mode byte-identity comparison still has to pass afterwards.
- **`docs/systems/metrics.md` is updated inside the task that changes the contract it describes**, never in a separate docs task. Each task below names the section it owns.
- **Commit messages** follow the repo's conventional style (`type(scope): lower-case summary`, see `git log --oneline -30`). No attribution trailers of any kind and no session links.
- **Do not run `cli-bundle.ts` with `METRICS_OUTPUT_PATH` pointing inside `site/insights/`.** It rewrites the `BUILD:SUMMARY` region of the `index.html` beside its output path, so pointing it at the real page edits a committed file as a side effect of a test run. The recipe below copies the page to a temp directory first.

### The fixture recipe

Every page task ends by running this. `$SP` is the scratchpad directory, `<mode>` one of the fixture modes.

```bash
SP=<scratchpad>
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx" <mode>
METRICS_DATA_DIR="$SP/fx/archive" METRICS_OUTPUT_PATH="$SP/fx/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console
```

To look at the page instead of reading the report:

```bash
python3 -m http.server 8765 --directory "$SP/fx/site"
```

`--prove-console` plants a `console.warn` in the page before any page script and exits non-zero if it does not come back. Run it every time: a capture that was never attached and a page that logged nothing are indistinguishable otherwise, and "the console was clean" is worth nothing without that distinction.

Modes as of Task 1: `none`, `low`, `threshold`, `high`, `high-other`, `high-nodims`, `sparse`, plus the `--strip-telemetry` second pass. Task 1 adds `dimensions-only`; Task 4 adds `long` and `no-releases`; Task 9 adds `release-edge`.

**A pass is read out of the report, not out of the exit status.** The harness deliberately does not exit non-zero on an empty reading, because `dimensions-only` legitimately renders no chart canvas at all and a non-zero exit there would teach every later task to ignore the exit code. It says so in words in the report instead. So every "what counts as a pass" list below is a list of things to read, and a green exit on its own proves only that the run completed.

**Every path that talks to Chrome routes through one helper that throws when the reply carries an exception.** That is what stops an unguarded dereference inside an evaluated expression from coming back as a clean-looking empty report with a passing console proof. Do not add a raw evaluate call beside it in any task: a second path is a second way for a silent failure to get back in.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `site/insights/index.html` | The whole page: tokens and CSS, the shell IIFE (validation, status, range control, slot registry), `INSIGHTS_FIGURES` (new), `INSIGHTS_CHARTS` (profile and release lane), `INSIGHTS_GROUPS` (new), and one IIFE per registered section. | 1 to 9 |
| `scripts/metrics/fixtures/insights-check.mjs` | The verification instrument. Generalised in Task 1 from "read the telemetry slot" to "read every slot, every figure block and every plot's geometry". | 1 |
| `scripts/metrics/fixtures/insights-fixture.mjs` | The throwaway archive. Gains three modes: `dimensions-only` (Task 1), `long` and `no-releases` (Task 4). | 1, 4 |
| `docs/systems/metrics.md` | Section 10 describes this page: its sections and slots, its empty states, the per-card span rule, the telemetry section and the threshold, and section 11's harness description. | 1, 2, 3, 4, 5, 6, 7, 8, 9 |

Nothing else is edited, with one exception the Global Constraints already allow: a task may add a test under `scripts/metrics/src/` to pin a bundler-side guarantee it leans on, written in that task rather than deferred. Task 1 added one, in `bundle.test.ts`. `.github/workflows/**`, `site/index.html` and `site/insights/vendor/**` are untouched, and no production file under `scripts/metrics/src/` is edited by this plan.

---

## Ordering, and why it is a chain

The page is one file and the four groups are assembled out of the six sections that exist today, so the tasks serialize. There is no parallel chain to draw.

The ordering rule is: **no old section is deleted until the group that absorbs its content renders.** That is what keeps every intermediate commit a working, reviewable page rather than a half-restructured one. It has a visible cost between Tasks 4 and 6: the CI activity chart is drawn twice, once in the old Reach section and once as the Delivery hero. That duplication is deliberate and it is the plan's strongest verification tool, because the old card and the new one are on screen together and a figure that disagrees between them is a bug you can see without a diff.

1. **Task 1** and **Task 2** change no rendered output at all. They move the figure arithmetic and the release lane into shared surfaces and generalise the harness. A reviewer's whole question for both is "is the page byte-identical", which is exactly what the harness now answers.
2. **Task 3** adds the `#method` section and the shared group CSS. It moves page-level prose but draws no figure. It exists before any group task because a group task rewrites its panel's paragraphs, and those paragraphs need somewhere to land in the same commit that removes them, or the inventory in spec section 2 is broken mid-chain.
3. **Task 4** builds Delivery. It goes first among the groups because it is the smallest (three cards) and it exercises everything new at once: the compact profile, the hero profile, the release lane as a toolkit option, the per-card error wrapper, the `heading` presentation and the release trend. Everything after it reuses machinery this task proves.
4. **Task 5** builds Adoption. Its detail band is the telemetry section moved wholesale, so it deletes `#instances` in the same commit and nothing is drawn twice.
5. **Task 6** rebuilds Reach's traffic cards and retires the old reach section. **Task 7** builds the fourth group, Following, out of the growth section and retires it in the same commit. **Task 8** moves the two ranked dimension cards into Reach's detail band and retires both dimension sections. Each deletes exactly the old section whose content it just rebuilt, which is what keeps the ordering rule intact through the middle of the chain.
6. **Task 9** is the cutover: the lead figure row, the removal of the at-a-glance section, the nav rewrite, and the shell's last two edits.

**Why Following is a group and not three more cards in Reach.** Page views, clones, referring sites and popular paths are traffic: people finding the project. Stars, forks and watchers are people who clicked a button to keep track of it. They are two questions, and they were together only because the dissolved growth section had nowhere else to go. Left together, Reach would hold seven of the page's twelve cards and it is the first group a reader meets, which is the bombardment concentrated in the worst place. Split, the counts are Reach 4, Following 3, Adoption 2 below the telemetry gate and 7 above it, and Delivery 3. Spec section 3.2 carries the reasoning and section 9 carries what it costs.

**Which tasks touch the shared shell.** The shell is the first `<script>` block: `SLOT_IDS`, `validateBundle`, `evaluateFreshness`, the range control, `registerSection`, `renderSlots` and the `INSIGHTS` surface.

| Task | Shell | Chart toolkit | Own section only |
|---|---|---|---|
| 1 | no | no | at-a-glance, plus the new `INSIGHTS_FIGURES` surface |
| 2 | no | yes (`mount` gains `releases`) | growth |
| 3 | yes (`SLOT_IDS` gains `method-coverage`, `NOTE_SLOT_IDS` introduced, `renderSlots` restricted to it) | no | at-a-glance loses its window note; new method section |
| 4 | yes (`SLOT_IDS` gains `delivery-body`) | yes (`profile`, `fittedCounts`, `measuredPositions`) | new delivery section, plus the new `INSIGHTS_GROUPS` surface |
| 5 | yes (`SLOT_IDS` gains `adoption-body`, loses `telemetry`) | no | new adoption section, telemetry section retired |
| 6 | yes (`SLOT_IDS` gains `reach-body`, loses `chart-reach`) | no | new reach section, old reach section retired; `INSIGHTS_FIGURES` gains `flowTrend` and exports `flowDelta` |
| 7 | yes (`SLOT_IDS` gains `following-body`, loses `chart-growth`) | no | new following section, growth section retired |
| 8 | yes (`SLOT_IDS` loses `ranked-referrers`, `ranked-paths`) | no | reach section grows two cards, dimension sections retired |
| 9 | yes (`SLOT_IDS` gains `lead-figures`, loses `header-stats`) | yes (`placeHint` retired) | new lead-figure section, at-a-glance retired |

`validateBundle`, `evaluateFreshness`, `rangeWindow`, `rangeSlice`, `archiveStartDay`, `archiveEndDay`, `resolutionStepDays`, `resolutionSuffix`, `SERIES_NAMES`, the four ranges, the `all` default, the fetch timeout, `parseDay`, `formatDay`, `formatCount`, `formatInstant`, `dayGap`, `DASH` and `DELTA_DAYS` are not touched by any task in this plan. `SERIES_NAMES` in particular does not gain `telemetry.network`, for the reason `docs/systems/metrics.md` section 10.8 gives.

---

## Decisions this plan makes, and the spec lines they depart from

Each of these was forced by something the page or CSS cannot do as written. They are small, and each is reversible on its own.

1. **Slot ids for the four groups are `reach-body`, `following-body`, `adoption-body` and `delivery-body`, not the bare group names.** Spec section 11.1 gives the bare names, but spec section 5.1 keeps `#reach` as the section anchor and section 5.2 puts `div.slot#<group>` inside `section#<group>`. Two elements with the same id is invalid HTML and `getElementById("reach")` would return the section, not the slot, so `renderSlots` would clear the whole panel including its static heading. The anchors stay `#reach`, `#following`, `#adoption`, `#delivery`; the slots take the `-body` suffix. `lead-figures` and `method-coverage` collide with nothing and keep their spec names.
2. **The band grids use `repeat(auto-fill, minmax(300px, 1fr))` and `repeat(auto-fill, minmax(420px, 1fr))`.** Spec section 5.4 writes `minmax(300px, minmax(0, 1fr))`, which is not valid CSS: `minmax()` does not nest, its second argument must be a track breadth. The overflow that nesting was reaching for is already handled: `.chart-card` carries `min-width: 0`, and the `.rank-*` truncation is unchanged. `auto-fill` rather than `auto-fit` because three of the four series bands hold exactly one compact card after the split (Reach's clones, Adoption's update checks, Delivery's contributors), and `auto-fit` collapses the empty tracks and stretches that single card to the full row, where it reads as a second hero.
3. **The resulting column counts match spec section 9.1 everywhere except within about 50px of the 1000px boundary**, where the intrinsic 300px and 420px minimums decide instead. Adding media queries to force the table exactly would be three breakpoints in service of a 50px window; the intrinsic rule is the one the layout actually wants.
4. **A card carries an area fill if and only if its y axis starts at zero, the heroes included.** Spec section 6.4 gives the Adoption hero (App downloads) a fill, and the growth rationale this page already ships, now spec section 3.2, says a fill reads as area measured from zero and must not sit under a fitted axis. Both are satisfied by drawing App downloads on `zeroBasedCounts`: it is a cumulative counter of files fetched and its floor at zero is real. Following's hero, Stars, is the case where the two rules collide: it is cumulative, it has to be fitted or the only movement the chart is for is flattened, and so it carries no fill. It is the one hero on the page without one, spec sections 3.2 and 9 say so, and Task 7 asserts it. Every compact card carries no fill either way, so the rule holds across the page with one stated consequence rather than one exception.
5. **A card whose series has fewer than two measured positions on its axis states its reading instead of drawing a plot.** Spec section 3.6 says every card with a dated column is drawn as a compact plot, and spec section 8.2 now carries the row for the one-point case that this decision forced. It is not hypothetical: `contributors.csv` holds one row in the live archive and one in the fixture, and uPlot handed a single point on a time scale invents an x range (measured against this archive: one point on 2026-09-01 produced an axis running to 2029-05-28). The growth section already refuses this case with `singlePointNote`; this plan generalises the refusal to a per-card rule so every compact card inherits it.
6. **The weekly bucket caution is not moved verbatim onto the Delivery hero.** Spec section 12.2 moves the release machinery across unchanged, but the growth section's `weeklyNote()` says a point "carries the last value measured in that week", which is true of a cumulative total and false of a summed workflow-run count. Moving it would publish a false sentence on a page whose whole claim is that it does not. The verbatim wording stays with stars, forks and watchers in Following, where it is true, and Delivery's hero gets a short caution of its own about a bucket's Monday key against an exactly dated marker. (Written before the group split, this decision said Reach and named two series; the reasoning was unaffected, only the destination and the count.)
7. **The per-card failure note reads "This card could not be rendered."** Spec section 11.3 asks for the existing wording verbatim; the existing wording says "section", which would be false inside a band. The other three claims of that note are verbatim.
8. **`INSIGHTS_GROUPS` exists.** The spec describes a uniform card system across four groups but names no shared surface for it. Four copies of the compact-card builder is exactly the drift this file's own comments argue against, so the band and card builders live in one IIFE beside `INSIGHTS_FIGURES` and `INSIGHTS_CHARTS`.
9. **`renderFigure`'s `"card"` mode is the compact card head**, per spec section 11.4's name. The at-a-glance section's own `.stat` box keeps its private builder until Task 9 deletes it, so the two presentations never have to be the same function.
10. **`flowTrend` lands in Task 6, not Task 9.** Spec section 4.3 makes every flow chip a signed change, and the first flow chips a group prints are Reach's group head and its clones card head, both of which Task 6 builds. Landing the function later would put a `flowDelta` chip on the clones card for three commits and then change it, which is a state nobody reviews and a diff nobody wants. Task 9 consumes it and adds nothing to it.

---

## Task 1: The harness reads the whole page, and the figure arithmetic moves to `INSIGHTS_FIGURES`

**Files:**
- Modify: `scripts/metrics/fixtures/insights-check.mjs` (the `OBSERVE` expression and the report)
- Modify: `scripts/metrics/fixtures/insights-fixture.mjs` (one new mode)
- Modify: `site/insights/index.html` (new IIFE after the shell; the at-a-glance IIFE rebuilt on it)
- Modify: `docs/systems/metrics.md` section 11 (what the harness reports, and the new mode)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `window.INSIGHTS_FIGURES`, referenced as `F` by every later section.

  ```
  F.figure(spec, data, windows)  -> { label, valueText, unmeasured, sub, note, delta }
  F.chip(delta)                  -> the .stat-delta element, with its title and its .vh span
  F.windows(data)                -> { point, flow, step } | null   the fixed 30-day windows
  F.rowsLabel(count, step)       -> "12 measured days" | "3 measured weekly buckets"
  F.recordsLabel(count)          -> "2 recorded changes"
  F.newestMeasured(series, field, notAfterMs) -> { value, dayMs } | null
  F.oldestMeasured(series, field)             -> { value, dayMs } | null
  F.countMeasured(series, field, from, to)    -> number
  F.coverageGap(days, win, step)              -> string | null
  F.unavailable(reason)                       -> { available: false, reason: reason }
  F.plural(count, singular, pluralWord)       -> string
  ```

  `spec` is `{ label, kind, series, field, note? }` with `kind` one of `"flow"`, `"point"`, `"step"`. `windows` is `F.windows(data)` or `null`. The `delta` object is unchanged from what `flowDelta` / `pointDelta` / `stepDelta` return today: `{ available, signed, value, windowDays, headline, detail }` or `{ available: false, reason }`.

- [ ] **Step 1: Teach `insights-check.mjs` to observe any slot, any figure block and any plot's geometry**

Replace the `OBSERVE` constant in `scripts/metrics/fixtures/insights-check.mjs` with the expression below, and replace the single `observed` evaluation with it. The point of the geometry fields is that they are the only falsifiable evidence for the two things Task 4 changes: a plot's profile (its height) and the release lane (the padding reserved above the plot area).

```js
/*
 * Read back out of the page. Runs in the page, returns plain data.
 *
 * Every slot, not only the telemetry one: after the facelift there are five,
 * and a report that can only see one of them cannot tell whether a figure
 * moved or vanished.
 *
 * The geometry is the part the eye cannot check. A compact plot and a hero
 * plot differ by their height and by the room reserved above the plot area,
 * and both are numbers uPlot writes into the DOM: `.u-over` is positioned at
 * the top-left of the plot area, so its offset inside the chart root is the
 * padding that was reserved, and its height is the plot height the profile
 * asked for.
 */
const OBSERVE = `(function () {
  function text(node) {
    return node === null ? null : node.textContent.replace(/\\s+/g, " ").trim();
  }
  function figureOf(scope) {
    var value = scope.querySelector(".stat-value");
    if (value === null) return null;
    var chip = scope.querySelector(".stat-delta");
    return {
      label: text(scope.querySelector(".stat-label")),
      value: text(value),
      unmeasured: value.classList.contains("is-unmeasured"),
      sub: text(scope.querySelector(".stat-sub")),
      note: text(scope.querySelector(".stat-note")),
      chip: chip === null ? null : text(chip),
      chipTitle: chip === null ? null : chip.title
    };
  }
  function plotOf(card) {
    var root = card.querySelector(".uplot");
    if (root === null) return null;
    var over = root.querySelector(".u-over");
    var rootBox = root.getBoundingClientRect();
    var canvas = root.querySelector("canvas");
    var legend = [];
    root.querySelectorAll(".u-legend .u-series > th").forEach(function (th) {
      legend.push(text(th));
    });
    return {
      canvasWidth: canvas === null ? null : Math.round(canvas.getBoundingClientRect().width),
      canvasHeight: canvas === null ? null : Math.round(canvas.getBoundingClientRect().height),
      overTop: over === null ? null : Math.round(over.getBoundingClientRect().top - rootBox.top),
      overHeight: over === null ? null : Math.round(over.getBoundingClientRect().height),
      overWidth: over === null ? null : Math.round(over.getBoundingClientRect().width),
      scrolls: (function () {
        var box = card.querySelector(".chart-scroll");
        return box === null ? null : box.scrollWidth > box.clientWidth + 1;
      })(),
      legend: legend
    };
  }
  function cardOf(card) {
    var hints = [];
    card.querySelectorAll(".chart-hint").forEach(function (h) { hints.push(text(h)); });
    var entry = {
      title: text(card.querySelector(".chart-title")),
      titleTag: card.querySelector(".chart-title") === null
        ? null : card.querySelector(".chart-title").tagName,
      compact: card.classList.contains("is-compact"),
      meta: text(card.querySelector(".chart-meta")),
      note: text(card.querySelector(".slot-note")),
      hints: hints,
      figure: figureOf(card),
      plot: plotOf(card),
      rows: []
    };
    card.querySelectorAll(".rank-row").forEach(function (row) {
      /* A rank row without a bar is ordinary, not a fault: Task 4's release
       * list is a dated list of releases and a date has no bar to draw. The
       * guard is here rather than at the call site because an unguarded
       * dereference here fails SILENTLY. Runtime.evaluate returns the
       * exception in its command reply rather than raising it as
       * Runtime.exceptionThrown, so the console capture stays clean, the
       * report prints `undefined` for the whole page, and every "what counts
       * as a pass" list in Tasks 4 through 9 loses the only evidence it has.
       * Do not remove it. */
      var fill = row.querySelector(".rank-fill");
      entry.rows.push({
        rank: text(row.querySelector(".rank-n")),
        name: text(row.querySelector(".rank-name")),
        num: text(row.querySelector(".rank-num")),
        width: fill === null ? null : Math.round(fill.getBoundingClientRect().width),
        fill: fill === null ? null : getComputedStyle(fill).backgroundColor
      });
    });
    return entry;
  }
  var out = { slots: [], stats: [], hint: null, nav: [], sections: [] };
  var hint = document.getElementById("chart-hint");
  out.hint = hint === null ? null : {
    text: text(hint),
    /* Which element the hint's own wrapper follows, so "the hint sits under
     * the sticky bar" is checked rather than assumed. */
    after: (function () {
      var prev = hint.parentNode === null ? null : hint.parentNode.previousElementSibling;
      return prev === null ? null : (prev.id || prev.className || prev.tagName);
    })()
  };
  document.querySelectorAll(".nav-link").forEach(function (a) {
    out.nav.push(a.getAttribute("href") + " " + text(a));
  });
  document.querySelectorAll("section.panel").forEach(function (s) {
    out.sections.push({
      id: s.id,
      heading: text(s.querySelector("h2")),
      label: text(s.querySelector(".ch-label")),
      copy: (function () {
        var parts = [];
        s.querySelectorAll(":scope > .wrap > .sec-copy").forEach(function (p) {
          parts.push(text(p));
        });
        return parts;
      })()
    });
  });
  document.querySelectorAll(".slot").forEach(function (slot) {
    var entry = {
      id: slot.id,
      window: text(slot.querySelector(".chart-window")),
      windowNote: text(slot.querySelector(".window-note")),
      notes: [],
      plots: slot.querySelectorAll(".uplot").length,
      figures: [],
      cards: []
    };
    slot.querySelectorAll(":scope > .slot-note, :scope > .slot-note-detail").forEach(function (n) {
      entry.notes.push(text(n));
    });
    slot.querySelectorAll(".stat, .lead-figure, .group-head").forEach(function (box) {
      entry.figures.push(figureOf(box));
    });
    slot.querySelectorAll(".chart-card").forEach(function (card) {
      entry.cards.push(cardOf(card));
    });
    out.slots.push(entry);
  });
  return out;
})()`;
```

Then change the two places that referenced the telemetry slot by name:

- The readiness poll waits for `#telemetry` to hold children. Replace its expression with one that waits for any slot to hold children:
  ```js
  expression: '(function () { var s = document.querySelectorAll(".slot");'
    + ' for (var i = 0; i < s.length; i++) { if (s[i].children.length > 0) return true; }'
    + ' return false; })()',
  ```
  and change its timeout message to `'no slot on the page held anything 20s after load'`.
- `RANKING_DIGEST` and `DRAG_FIRST_TELEMETRY_CHART` select inside `#telemetry`. Replace `#telemetry ` with `.slot ` in both, and rename `DRAG_FIRST_TELEMETRY_CHART` to `DRAG_FIRST_CHART`, its two failure strings to `"no chart to drag"` and `"the first chart is too narrow to drag across"`, and the report heading from `drag:` to `drag (first chart on the page):`.
- **A third `#telemetry` selector, in `main()`'s per-range sweep**, reads `#telemetry .chart-window` into the sweep's `window` column. Repoint it at `.slot .chart-window`. Once Task 5 deletes the telemetry slot the old selector would return `""` for every range, silently, for the rest of the plan, and it is one of only two pieces of per-range evidence the report carries.
- **The report heading `=== telemetry section ===`** now prints the whole page. Rename it `=== page ===`. Step 1 updates the file's header comment; this line is the one it is easy to miss.

Add one column to that same per-range sweep, so Task 3's coverage-line check is evidence in the report rather than something only a browser can see:

```js
        coverage: await evaluate('(document.querySelector("#method-coverage .window-note")'
          + ' || { textContent: "" }).textContent.replace(/\\s+/g, " ").trim()'),
```

and print it beside the window and the ranking digest as `method-coverage`. The column is empty until Task 3 registers that slot, which is expected and is not a failure before then.

**A note for whoever reads this task later.** Steps 1 and 2 are already implemented and merged; the text above is the record of what the harness does and why, not an instruction to redo it. Four things in it are load-bearing and easy to undo by accident, and none of them changes any pass list:

- **The `.rank-fill` null guard**, for the reason its comment gives.
- **The `.slot` selectors**, which are what let one report cover a page whose slot ids change in seven of the nine commits.
- **The slot-note selection filter.** The harness selects `.slot-note` at any depth and then keeps only the nodes whose `closest(".chart-card")` is `null`. The filter is the whole point: Task 4 puts a failure note inside a card, and an unfiltered selection would report that card's note as one of its slot's notes and count it twice. It is output-neutral across all eight modes today, which is exactly why somebody would simplify it away. Task 3 restates it as a constraint.
- **The single Chrome helper** that throws on an exception in the reply, described in the recipe above.

Finally, print the canvas digest map rather than only the before/after verdict, so two runs on two commits can be compared:

```js
  console.log('\n=== zoom sync ===');
  console.log(`drag (first chart on the page): ${dragResult}`);
  for (const key of Object.keys(after ?? {})) {
    const moved = before?.[key] !== after[key];
    console.log(`  ${moved ? 'redrew' : 'unchanged'}  ${key}  ${before?.[key]} -> ${after[key]}`);
  }
```

Update the file's own header comment: it reports "the text of the telemetry section as it actually rendered" today, and now reports every slot, every figure block, every card and every plot's geometry.

- [ ] **Step 2: Add the `dimensions-only` fixture mode**

The whole-page state "the archive holds no dated measurement, so there is no time axis" is reachable on a non-empty bundle and no mode produces it. Every figure card and every group renderer has a branch for it, and this task's extraction moves three of those branches.

In `scripts/metrics/fixtures/insights-fixture.mjs`, add `'dimensions-only'` to `MODES`, extend the header comment's mode list with

```
 *   dimensions-only  no dated series at all, only a referrer and a path
 *                    snapshot, so the bundle is non-empty, collection_started
 *                    is null and the range control has nothing to anchor to
```

and wrap the traffic writes so the mode skips them. Replace the block that begins `// Traffic, so the bundle is not empty` through the `s.writeCsv('releases.csv', ...)` line with:

```js
// Traffic, so the bundle is not `empty` and the range control has an anchor.
// `dimensions-only` deliberately writes none of it: the bundle is then
// non-empty on its dimension snapshots alone, `collection_started` is null,
// and every renderer takes its "no dated measurement to anchor a window to"
// branch. That state is reachable in production (an archive holding only
// releases or only dimension snapshots) and no other mode reaches it.
if (mode !== 'dimensions-only') {
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
}
```

Leave the two `writeNdjson` dimension writes and `writeMeta` outside the guard: they are what makes this mode non-empty. Also guard the telemetry block so `dimensions-only` writes none (`if (mode !== 'none' && mode !== 'dimensions-only')`).

- [ ] **Step 3: Record the page as it stands, before touching it**

```bash
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx" high
METRICS_DATA_DIR="$SP/fx/archive" METRICS_OUTPUT_PATH="$SP/fx/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console > "$SP/before-high.txt"
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx2" dimensions-only
METRICS_DATA_DIR="$SP/fx2/archive" METRICS_OUTPUT_PATH="$SP/fx2/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx2/site" --prove-console > "$SP/before-dimonly.txt"
```

Both runs must report `console capture proof: PASS`. `before-high.txt` must show the `header-stats` slot with eight `figures` entries; if it shows zero, the observe expression is wrong and everything after this is worthless.

- [ ] **Step 4: Move the figure arithmetic into a new `INSIGHTS_FIGURES` IIFE**

Insert a new `<script>` block immediately after the shell's closing `})();</script>` and before the `header-stats` block. Move these functions out of the at-a-glance IIFE into it, unchanged in body: `newestMeasured`, `oldestMeasured`, `countMeasured`, `unavailable`, `plural`, `rowsLabel`, `recordsLabel`, `pointDelta`, `stepDelta`, `coverageGap`, `flowDelta`, `deltaChip`, `flowCard`, `pointCard`, `stepCard`. Do not reword a single string in this task: this task's whole verification is that nothing changed.

The new block:

```html
<script>
/*
 * Shared figure helpers.
 *
 * The at-a-glance section owned all of this. The facelift gives it four
 * consumers instead of one -- the lead figure row and each of the three
 * groups' compact card heads -- and the rule this surface exists to make
 * enforceable is that A FIGURE IS COMPUTED ONCE PER RENDER AND RENDERED IN AS
 * MANY PLACES AS NEEDED. The lead figure row and a group head printing
 * different numbers for the same series is the failure this shape prevents,
 * and it is a failure nothing on the page would otherwise catch: both numbers
 * would look entirely ordinary on their own.
 *
 * Everything here is moved rather than rewritten. Every refusal sentence,
 * every caption and every plural travels with the function that produced it,
 * because a sentence written to be exactly true stops being true the moment
 * it is paraphrased.
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var DASH = I.DASH;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /* ... every function listed above, moved verbatim ... */

  /*
   * The two fixed 30-day windows every figure on this page is measured over,
   * and the reason they are computed once rather than per card.
   *
   * `point` and `step` windows open a full 30 days before the close, `flow`
   * windows on the first of the 30 days: a sum counts the days it covers,
   * where a point-in-time difference compares against the state before them.
   * The two kinds genuinely need windows offset by one day from each other,
   * and collapsing them would either drop a day from the sum or claim a
   * comparison the archive cannot make.
   *
   * Null when the archive holds no dated row to anchor them to.
   */
  function windows(data) {
    var endMs = I.archiveEndDay(data);
    if (isNaN(endMs)) return null;
    return {
      point: { startMs: endMs - I.DELTA_DAYS * I.DAY_MS, endMs: endMs },
      step: { startMs: endMs - I.DELTA_DAYS * I.DAY_MS, endMs: endMs },
      flow: { startMs: endMs - (I.DELTA_DAYS - 1) * I.DAY_MS, endMs: endMs }
    };
  }

  /*
   * One figure, computed. `spec` is `{ label, kind, series, field, note }`
   * with `kind` one of "flow", "point" or "step"; `wins` is `windows(data)`
   * or null.
   *
   * The three `*Card` functions it dispatches to are the ones the at-a-glance
   * section has always used, so a figure printed by a compact card head and
   * the same figure printed by the lead row come out of one code path.
   */
  function figure(spec, data, wins) {
    var step = I.resolutionStepDays();
    var body;
    if (spec.kind === "flow") {
      body = flowCard(spec, data, wins === null ? null : wins.flow, step);
    } else if (spec.kind === "step") {
      body = stepCard(spec, data, wins === null ? null : wins.step);
    } else {
      body = pointCard(spec, data, wins === null ? null : wins.point, step);
    }
    body.label = spec.label;
    body.note = spec.note === undefined ? null : spec.note;
    return body;
  }

  window.INSIGHTS_FIGURES = {
    figure: figure,
    chip: deltaChip,
    windows: windows,
    rowsLabel: rowsLabel,
    recordsLabel: recordsLabel,
    newestMeasured: newestMeasured,
    oldestMeasured: oldestMeasured,
    countMeasured: countMeasured,
    coverageGap: coverageGap,
    unavailable: unavailable,
    plural: plural
  };
})();
</script>
```

`flowCard`, `pointCard` and `stepCard` currently take a `card` argument and read `card.series` / `card.field`; the spec object has the same two keys, so they move unchanged.

- [ ] **Step 5: Rebuild the at-a-glance IIFE on it**

The at-a-glance block keeps `CARDS`, `COVERAGE`, `el`, `pair`, `buildCard`, `windowNote` and `render`, and loses everything moved in Step 4. Its `render` becomes:

```js
  function render(slot, data, rangeKey) {
    var step = I.resolutionStepDays();
    var wins = F.windows(data);

    var grid = el("div", "stat-grid");
    for (var i = 0; i < CARDS.length; i++) {
      grid.appendChild(buildCard(CARDS[i], F.figure(CARDS[i], data, wins)));
    }
    slot.appendChild(grid);
    slot.appendChild(windowNote(data, rangeKey, step));
  }
```

with `var F = window.INSIGHTS_FIGURES;` beside `var I = window.INSIGHTS;`. `buildCard` reads `body.valueText`, `body.unmeasured`, `body.sub`, `body.delta` and `card.note` exactly as it does now, and calls `F.chip(body.delta)` where it called `deltaChip(body.delta)`. `windowNote` calls `F.countMeasured`, `F.rowsLabel`, `F.recordsLabel` and `F.plural`.

The `CARDS` array gains nothing and loses nothing. The `kind` values it already carries (`"point"`, `"flow"`, `"step"`) are the ones `figure` dispatches on.

- [ ] **Step 6: Run the recipe at `high` and at `dimensions-only`, and diff against Step 3**

```bash
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx" high
METRICS_DATA_DIR="$SP/fx/archive" METRICS_OUTPUT_PATH="$SP/fx/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console > "$SP/after-high.txt"
diff "$SP/before-high.txt" "$SP/after-high.txt"
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx2" dimensions-only
METRICS_DATA_DIR="$SP/fx2/archive" METRICS_OUTPUT_PATH="$SP/fx2/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx2/site" --prove-console > "$SP/after-dimonly.txt"
diff "$SP/before-dimonly.txt" "$SP/after-dimonly.txt"
```

**What counts as a pass, and what counts as a failure:**

- Both diffs are empty apart from canvas digest values, which are a hash of a rendered canvas and may differ between runs. Any difference in the `slots` block, in a `figures` entry, in a card's `meta`, `note` or `hints`, or in the `nav`/`sections` blocks is a failure: this task is a move and must change nothing.
- In `after-high.txt` the `header-stats` slot has exactly eight `figures` entries, in the order Stars, Forks, Watchers, Views, Clones, Contributors, App downloads, Update checks. Any other count means a card was lost in the move.
- The Clones entry carries `note: "includes this repo's own CI checkouts"`. If it is `null`, `buildCard` stopped reading `card.note`.
- Every entry's `chipTitle` is a full sentence, not empty. An empty `chipTitle` means `deltaChip`'s explanation was dropped when the function moved. The Views entry's `chipTitle` begins `Total over the 30 days to`; the Contributors entry's begins `Change over the 30 days to` and its body contains `This series records a row when its total changes rather than sampling daily`.
- In `after-dimonly.txt` the `header-stats` slot still has eight `figures` entries, every `chip` reads the dash glyph, and every `chipTitle` contains `the archive holds no dated measurement to anchor a window to`. The `windowNote` reads `selected range no dated measurement to window`. If any of those is missing, the null-window path was lost in the move. This is the case the `dimensions-only` mode was added for.
- `console messages: 1` (the planted probe and nothing else) and `failed or 4xx/5xx requests: 0` on both runs, and `console capture proof: PASS` on both.

- [ ] **Step 7: Update `docs/systems/metrics.md` section 11**

In the paragraph beginning "**The dashboard page itself has no tests.**", replace the description of what the two scripts do:

- the fixture writes "a throwaway archive in one of eight states (`none`, `low`, `threshold`, `high`, `high-other`, `high-nodims`, `sparse`, `dimensions-only`)"
- `insights-check.mjs` "reports the console, the failed requests, every slot on the page with its figures and cards, each plot's rendered geometry (its canvas size, the plot area's offset inside the chart root, and whether its scroll container overflows), the rankings under each range button, and whether a drag on one chart rezoomed the rest"
- add: "`dimensions-only` is the eighth: it writes no dated series at all, only a referrer and a path snapshot, so the bundle is non-empty while `collection_started` is null and every renderer takes its no-time-axis branch. That state is reachable in production and no other mode reaches it."

- [ ] **Step 8: Commit**

```bash
git add site/insights/index.html scripts/metrics/fixtures/insights-check.mjs \
        scripts/metrics/fixtures/insights-fixture.mjs docs/systems/metrics.md
git commit -m "refactor(insights): move the figure arithmetic to a shared surface"
```

---

## Task 2: Release markers become a chart toolkit option

**Files:**
- Modify: `site/insights/index.html` (the `INSIGHTS_CHARTS` IIFE and the `chart-growth` IIFE)
- Modify: `docs/systems/metrics.md` section 10.7

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, on `window.INSIGHTS_CHARTS`:

  ```
  C.collectReleases(releases, startMs, endMs) -> { groups, outside, unreadable }
  C.releaseCaption(collected, total)          -> a <p class="chart-meta"> element
  C.releaseNarrative(collected, total, stepDays) -> string | null
  C.releaseLabel(release)                     -> string
  C.listGroups(groups)                        -> string
  C.listOutside(outside)                      -> string
  C.pixelRatio()                              -> number
  mount(host, xs, defs, { releases: collected })  reserves the lane and paints it
  ```

  A `group` is `{ dayMs, entries: ReleaseEntry[], label }`; an `outside` entry is `{ dayMs, release }`.

- [ ] **Step 1: Record the growth section as it stands**

```bash
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx" high
METRICS_DATA_DIR="$SP/fx/archive" METRICS_OUTPUT_PATH="$SP/fx/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console > "$SP/before-t2.txt"
```

The `high` fixture writes one release on day 10 of a 40-day star history, so the marker falls inside the drawn span and the lane is painted. Confirm in `before-t2.txt` that the `chart-growth` slot's `window` line is present, that two cards named Stars and Forks each report a `plot`, and that both report `overTop` around 34 (the lane reservation). If `overTop` is around 8, the release option is not in force today and this task's verification cannot fail.

- [ ] **Step 2: Move the lane into `INSIGHTS_CHARTS`**

Cut from the `chart-growth` IIFE and paste into the `INSIGHTS_CHARTS` IIFE, unchanged in body: `RELEASE_TOKEN`, `RELEASE_FALLBACK`, `MONO_STACK`, `LANE_CSS`, `LANE_ROWS`, `ROW_CSS`, `LABEL_PX`, `LABEL_GAP_CSS`, `MAX_LISTED`, `releaseLabel`, `collectReleases`, `listGroups`, `listOutside`, `releasePainter`, `pixelRatio`, `releaseLine` (renamed `releaseCaption`) and `releaseNarrative`. `releaseCaption` needs `el` and `pair`; the toolkit has neither, so add them at the top of the toolkit IIFE:

```js
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function pair(key, value, accent) {
    var span = el("span");
    span.appendChild(el("span", "k", key));
    span.appendChild(document.createTextNode(" "));
    span.appendChild(el("span", accent ? "v rel" : "v", value));
    return span;
  }
```

`releaseNarrative` calls `plural` and `stepWord`; **copy** both into the toolkit rather than moving them, and leave the growth section's own `plural`, `steps` **and `stepWord`** where they are. `stepWord` in particular is not optional: `singlePointNote` calls it three times (`index.html:4371`, `:4387`, `:4395`) and stays in the growth section until Task 7, so cutting it out here makes those three calls a `ReferenceError` under `"use strict"` on any bundle whose growth axis has fewer than two steps. That is a live failure of the growth slot on the commits of Tasks 2 through 6.

The fixture cannot catch it, which is the reason to be explicit rather than careful: every mode except `dimensions-only` writes 40 star rows, and `dimensions-only` returns at the `win === null` branch before the one-point check, so **no fixture mode reaches `singlePointNote` at all**. Step 5's diff would pass on a broken page. The duplication costs three lines and is deleted with the block in Task 7.

- [ ] **Step 3: Give `mount` the `releases` option**

The lane wiring goes where the existing `if (opts.hooks !== undefined) config.hooks = opts.hooks;` line is (`index.html:3180`), **after** the `config` object literal closes. It is a run of statements that assign `config.padding` and `config.hooks`, so putting it inside the literal, between the `padding` and `series` keys, is a syntax error.

The documentation block above `mount` gains one entry in its closed set:

```
 *   releases     `{ groups, outside, unreadable }` from `collectReleases`.
 *                Reserves the lane above the plot and paints the markers.
 *                Hero profile only: a compact plot has no room for a lane and
 *                a marker drawn into 150px of chart would sit on the series.
 *                Sets the top padding, so passing `padding` alongside it is an
 *                error and throws.
```

and the code:

```js
    /*
     * The release lane. It reserves `LANE_CSS` above the plot through the
     * same `padding` the caller could pass itself, and installs its painter
     * as a `draw` hook, which uPlot fires after the axes and the series with
     * no clip region in force, so the painter can reach the reserved lane.
     *
     * Refused on a compact plot rather than silently ignored: a caller asking
     * for markers on a 150px card has made a mistake, and a card that quietly
     * drops half of what it declared is the failure this file's `bind` exists
     * to prevent, in another place.
     */
    var hooks = opts.hooks;
    if (opts.releases !== undefined) {
      if (opts.profile === "compact") {
        throw new Error("release markers need the hero profile");
      }
      /*
       * `releases` SETS the top padding, because reserving the lane is half of
       * what the option does. A caller passing both holds two ideas about one
       * number, so it throws rather than one of them silently winning: the
       * failure mode of a silent winner is a lane painted into room that was
       * never reserved, and no text observation of the page would show it.
       */
      if (opts.padding !== undefined) {
        throw new Error("releases sets the top padding, so padding cannot be passed with it");
      }
      config.padding = [LANE_CSS, null, null, null];
      var painter = releasePainter(opts.releases.groups, colour(RELEASE_TOKEN, RELEASE_FALLBACK));
      hooks = { draw: [painter] };
      if (opts.hooks !== undefined) {
        for (var key in opts.hooks) {
          if (!Object.prototype.hasOwnProperty.call(opts.hooks, key)) continue;
          if (key === "draw") hooks.draw = hooks.draw.concat(opts.hooks.draw);
          else hooks[key] = opts.hooks[key];
        }
      }
    }
    if (hooks !== undefined) config.hooks = hooks;
```

and delete the existing `if (opts.hooks !== undefined) config.hooks = opts.hooks;` line. The `opts.profile` reference is forward-looking and is `undefined` until Task 4, which is harmless: `undefined === "compact"` is false.

Export the new names:

```js
  window.INSIGHTS_CHARTS = {
    SYNC_KEY: SYNC_KEY,
    bind: bind,
    colour: colour,
    collectReleases: collectReleases,
    expand: expand,
    isolate: isolate,
    listGroups: listGroups,
    listOutside: listOutside,
    mount: mount,
    pixelRatio: pixelRatio,
    releaseCaption: releaseCaption,
    releaseLabel: releaseLabel,
    releaseNarrative: releaseNarrative,
    zeroBasedCounts: zeroBasedCounts
  };
```

- [ ] **Step 4: Switch the growth section to it**

In `chart-growth`, `buildChart` loses its `painter` argument and its `padding` and `hooks` settings, and gains the collected releases:

```js
  function buildChart(stack, spec, axis, offset, collected) {
    var card = el("div", "chart-card");
    card.appendChild(el("p", "chart-title", spec.title));
    card.appendChild(metaLine(axis, offset));
    stack.appendChild(card);

    if (axis.measured[offset] === 0) {
      card.appendChild(el("p", "chart-hint",
        "No " + spec.label.toLowerCase() + " measurement falls inside this span, so every step " +
        "of the axis would be a break. Nothing is drawn rather than an empty frame."));
      return null;
    }

    var host = el("div", "chart-scroll");
    /* In the document before uPlot is constructed: the plot is given an
     * explicit pixel size and that size is measured from this container. */
    card.appendChild(host);

    return C.mount(host, axis.xs, [{
      label: spec.label,
      stroke: C.colour(spec.token, spec.fallback),
      width: 2,
      values: axis.values[offset]
    }], {
      /* Not `zeroBasedCounts`: see fittedCounts. */
      yRange: fittedCounts,
      /* The lane, its padding reservation and its painter, all from the
       * toolkit. */
      releases: collected
    });
  }
```

In `render`, replace `var collected = collectReleases(...)` with `var collected = C.collectReleases(data.releases, axis.startMs, axis.endMs);`, `slot.appendChild(releaseLine(collected, total))` with `slot.appendChild(C.releaseCaption(collected, total))`, `releaseNarrative(collected, total, stepDays)` with `C.releaseNarrative(collected, total, stepDays)`, delete the `var painter = releasePainter(...)` line, and pass `collected` to `buildChart`. `singlePointNote` calls `listGroups` and `listOutside`; point both at `C.`.

`fittedCounts`, `axisNote`, `weeklyNote`, `metaLine`, `latestReading`, `readings`, `measuredPhrase`, `stepPhrase`, `singlePointNote`, `overrunNote` and `windowLine` stay in the growth section. They move in Task 7.

- [ ] **Step 5: Run the recipe and diff**

```bash
node scripts/metrics/fixtures/insights-fixture.mjs "$SP/fx" high
METRICS_DATA_DIR="$SP/fx/archive" METRICS_OUTPUT_PATH="$SP/fx/site/insights/data.json" \
  node scripts/metrics/src/cli-bundle.ts
node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console > "$SP/after-t2.txt"
diff "$SP/before-t2.txt" "$SP/after-t2.txt"
```

**What counts as a pass, and what counts as a failure:**

- The diff is empty apart from canvas digest values. The growth slot's caption line still reads `releases marked v1.1.2 (2026-08-11)`; if it now reads `none, no release falls inside the span drawn here`, `collectReleases` lost its span arguments in the move.
- Both growth cards still report `overTop` around 34. A drop to around 8 means the padding reservation did not survive: the lane is unpainted and the markers are drawn over the plot's top edge, which no text observation would show.
- `console messages: 1` (the planted probe and nothing else), `console capture proof: PASS`.
- Open the page in a browser (`python3 -m http.server 8765 --directory "$SP/fx/site"`) and confirm by eye that the dashed marker line and the `v1.1.2` label are drawn above both growth charts. This is the one thing in this task that only an eye can confirm; the `overTop` number proves the room was reserved, not that anything was drawn into it.

- [ ] **Step 6: Update `docs/systems/metrics.md` section 10.7**

In the paragraph beginning "`expand` in the chart toolkit lays a set of columns onto one evenly stepped axis", the sentence "Growth's stars and forks do, and they additionally *need* one axis, because one set of release markers is painted across both" is still true today and stops being true in Task 7. Leave it. Add one sentence to the end of section 10.7's first paragraph instead:

> The release-marker lane is an option of `mount` rather than a section's own drawing code: `settings.releases` takes the output of `collectReleases`, reserves the room above the plot and installs the painter, so any hero card can carry markers and there is one copy of the three rules that keep them honest.

- [ ] **Step 7: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "refactor(insights): make the release lane a chart toolkit option"
```

---

## Task 3: The method section, and the shared group styles

**Files:**
- Modify: `site/insights/index.html` (the `<style>` block, the page head markup, a new `#method` panel, the shell's `SLOT_IDS`, the at-a-glance IIFE, a new `method-coverage` IIFE)
- Modify: `docs/systems/metrics.md` section 10 opening and section 10.6

**Interfaces:**
- Consumes: `F.countMeasured`, `F.rowsLabel`, `F.recordsLabel`, `F.plural` (Task 1).
- Produces: the CSS classes `.lead-row`, `.lead-figure`, `.group-head`, `.hero-band`, `.series-band`, `.detail-band`, `.chart-card.is-compact`, `h3.chart-title`, `#method h3`, `.ch-txt4`; the `#method` panel with slot `method-coverage` and its five subheadings; `NOTE_SLOT_IDS` in the shell.

This task moves prose and draws no figure. Spec section 7.3 is the table it implements.

**A constraint on the harness contract, carried in from Task 1.** This is the task where a slot's notes become a checked thing: `NOTE_SLOT_IDS` decides which slots receive one, and Step 4's checks read them. The harness selects `.slot-note` at any depth and keeps only the nodes whose `closest(".chart-card")` is `null`.

That filter is load-bearing rather than incidental. Task 4 introduces the per-card failure note, which is a `.slot-note slot-note-error` element **inside** a `.chart-card`, and an unfiltered selection would report it as one of the slot's own notes. A slot with five working cards and one failed one would then read as a slot carrying a note, which is the shape of "the whole group failed", and every note check from here to Task 9 would be reading the wrong thing.

It is provably output-neutral across all eight fixture modes as the page stands today, which is precisely why somebody tidying the expression would delete it. Do not. Nothing in any task's pass list changes because of it.

- [ ] **Step 1: Add the group styles**

Append to the `<style>` block, after the `/* ================= Ranked dimensions ================= */` group and before the footer group:

```css
/* ================= Groups: lead figures, bands, card kinds ================= */
/*
 * Four groups, each with one hero chart and a band of smaller cards under it,
 * three of them with a band of detail cards as well. The hierarchy has to
 * survive a single column, so it is carried by four
 * things that do not depend on the grid: a hero plot is taller than any
 * compact one, a hero's primary line carries an area fill and no compact line
 * does, except Following's hero, which is a cumulative counter on a fitted
 * axis and so carries none, a hero card sits on --chat while a compact card sits on a lighter
 * recessive panel, and the group's lead figure is a large number directly
 * above the hero at every width.
 */
.lead-row {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
  margin-top: 30px;
}
.lead-figure {
  display: flex; flex-direction: column; gap: 5px;
  min-width: 0;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--chat);
  padding: 18px 20px 17px;
  color: var(--txt);
}
.lead-figure:hover { text-decoration: none; border-color: rgba(255, 255, 255, 0.14); }
.lead-figure .stat-value { font-size: clamp(2.2rem, 6vw, 3.2rem); }
.group-head { margin-bottom: 22px; }
.group-head .stat-value { font-size: clamp(1.6rem, 4.4vw, 2rem); }

.hero-band { display: grid; gap: 22px; }
/*
 * `auto-fill`, not `auto-fit`. Three of the four series bands hold exactly one
 * compact card: Reach's clones, Adoption's update checks, Delivery's
 * contributors. `auto-fit` collapses the empty tracks and stretches that
 * single card across the whole row, where it reads as a second hero.
 * `auto-fill` keeps the empty tracks, so a lone compact card stays the width
 * of one column and stays compact.
 *
 * `align-items: start` keeps a taller card, such as a dimension card carrying
 * a movement chart, from stretching its neighbours to match.
 */
.series-band {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 18px;
  align-items: start;
  margin-top: 22px;
}
.detail-band {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(420px, 1fr));
  gap: 22px;
  align-items: start;
  margin-top: 22px;
}
.series-band:empty, .detail-band:empty, .hero-band:empty { display: none; margin-top: 0; }

/* A compact card is deliberately lighter than a hero card, so the weighting
   survives at one column where the grid no longer carries it. */
.chart-card.is-compact { background: rgba(255, 255, 255, 0.02); padding: 16px 16px 14px; }
.chart-card.is-compact .chart-title { font-size: 0.92rem; color: var(--txt2); }
.chart-card.is-compact .stat-value { font-size: 1.35rem; font-weight: 620; }
.chart-card.is-compact .chart-meta { margin-bottom: 10px; }
/* Card titles are headings now, so a screen reader gets a real outline of the
   page. The styling is the one .chart-title always had. */
h3.chart-title { font-size: 1.05rem; font-weight: 600; letter-spacing: -0.018em; margin-bottom: 6px; }
.card-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.card-head .stat-delta { margin-top: 0; }

/* #method is not a figure group, so its channel label takes no accent. */
.ch-txt4::before { color: var(--txt4); }

/*
 * #method's own subheadings. They are not card titles, so they take neither
 * the .chart-title class nor its size. They exist because one h2 over nine
 * paragraphs is the bombardment moved rather than resolved, and because a
 * crawler reading the served HTML loses the association between a caveat and
 * the series it qualifies the moment every caveat sits under one generic
 * heading.
 */
#method h3 {
  font-size: 1rem;
  font-weight: 600;
  letter-spacing: -0.014em;
  color: var(--txt2);
  margin: 26px 0 8px;
}

@media (max-width: 560px) {
  .lead-row { grid-template-columns: minmax(0, 1fr); }
}
@media (min-width: 561px) and (max-width: 999px) {
  /* Two columns rather than four. Four figures across a 950px viewport leave
     under 220px each against a 3.2rem value, so the row goes two wide and two
     deep, and the values take the heading size to stop a two-row block pushing
     the range control off the first screen. */
  .lead-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .lead-figure .stat-value { font-size: clamp(1.6rem, 4.4vw, 2rem); }
}

/*
 * The design system asks for a solid fallback wherever a glass surface is
 * used, and this page has never had one. Its two glass surfaces are the nav
 * strip and the range pill; both fall back to --channel with no blur.
 */
@media (prefers-reduced-transparency: reduce) {
  .nav, .rangectl {
    background: var(--channel);
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
  }
}
```

- [ ] **Step 2: Add the `#method` panel and move the page-level prose into it**

Insert this panel after `#instances` and before `</main>`:

```html
  <section class="panel" id="method">
    <div class="wrap">
      <p class="ch-label ch-txt4">method</p>
      <h2>How these numbers are made</h2>
      <p class="sec-copy">
        Every number on this page comes from one archive: a scheduled job records the repository's
        traffic, stars, forks, contributors and releases once a day and commits them to a public
        data branch. The page reads a single bundle built from that archive at deploy time. Nothing
        is estimated, and nothing is fetched from anywhere but this site.
      </p>
      <h3>Provenance and coverage</h3>
      <p class="provenance">
        <span><span class="k">archive history</span> <span class="v" id="pv-since">checking</span></span>
        <span><span class="k">bundle built</span> <span class="v" id="pv-generated">checking</span></span>
        <span><span class="k">collector last ran</span> <span class="v" id="pv-lastrun">checking</span></span>
        <span><span class="k">last successful run</span> <span class="v" id="pv-lastsuccess">checking</span></span>
      </p>
      <div class="slot" id="method-coverage"></div>
      <p class="sec-copy raw-data">
        Prefer the numbers to the charts? The same archive is published as
        <a href="data/">plain tables</a> and as one machine-readable file,
        <a href="data.json"><code>data.json</code></a>. Both are built from this page's own bundle, so
        they cannot disagree with what is drawn here.
      </p>
    </div>
  </section>
```

`#method` ends up with five `h3` subheadings, in this order: **Traffic**, **Cumulative counts**, **Referrers and paths**, **Opt-in pings**, **Provenance and coverage**. Every paragraph that arrives in a later task lands under the one that names its subject, and each of those tasks inserts its own heading at its final position, above the Provenance block. This task creates only the last of the five, because it is the only one whose content exists yet: an empty heading waiting for a later commit is worse than no heading. The archive-collection paragraph sits directly under the `h2` with no heading of its own, because it qualifies the whole page rather than one subject.

In `.page-head`, replace the four-sentence `.lead` paragraph with the single sentence spec section 7.3 keeps at the top, and delete the `.provenance` block (it now lives in `#method`; there is exactly one copy and its four ids are unchanged, so `renderProvenance` needs no edit):

```html
    <p class="lead">Every number on this page was measured, not estimated.</p>
```

The `.raw-data` links and the `<noscript>` paragraph stay where they are, and the `.raw-data` paragraph is now repeated at the end of `#method`. `BUILD:SUMMARY` and `#status-region` do not move.

- [ ] **Step 3: Register the coverage line as its own section, and restrict the note subset**

In the shell, replace the `SLOT_IDS` line with:

```js
  var SLOT_IDS = ["header-stats", "chart-reach", "chart-growth", "ranked-referrers",
    "ranked-paths", "telemetry", "method-coverage"];

  /*
   * The subset that receives the unavailable/empty note.
   *
   * The same sentence printed in every slot is noise, and neither the method
   * coverage line nor (from Task 9) the lead figure row is a place a reader
   * looks for a figure: the coverage line is metadata about the archive, and
   * the status region above has already said what is wrong, once, in full.
   */
  var NOTE_SLOT_IDS = ["header-stats", "chart-reach", "chart-growth", "ranked-referrers",
    "ranked-paths", "telemetry"];
```

and `renderSlots` becomes:

```js
  function renderSlots(noteText) {
    for (var i = 0; i < SLOT_IDS.length; i++) {
      var slot = slotElement(SLOT_IDS[i]);
      if (slot === null) continue;
      clear(slot);
      if (noteText === null) continue;
      for (var n = 0; n < NOTE_SLOT_IDS.length; n++) {
        if (NOTE_SLOT_IDS[n] === SLOT_IDS[i]) {
          slot.appendChild(element("p", "slot-note", noteText));
          break;
        }
      }
    }
  }
```

Move `windowNote` and `COVERAGE` out of the at-a-glance IIFE into a new `<script>` block placed immediately after the at-a-glance block:

```html
<script>
/*
 * Section "method-coverage" -- the archive coverage line.
 *
 * It states how much of the selected range each series actually measured. It
 * sits in #method rather than beside a figure because it describes the
 * archive rather than any one group, and because every card already states
 * the same thing for its own series in its meta line. A reader who never
 * scrolls this far has not missed a number; what this line adds is saying in
 * one place what is otherwise spread across seven cards.
 *
 * It is also the only part of #method that reads the selected range, which is
 * why it is a registered section and not static markup.
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var F = window.INSIGHTS_FIGURES;

  /* ... COVERAGE, el, pair and windowNote, moved verbatim from the
     at-a-glance IIFE, with countMeasured/rowsLabel/recordsLabel/plural read
     off F ... */

  function render(slot, data, rangeKey) {
    slot.appendChild(windowNote(data, rangeKey, I.resolutionStepDays()));
  }

  I.registerSection("method-coverage", render);
})();
</script>
```

and remove the `slot.appendChild(windowNote(...))` line from the at-a-glance renderer.

- [ ] **Step 4: Run the recipe at `high` and `dimensions-only`**

**What counts as a pass, and what counts as a failure:**

- The report's `sections` block lists a `method` section with heading `How these numbers are made`, a `ch-label` of `method`, and a first `sec-copy` paragraph beginning `Every number on this page comes from one archive`. If the paragraph is missing, the move dropped it.
- The `page-head`'s `.lead` now reads exactly `Every number on this page was measured, not estimated.`
- The `method-coverage` slot's `windowNote` field carries the coverage line (at `high`: `all recorded history 2026-08-01 → 2026-09-09 · 40 days`, followed by six `label value` pairs for views, clones, stars, forks, contributors and repo snapshots). The `header-stats` slot's `windowNote` is now `null`. Both halves matter: a coverage line in neither slot means the move dropped it, and one in both means the old call was not removed.
- The report's range sweep prints a `method-coverage` column for each of the four ranges (Task 1 added it, and this is the commit where it stops being empty). The `30d` row and the `all` row must differ. If they do not, the section is not re-rendering on a range change. **This check depends on Task 1's sweep column**; without it the only way to see the difference is by hand in a browser, and it would not be in the report a reviewer reads.
- At `dimensions-only`, the `method-coverage` slot holds the coverage line reading `selected range no dated measurement to window`, and it holds **no** `slot-note`. It holds no note because the bundle is `ok`: `dimensions-only` yields `empty: false`, since the bundler counts dimension snapshots, so `renderSlots(null)` writes no note into any slot and this run proves only that the coverage line survives the null window. The proof that `NOTE_SLOT_IDS` is in force is the next bullet.
- Force the unavailable state by deleting `"$SP/fx/site/insights/data.json"` and re-running the check: the `#status-region` notice appears, the six note slots carry `No data to show — the archive is unavailable.` (the page's own em dash; a string that stays where it is keeps its punctuation, and the risk here is an implementer "fixing" the page instead of this line), and `method-coverage` is empty.
- The provenance strip renders its four values inside `#method` (`pv-since` reads `since 2026-08-01`, not the dash). A dash in all four means `renderProvenance` lost its elements in the move.
- `console messages: 1` (the planted probe and nothing else), `console capture proof: PASS`.
- Grep the file for the reduced-transparency block: `grep -c "prefers-reduced-transparency" site/insights/index.html` returns 1. Then confirm by eye with Chrome's rendering emulation that the nav goes solid; the grep proves the rule exists, not that it applies.

- [ ] **Step 5: Update `docs/systems/metrics.md`**

- Section 10 opening: "Five sections, each registered against a slot" becomes "Seven sections, each registered against a slot" and the list gains "**method coverage** (the archive coverage line, in `#method`)". Seven, not six: the doc's "Five" has always excluded the telemetry section, which is registered like the rest and is documented in section 10.8, so add it to the list here as well rather than carrying the undercount forward. This sentence is rewritten again in Tasks 4 to 9 as sections come and go; each task updates the count and the list to the truth at that commit.
- Section 10.6: add to the paragraph after the status table: "`renderSlots` writes its note into the figure slots only. The method coverage line is metadata about the archive rather than a figure, and the status region above it has already stated the problem in full, so repeating the sentence there would be noise."

- [ ] **Step 6: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "feat(insights): add the method section and the group styles"
```

---

## Task 4: The Delivery group

Spec sections 3.3, 4.1, 4.3, 5.2, 5.3, 12.1 and 12.2. **This task depends on two of the reversible calls in spec section 16: call 1 (CI activity moves from Reach to Delivery and becomes its hero) and call 2 (release markers move from the growth charts to the CI hero). If either is reversed, the Delivery hero becomes a different series and the lane moves back; the rest of this task stands.** Call 4 (Delivery's lead figure is "Releases shipped" rather than its hero's own series) governs Step 6.

**Files:**
- Modify: `site/insights/index.html` (the `INSIGHTS_CHARTS` IIFE, the `INSIGHTS_FIGURES` IIFE, a new `INSIGHTS_GROUPS` IIFE, a new `#delivery` panel, a new delivery section IIFE, the nav, `SLOT_IDS`)
- Modify: `scripts/metrics/fixtures/insights-fixture.mjs` (two new modes)
- Modify: `scripts/metrics/fixtures/insights-check.mjs` (the card capture reads every `.chart-meta`, see the note below)
- Modify: `docs/systems/metrics.md` sections 10 opening, 10.6 and 10.7

**Before Step 8, widen the card capture.** Task 1's `cardOf` reads `meta: text(card.querySelector(".chart-meta"))`, which is the *first* `.chart-meta` in the card. This task appends the release caption after the card's own meta line, so `querySelector` returns the span line and Step 8's assertion on the caption cannot pass as written. Task 2's reviewer proved the gap by mutation: replacing the caption's `"releases marked"` literal left the report byte-identical, so the harness cannot see that string at all today.

Change the capture to collect every `.chart-meta` in the card, keeping `meta` as the first for the existing readers and adding the full list beside it, and assert Step 8's caption against the list. In the same commit, add the two readings Task 3 needed and could not have: the `.lead` paragraph from `.page-head`, and the four `.provenance` values including `pv-since`. Task 3 proved both out of band, by grep and by a throwaway DOM dump, so the facts are known and only the report is missing them. Adding them here means Tasks 5 through 9 can assert the page head and the provenance strip from the report like everything else. Keep the `closest(".chart-card") === null` filter that separates slot-level notes from card-level ones; it is load-bearing, not incidental. Re-run the eight-mode A/B afterwards: the page must still be byte-identical, since widening a reading changes the report and not the page.

**Which canvas digest carries the proof.** The report prints a `before -> after` digest pair per chart, around the zoom drag. Only the **first** of each pair proves anything about the release lane: measured on this branch, neutering `releasePainter` moves both growth charts' first digests while leaving `overTop` at 34, but the post-drag digests are identical between a painted page and a neutered one, because the drag lands on a span that excludes the release day. Any task asserting that markers are painted must read the first digest of the pair. This is stronger than the earlier text, which said only an eye could confirm the markers.

**The one em-dash string, converted here.** `releaseCaption` in the toolkit prints `none — no release falls inside the span drawn here` when a span holds no release. Task 2 correctly kept that verbatim, because Task 2 changed no rendered output and a string that stays where it is keeps its punctuation. This task is where it renders in a second place, so the copy rule applies: it becomes `none, no release falls inside the span drawn here`. One occurrence, in the toolkit, and it changes the growth caption too, which is expected and is not a regression. After this change the only em dashes left in strings the page renders are the ones no task in this plan moves.

**Interfaces:**
- Consumes: `F.figure`, `F.chip`, `F.windows`, `F.plural` (Task 1); `C.collectReleases`, `C.releaseCaption`, `C.releaseNarrative`, `C.listOutside`, `mount`'s `releases` option (Task 2); the band and card CSS (Task 3).
- Produces, on `window.INSIGHTS_CHARTS`:

  ```
  C.fittedCounts(u, min, max)          -> [min, max]   the cumulative-counter y policy
  C.measuredPositions(axis, offset)    -> number       steps of that column carrying a value
  mount(host, xs, defs, { profile })   "hero" (default) | "compact"
  ```

  on `window.INSIGHTS_FIGURES`:

  ```
  F.releaseTrend(releases, wins)       -> a delta object
  F.renderFigure(fig, mode)            -> element; mode "card" | "heading"
  ```

  `figure`'s `spec.kind` gains `"releases"`, whose spec is `{ label, kind: "releases", anchor }`.

  and a new `window.INSIGHTS_GROUPS`:

  ```
  G.band(kind)                         -> element; kind "hero" | "series" | "detail"
  G.attach(slot, bands)                -> appends the bands that hold a card
  G.buildCardSafely(band, build)       -> the built value, or null after a contained throw
  G.chartCard(band, spec, ctx)         -> { card, axis, offsets, plot, releases }
  G.detailCard(band, title)            -> the .chart-card element
  G.groupHead(slot, figureSpec, ctx)   -> appends the group's lead figure in "heading" mode
  G.keep(created, built)               -> built, having pushed built.plot when there is one
  G.pair(key, value)                   -> a <span><span class="k">..</span> <span class="v">..</span></span>
  G.steps(count, stepDays)             -> "12 days" | "3 weekly buckets"
  ```

  `ctx` is `{ data, win, wins, step, downsampled }`. A `chartCard` spec is
  `{ profile, title, figure, columns, lines, yPolicy, breakPhrase, metaExtra, notes, caveat, releasesFor }`.
  `chartCard`'s `plot` is null whenever the card stated a reason instead of drawing one.

- [ ] **Step 1: Give `mount` a size profile**

In the `INSIGHTS_CHARTS` IIFE, replace `MIN_PLOT_WIDTH`, `WIDE_AT`, `HEIGHT_NARROW`, `HEIGHT_WIDE` and `daySpace` with a profile table:

```js
  /*
   * The two sizes a plot is drawn at.
   *
   * `minWidth` is the narrowest a plot may be drawn: below it the day axis
   * collapses into overlapping ticks, so a narrow viewport gets a full-width
   * plot that scrolls inside its own container rather than a squashed one
   * that fits. A hero needs 520 for that; a compact card, with its wider tick
   * spacing and its shorter axis, needs 240.
   *
   * 240 rather than 260, because 260 is not small enough. At or below 460px
   * the page padding is 16px a side and a compact card's own padding is 16px
   * a side, so the plot host is the viewport minus 64: a 320px phone leaves
   * 256px, which clears 240 and does not clear 260. 240 is also inside the
   * 268px a 300px grid column leaves after the card's padding, so the wide
   * case is unaffected. A compact card therefore does not scroll at any width
   * a phone presents, and the body never scrolls sideways at any width.
   *
   * `space` is the room left between day ticks. `dayTicks` widens its labels
   * from MM-DD to YYYY-MM-DD once the visible span crosses a calendar year,
   * and spacing sized for the short form leaves the long one overlapping its
   * neighbour, so both numbers are per profile.
   */
  var PROFILES = {
    hero: {
      minWidth: 520, height: 220, wideHeight: 280, wideAt: 700,
      space: 58, spaceWide: 96, width: 2
    },
    compact: {
      minWidth: 240, height: 150, wideHeight: 150, wideAt: 700,
      space: 96, spaceWide: 120, width: 1.5
    }
  };

  function profileOf(name) {
    return name === "compact" ? PROFILES.compact : PROFILES.hero;
  }

  function plotSize(host, profile) {
    var available = host.clientWidth;
    if (typeof available !== "number" || !isFinite(available) || available < 1) {
      available = profile.minWidth;
    }
    var width = Math.max(profile.minWidth, Math.round(available));
    return { width: width, height: width < profile.wideAt ? profile.height : profile.wideHeight };
  }

  function daySpaceFor(profile) {
    return function (u, axisIdx, scaleMin, scaleMax) {
      var first = new Date(scaleMin * 1000).getUTCFullYear();
      var last = new Date(scaleMax * 1000).getUTCFullYear();
      return first === last ? profile.space : profile.spaceWide;
    };
  }
```

The compact profile's `height` and `wideHeight` are both 150, so a compact plot is 150px tall at every width and the hero keeps its existing 220/280 split at the 700px host width it already uses.

`trackSize(u, host)` gains the profile: `function trackSize(u, host, profile)` and both `plotSize(host)` calls inside it become `plotSize(host, profile)`.

In `mount`:

```js
    var opts = settings || {};
    var profile = profileOf(opts.profile);
    var size = plotSize(host, profile);
```

the x axis becomes `axis({ incrs: DAY_INCRS, space: daySpaceFor(profile), values: dayTicks })`, the default series width becomes `typeof def.width === "number" ? def.width : profile.width`, and `detach = trackSize(plot, host)` becomes `detach = trackSize(plot, host, profile)`.

Add to `mount`'s documentation block, in the closed set:

```
 *   profile      "hero" (the default) or "compact". Decides the minimum plot
 *                width, the height, the tick spacing and the default stroke
 *                width. Every existing call site is unchanged by the default.
```

- [ ] **Step 2: Export the cumulative y policy and the measured-position count**

Move `fittedCounts` out of the growth IIFE into `INSIGHTS_CHARTS`, unchanged in body and with its whole comment block. Add beside it:

```js
  /*
   * How many steps of one column carry a value.
   *
   * Not `axis.xs.length`, which is how wide the axis is, and not
   * `axis.measured[offset]` alone at the call sites that need to reason about
   * whether a LINE can be drawn: uPlot handed a single point on a time scale
   * invents an x range of its own. Measured in a browser against this
   * archive, one point on 2026-09-01 produced an axis running to 2029-05-28,
   * one dot adrift on two and a half years nothing was ever recorded across.
   *
   * So a card with fewer than two of these states its reading instead of
   * drawing a line. A cumulative total read once is a reading, not a history:
   * it has no direction and no rate, and a line needs two points to have
   * either. `contributors` is the live case, not a hypothetical: it records a
   * row when its total changes, and the archive holds one.
   */
  function measuredPositions(axis, offset) {
    if (axis.empty) return 0;
    return axis.measured[offset];
  }
```

Export `fittedCounts` and `measuredPositions` from `INSIGHTS_CHARTS`, and change the growth section's `yRange: fittedCounts` to `yRange: C.fittedCounts`.

- [ ] **Step 3: Add `releaseTrend` and `renderFigure` to `INSIGHTS_FIGURES`**

```js
  /*
   * The release comparison: how many releases shipped in the last 30 days
   * against the 30 before them.
   *
   * `releases.csv` is reconstructed from `published_at`, a permanent
   * immutable timestamp, and the collector pages the release list in full on
   * every run, so the array holds every release this repository has ever
   * published however young the archive is. Unlike the daily series it needs
   * no coverage test: a release either happened on a date or it did not, and
   * the archive cannot have missed one by failing to run that day.
   *
   * It needs no REACH test either, and an earlier draft of this page had one:
   * it refused the comparison when the archive's own first measured day fell
   * inside the older window. That test was wrong. `archiveStartDay` is the
   * earliest date in any DATED SERIES, which the release list has nothing to
   * do with, so recreating the data branch would have made this chip print a
   * dash for sixty days with a reason that was false. Both window counts are
   * measured whenever the array is non-empty, and zero releases in a window
   * is a measured zero. The only thing the array cannot speak about is being
   * empty, and `releasesCard` below handles that.
   */
  function releaseTrend(releases, wins) {
    if (wins === null) {
      return unavailable("the archive holds no dated measurement to anchor a window to.");
    }
    var endMs = wins.flow.endMs;
    var recentStart = endMs - (I.DELTA_DAYS - 1) * I.DAY_MS;
    var priorEnd = endMs - I.DELTA_DAYS * I.DAY_MS;
    var priorStart = endMs - (2 * I.DELTA_DAYS - 1) * I.DAY_MS;
    var recent = 0;
    var prior = 0;
    for (var i = 0; i < releases.length; i++) {
      var ms = I.parseDay(releases[i].date);
      if (isNaN(ms)) continue;
      if (ms >= recentStart && ms <= endMs) recent++;
      else if (ms >= priorStart && ms <= priorEnd) prior++;
    }
    return {
      available: true,
      signed: true,
      value: recent - prior,
      windowDays: I.DELTA_DAYS,
      headline: "Change over the " + I.DELTA_DAYS + " days to " + I.formatDay(endMs),
      detail: recent + " " + plural(recent, "release", "releases") + " shipped in the " +
        I.DELTA_DAYS + " days to " + I.formatDay(endMs) + ", against " + prior + " in the " +
        I.DELTA_DAYS + " days before them."
    };
  }

  /*
   * The releases figure: a count of rows in an array rather than a reading of
   * a nullable column, which is the one place this page's null-versus-zero
   * rule needs stating in a different form.
   *
   * An empty `releases[]` is NOT a measured zero. The bundle produces the
   * same empty array whether the archive holds no releases or holds no
   * release file at all, so the two cannot be told apart from here, and "0
   * releases shipped" would be a claim the page cannot support. It prints the
   * dash and says what it does not know.
   */
  function releasesCard(data, wins) {
    var body = { valueText: DASH, unmeasured: true, sub: "The archive holds no release record." };
    var total = data.releases.length;
    if (total > 0) {
      var newest = null;
      for (var i = 0; i < total; i++) {
        var ms = I.parseDay(data.releases[i].date);
        if (isNaN(ms)) continue;
        if (newest === null || ms > newest.dayMs) newest = { dayMs: ms, release: data.releases[i] };
      }
      body.valueText = I.formatCount(total);
      body.unmeasured = false;
      body.sub = newest === null
        ? "No release in the archive carries a date this page can place on a calendar day."
        : "latest " + (newest.release.tag !== "" ? newest.release.tag : "untagged release") +
          " on " + I.formatDay(newest.dayMs);
    }
    body.delta = releaseTrend(data.releases, wins);
    return body;
  }
```

Add the `"releases"` branch at the top of `figure`:

```js
    if (spec.kind === "releases") {
      body = releasesCard(data, wins);
    } else if (spec.kind === "flow") {
```

and the renderer:

```js
  /*
   * One figure, presented. The same computed figure is rendered in as many
   * places as it is needed, and the two printings cannot disagree about a
   * value, a trend or a refusal reason, because there is only one of each.
   *
   *   "card"     the head of a compact chart card
   *   "heading"  the group's own headline, above its hero
   */
  function renderFigure(fig, mode) {
    var box = el("div", mode === "heading" ? "group-head" : "card-figure");
    if (mode === "heading") box.appendChild(el("p", "stat-label", fig.label));
    var head = el("div", "card-head");
    head.appendChild(el("p", "stat-value" + (fig.unmeasured ? " is-unmeasured" : ""),
      fig.valueText));
    head.appendChild(deltaChip(fig.delta));
    box.appendChild(head);
    box.appendChild(el("p", "stat-sub", fig.sub));
    if (fig.note !== null) box.appendChild(el("p", "stat-note", fig.note));
    return box;
  }
```

Export `releaseTrend` and `renderFigure`.

- [ ] **Step 4: Add the `INSIGHTS_GROUPS` surface**

A new `<script>` block after `INSIGHTS_CHARTS` and before the first chart section:

```html
<script>
/*
 * Shared group scaffolding: the three bands, the two chart card kinds, and
 * the per-card error containment.
 *
 * It exists because four groups draw the same two kinds of card, and four
 * copies of the compact-card builder is exactly the drift this file argues
 * against everywhere else: three of them would stay in step and the fourth
 * would quietly stop applying the one-point rule, or stop stating its span,
 * and nothing on the page would show it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PER-CARD ERROR CONTAINMENT
 *
 * Today a throw in the referrers renderer fails only the referrers slot. With
 * one slot per group, the same throw would take out a whole group, which is a
 * regression in blast radius: five working cards would disappear because a
 * sixth could not be built. So every card is built through `buildCardSafely`,
 * which replaces that one card with the page's existing failure note and
 * continues. A throw in a group renderer OUTSIDE any card is still contained
 * to that group's slot by the shell, exactly as today.
 * ─────────────────────────────────────────────────────────────────────────
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var F = window.INSIGHTS_FIGURES;
  var C = window.INSIGHTS_CHARTS;

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

  function band(kind) {
    return el("div", kind + "-band");
  }

  /* A band with no cards is not rendered at all, and leaves no gap. */
  function attach(slot, bands) {
    for (var i = 0; i < bands.length; i++) {
      if (bands[i].firstChild !== null) slot.appendChild(bands[i]);
    }
  }

  function buildCardSafely(target, build) {
    try {
      return build();
    } catch (error) {
      var note = el("p", "slot-note slot-note-error");
      note.appendChild(el("strong", null, "This card could not be rendered."));
      note.appendChild(document.createTextNode(
        " The rest of the page is unaffected, and the underlying data is unchanged: the fault " +
        "is in this page's code. Details are in the browser console."));
      target.appendChild(note);
      if (typeof console !== "undefined" && typeof console.error === "function") {
        console.error("insights: a card failed to build.", error);
      }
      return null;
    }
  }

  function steps(count, stepDays) {
    return count + " " + (stepDays === 1
      ? F.plural(count, "day", "days")
      : F.plural(count, "weekly bucket", "weekly buckets"));
  }

  /*
   * What this card actually drew: the span of its axis, and how much of it
   * carries a measurement. The unmeasured count is stated in the same breath
   * as what the page does with it, because a break in a line is the one thing
   * on this page a reader is most likely to read as a fall to zero, and the
   * right words for that differ by series: a traffic line's break is not a
   * zero, and a cumulative line's break is not a fall to zero.
   */
  function metaLine(axis, offsets, spec, win, stepDays) {
    var note = el("p", "chart-meta");
    var total = axis.xs.length;

    /* A card with no measured row has no span of its own to state: `expand`
     * found no first or last day for it, and printing the window as one would
     * claim an axis this card never drew. */
    if (total === 0) {
      note.appendChild(pair("window", I.formatDay(win.startMs) + " → " + I.formatDay(win.endMs)));
      note.appendChild(pair("measured", "nothing in this window"));
      return note;
    }

    var counted = axis.measured[offsets[spec.lines[0].column]];
    var missing = total - counted;
    note.appendChild(pair("span", I.formatDay(axis.startMs) + " → " + I.formatDay(axis.endMs)));
    note.appendChild(pair("measured", counted + " of " + steps(total, stepDays)));
    if (missing > 0) {
      note.appendChild(pair("unmeasured", steps(missing, stepDays) + ", " + spec.breakPhrase));
    }
    if (spec.metaExtra !== undefined) {
      var extra = spec.metaExtra(axis, offsets, stepDays);
      for (var i = 0; i < extra.length; i++) note.appendChild(extra[i]);
    }
    if (axis.offGrid > 0) {
      note.appendChild(pair("off-step",
        axis.offGrid + " " + F.plural(axis.offGrid, "row does", "rows do") +
        " not fall on the bundle's own resolution; " +
        F.plural(axis.offGrid, "it is", "they are") + " plotted where " +
        F.plural(axis.offGrid, "it is", "they are") + " dated"));
    }
    return note;
  }

  /*
   * A span so long it cannot be real is a fault in the ARCHIVE, and this page
   * must not report it as one of its own. The shell's generic failure note
   * says "the fault is in this page's code", which would send whoever reads
   * it to the wrong repository entirely.
   */
  function overrunNote(card, spec, axis) {
    var detail = "The " + spec.title + " series would run from " + I.formatDay(axis.startMs) +
      " to " + I.formatDay(axis.endMs) + ", which needs " + I.formatCount(axis.overrunSteps) +
      " points on the time axis, far longer than this archive can really cover. A date in the " +
      "archive itself is wrong. No chart is drawn, rather than one built around a date that " +
      "cannot be true.";
    if (typeof console !== "undefined" && typeof console.error === "function") {
      console.error("insights: " + spec.title + " declined to plot. " + detail);
    }
    var note = el("p", "slot-note slot-note-error");
    note.appendChild(el("strong", null, "This chart cannot be drawn from this archive."));
    note.appendChild(document.createTextNode(" " + detail));
    card.appendChild(note);
  }

  /*
   * One chart card, hero or compact.
   *
   * `spec` is:
   *   profile      "hero" | "compact"
   *   title        the <h3>
   *   figure       a figure spec for the card head, or null
   *   columns      { <name>: { series, field } }, as `bind` takes
   *   lines        [{ column, label, token, fallback, fill?, dash?, width? }]
   *   yPolicy      "zero" | "fitted"
   *   breakPhrase  what an unmeasured step is, in this series' own words
   *   metaExtra    optional (axis, offsets, stepDays) -> [pair, ...]
   *   notes        [string], rendered as .chart-hint under the plot
   *   caveat       optional node appended to the card head
   *   releasesFor  optional (axis) -> the collected releases for a hero lane
   *
   * `releasesFor` is a callback rather than a value because the span the
   * releases are sorted against has to be the span this card actually drew,
   * and that is only known once `expand` has run. Handing the caller's own
   * window in instead would let a release inside the range but outside the
   * drawn axis be reported as marked while nothing was painted for it.
   *
   * Returns `{ card, axis, offsets, plot, releases }`. `plot` is null when the
   * card states a reason instead of drawing one, and `releases` is whatever
   * `releasesFor` returned, so the caller can caption the lane from the same
   * object the painter was given rather than from a second collection that
   * could disagree with it.
   */
  function chartCard(target, spec, ctx) {
    var card = el("div", "chart-card" + (spec.profile === "compact" ? " is-compact" : ""));
    card.appendChild(el("h3", "chart-title", spec.title));
    if (spec.figure !== null && spec.figure !== undefined) {
      card.appendChild(F.renderFigure(F.figure(spec.figure, ctx.data, ctx.wins), "card"));
    }
    if (spec.caveat !== undefined && spec.caveat !== null) card.appendChild(spec.caveat);
    target.appendChild(card);

    var bound = C.bind(spec.title, ctx.data, [{ title: spec.title, columns: spec.columns }]);
    var own = C.isolate(bound, bound.cards[0]);
    var axis = C.expand(own.columns, ctx.win, ctx.step);

    /* Before the `empty` branch: an overrun sets `empty` too, as a fail-safe
     * for a caller that forgets this check, and the specific reason is the
     * more useful of the two. */
    if (axis.overrun) {
      overrunNote(card, spec, axis);
      return { card: card, axis: axis, offsets: own.offsets, plot: null, releases: null };
    }

    card.appendChild(metaLine(axis, own.offsets, spec, ctx.win, ctx.step));

    /* Collected here, against the span this card drew, so the caption the
     * caller builds and the markers the painter draws are sorted by the same
     * rule. An empty axis has no span to sort against, so the two branches
     * below return a null collection and the caller says the archive holds
     * releases the chart could not place. */
    var releases = spec.releasesFor === undefined || axis.empty
      ? null
      : spec.releasesFor(axis);

    var primary = own.offsets[spec.lines[0].column];
    var positions = C.measuredPositions(axis, primary);
    if (positions === 0) {
      card.appendChild(el("p", "slot-note",
        "No measurement of " + spec.lines[0].label.toLowerCase() + " falls inside this window, " +
        "so there is no line to draw. An empty frame would look like a failure rather than an " +
        "absence."));
      appendNotes(card, spec);
      return { card: card, axis: axis, offsets: own.offsets, plot: null, releases: releases };
    }
    if (positions < 2) {
      card.appendChild(el("p", "slot-note",
        "One measurement is not a history. This series carries a value at exactly one step " +
        "inside this window, and a line needs two points to have a direction or a rate. Drawn " +
        "anyway it would be a single dot on an axis the plotting library stretches years past " +
        "the last day anything was recorded, a span this archive never measured. The reading " +
        "is stated above."));
      appendNotes(card, spec);
      return { card: card, axis: axis, offsets: own.offsets, plot: null, releases: releases };
    }

    var host = el("div", "chart-scroll");
    card.appendChild(host);
    appendNotes(card, spec);

    var defs = [];
    for (var i = 0; i < spec.lines.length; i++) {
      var line = spec.lines[i];
      var def = {
        label: line.label,
        stroke: C.colour(line.token, line.fallback),
        values: axis.values[own.offsets[line.column]]
      };
      if (line.fill !== undefined) def.fill = line.fill;
      if (line.dash !== undefined) def.dash = line.dash;
      if (line.width !== undefined) def.width = line.width;
      defs.push(def);
    }

    var settings = {
      profile: spec.profile,
      yRange: spec.yPolicy === "fitted" ? C.fittedCounts : C.zeroBasedCounts
    };
    if (releases !== null) settings.releases = releases;
    return {
      card: card,
      axis: axis,
      offsets: own.offsets,
      plot: C.mount(host, axis.xs, defs, settings),
      releases: releases
    };
  }

  function appendNotes(card, spec) {
    if (spec.notes === undefined) return;
    for (var i = 0; i < spec.notes.length; i++) {
      card.appendChild(el("p", "chart-hint", spec.notes[i]));
    }
  }

  /*
   * Push a card's plot onto the caller's live list, if it built one, and hand
   * the card back so the caller can caption it.
   *
   * A card that stated a reason instead of drawing has no instance to
   * release, and a card whose build threw has already been replaced by its
   * failure note and returned null. Both are ordinary, so both are handled
   * here rather than at four call sites that could each forget one.
   */
  function keep(created, built) {
    if (built !== null && built !== undefined &&
      built.plot !== null && built.plot !== undefined) {
      created.push(built.plot);
    }
    return built;
  }

  function detailCard(target, title) {
    var card = el("div", "chart-card");
    card.appendChild(el("h3", "chart-title", title));
    target.appendChild(card);
    return card;
  }

  function groupHead(slot, figureSpec, ctx) {
    slot.appendChild(F.renderFigure(F.figure(figureSpec, ctx.data, ctx.wins), "heading"));
  }

  window.INSIGHTS_GROUPS = {
    attach: attach,
    band: band,
    buildCardSafely: buildCardSafely,
    chartCard: chartCard,
    detailCard: detailCard,
    groupHead: groupHead,
    keep: keep,
    pair: pair,
    steps: steps
  };
})();
</script>
```

Note the deliberate reuse of `C.bind` per card: `bind` throws a named error when a card declares a series the bundle does not carry, and `buildCardSafely` turns that into one failed card rather than a failed group.

- [ ] **Step 5: Add the `#delivery` panel and the nav link**

After `#instances` and before `#method`:

```html
  <section class="panel" id="delivery">
    <div class="wrap">
      <p class="ch-label ch-rose">delivery</p>
      <h2>Delivery</h2>
      <p class="sec-copy">
        Workflow runs measure this project's own automation, not the quality of what it ships.
      </p>
      <div class="slot" id="delivery-body"></div>
    </div>
  </section>
```

Add `<a class="nav-link" href="#delivery">Delivery</a>` after the `#instances` link, and `"delivery-body"` to both `SLOT_IDS` and `NOTE_SLOT_IDS`.

- [ ] **Step 6: Write the delivery section**

A new `<script>` block at the end of the body:

```html
<script>
/*
 * Group "delivery" -- is it being maintained.
 *
 * Hero: CI activity, the daily workflow-run count, with the release markers
 * painted on it. Workflow runs are the only series in this group with a daily
 * shape, and annotating them with the releases that shipped is the direct
 * answer to the group's question.
 *
 * Moving the markers here is also the arrangement most likely to draw them at
 * all. The lane needs a release inside the chart's span, and this series is
 * reconstructed from the Actions API back to the first release, where the
 * star history begins on the day the collector first ran. On the live archive
 * the markers do not draw on the growth charts at all.
 *
 * The group's lead figure is Releases shipped rather than the hero's own
 * series, which is the one place this page's rule is not uniform. The hero is
 * annotated with the releases that figure counts, so the two are the same
 * subject, but it is worth knowing that they are not the same series.
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var F = window.INSIGHTS_FIGURES;
  var C = window.INSIGHTS_CHARTS;
  var G = window.INSIGHTS_GROUPS;

  var LEAD = { label: "Releases shipped", kind: "releases" };

  /* Every live uPlot instance this group owns. Assigned only once a render
   * has completed; a render that throws destroys what it built itself. */
  var live = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /*
   * The CI card's standing note, verbatim from the reach section it comes
   * from, with the sentence about sitting below the clone chart replaced by
   * one that names where the clone chart now is. The two are in different
   * groups and the page-wide cursor is what joins them, which never depended
   * on adjacency: it syncs on scale values rather than pixels.
   */
  function ciNote() {
    return "A zero here sits on the axis rather than breaking the line, unlike the traffic " +
      "charts in Reach. The Actions API is asked for a date range and answers it completely, " +
      "so a day with no runs is a measurement; the traffic endpoints omit a day they recorded " +
      "nothing for, so an absent day there is genuinely unmeasured. A break in this line means " +
      "the collector did not run, or ran before this series existed. That same difference is " +
      "why this chart's span reaches further back than the traffic charts: each chart is drawn " +
      "across its own measured days, so peaks cannot be compared by their position across " +
      "charts. Hovering lands on the same day in every chart whose span covers it, and " +
      "dragging sideways across one puts them all on the same span.";
  }

  /* A link back to the clone chart, which this series is the explanation for.
   * The clone line counts this repository's own checkouts, and the two are
   * now in different groups, so each names the other. */
  function cloneLink() {
    var note = el("p", "chart-hint");
    note.appendChild(document.createTextNode(
      "GitHub counts every actions/checkout this repository runs as a clone, so this count is " +
      "most of the shape of the "));
    var link = el("a", null, "repository clones chart in Reach");
    link.href = "#reach";
    note.appendChild(link);
    note.appendChild(document.createTextNode(
      ". The two are plotted separately and never combined: no fixed number of clones follows " +
      "from a run, and subtracting an estimate would put a model on a page whose whole claim " +
      "is that every figure on it was measured."));
    return note;
  }

  /*
   * A weekly bundle keys each bucket on the Monday that opens its week and
   * sums the week's runs into it, while a release marker is dated exactly. So
   * a marker lands inside the bucket that covers its week rather than at a
   * point of its own.
   *
   * Deliberately NOT the growth section's wording, which says a point
   * "carries the last value measured in that week". That is true of a
   * cumulative total and false of a summed count, and moving it here would
   * publish a false sentence on a page whose whole claim is that it does not.
   */
  function weeklyNote() {
    return "This bundle is bucketed by week. A point is dated on the Monday that opens its " +
      "week and carries that whole week's runs, while a release marker is dated exactly, so a " +
      "marker sits somewhere inside the bucket that covers it rather than on a point of its " +
      "own.";
  }

  /* A factory rather than a constant, because the lane needs the bundle's own
   * release list and the spec is built once per render. */
  function heroSpec(data) {
    return {
      profile: "hero",
      title: "CI activity",
      figure: null,
      columns: { runs: { series: "workflows", field: "runs" } },
      lines: [{
        column: "runs", label: "Workflow runs",
        token: "--rose", fallback: "#fda4af",
        fill: "rgba(253, 164, 175, 0.10)", width: 2
      }],
      yPolicy: "zero",
      breakPhrase: "drawn as breaks, not zeros",
      notes: [ciNote()],
      /*
       * Sorted against the span this card actually drew, which `chartCard`
       * hands in once `expand` has run.
       *
       * That span is deliberately not the range the control asked for. A
       * release outside the days the CI series was measured on cannot be
       * marked, the axis is never stretched back to reach it, and the caption
       * below says which release was left off and on what grounds. A
       * centrepiece that silently draws nothing looks broken; one that says
       * what it left out does not.
       */
      releasesFor: function (axis) {
        return C.collectReleases(data.releases, axis.startMs, axis.endMs);
      }
    };
  }

  var CONTRIBUTORS = {
    profile: "compact",
    title: "Contributors",
    figure: { label: "Contributors", kind: "step", series: "contributors", field: "total" },
    columns: { total: { series: "contributors", field: "total" } },
    /* --sky, not --peach. --peach #fca5a5 and this group's hero --rose #fda4af
     * are three hex digits apart and this card sits directly under that hero,
     * so a reader glancing down the group would read one series drawn twice.
     * --sky repeats a colour used in Reach and in Adoption, which is a repeat
     * across groups and allowed, and it separates the two Delivery cards. */
    lines: [{ column: "total", label: "Contributors", token: "--sky", fallback: "#7dd3fc" }],
    yPolicy: "fitted",
    breakPhrase: "drawn as breaks, not as a fall to zero",
    notes: [
      "This series records a row when its total changes rather than sampling daily, so the " +
      "total holds between rows and the caption above says when it last changed rather than " +
      "when it was last read.",
      "The vertical axis is fitted to the values drawn rather than pinned to a zero baseline, " +
      "so a move of one contributor is visible rather than flattened. Read the height of the " +
      "line against its own axis labels, not against the bottom of the frame."
    ]
  };

  /*
   * Every release the archive holds, newest first, as text.
   *
   * The lane can only mark the releases that fall inside the span the CI
   * series was measured on. This card is the rest of the answer: the same
   * rows the lane draws from, stated so a release the axis could not reach is
   * still on the page rather than only in the caption that says it was left
   * off.
   */
  function releaseList(band, data) {
    var card = G.detailCard(band, "Releases");
    var total = data.releases.length;
    if (total === 0) {
      card.appendChild(el("p", "slot-note",
        "The archive holds no release record, so there is nothing to list. Entries appear here " +
        "as soon as the collector records one."));
      return;
    }
    var rows = [];
    var unreadable = 0;
    var i;
    for (i = 0; i < total; i++) {
      var ms = I.parseDay(data.releases[i].date);
      if (isNaN(ms)) {
        unreadable++;
        continue;
      }
      rows.push({ dayMs: ms, release: data.releases[i] });
    }
    rows.sort(function (a, b) { return b.dayMs - a.dayMs; });

    var list = el("div", "ranked");
    for (i = 0; i < rows.length; i++) {
      var row = el("div", "rank-row");
      row.appendChild(el("p", "rank-n", String(i + 1)));
      var body = el("div", "rank-body");
      var head = el("div", "rank-head");
      var name = el("p", "rank-name", C.releaseLabel(rows[i].release));
      name.title = C.releaseLabel(rows[i].release);
      head.appendChild(name);
      head.appendChild(el("p", "rank-num", I.formatDay(rows[i].dayMs)));
      body.appendChild(head);
      if (rows[i].release.name !== "" && rows[i].release.name !== rows[i].release.tag) {
        var sub = el("p", "rank-sub", rows[i].release.name);
        sub.title = rows[i].release.name;
        body.appendChild(sub);
      }
      row.appendChild(body);
      list.appendChild(row);
    }
    card.appendChild(list);
    if (unreadable > 0) {
      card.appendChild(el("p", "chart-hint chart-caution", unreadable + " " +
        F.plural(unreadable, "release", "releases") + " " +
        F.plural(unreadable, "carries", "carry") +
        " a date this page cannot place on a calendar day, so " +
        F.plural(unreadable, "it is", "they are") + " not listed above."));
    }
  }

  function render(slot, data, rangeKey) {
    var ctx = {
      data: data,
      win: I.rangeWindow(data, rangeKey),
      wins: F.windows(data),
      step: I.resolutionStepDays(),
      downsampled: data.downsampled
    };

    G.groupHead(slot, LEAD, ctx);

    var detail = G.band("detail");
    G.buildCardSafely(detail, function () { releaseList(detail, data); });

    /* Reachable on a non-empty bundle: one holding only releases or only
     * dimension snapshots has no dated series row to anchor a window to. The
     * release list needs no window and still renders. */
    if (ctx.win === null) {
      slot.appendChild(el("p", "slot-note",
        "The archive holds no dated measurement, so there is no time axis to draw the CI or " +
        "contributor charts on, and no axis for a release to be marked against."));
      G.attach(slot, [detail]);
      return;
    }

    var hero = G.band("hero");
    var series = G.band("series");
    var created = [];
    try {
      var spec = heroSpec(data);
      var built = G.keep(created, G.buildCardSafely(hero, function () {
        return G.chartCard(hero, spec, ctx);
      }));
      /* The lane's own caption: what was marked, what fell outside the drawn
       * span, and any release carrying a date this page cannot read. Built
       * from the same collection the painter was handed, so the two cannot
       * describe different sets of releases. */
      if (built !== null && built.releases !== null) {
        built.card.appendChild(C.releaseCaption(built.releases, data.releases.length));
        var narrative = C.releaseNarrative(built.releases, data.releases.length, ctx.step);
        if (narrative !== null) built.card.appendChild(el("p", "chart-hint", narrative));
        if (data.downsampled) {
          built.card.appendChild(el("p", "chart-hint chart-caution", weeklyNote()));
        }
        built.card.appendChild(cloneLink());
      } else if (built !== null) {
        /* No axis to sort against, so no marker can be placed. The card has
         * already said why it drew nothing; this says what that cost. */
        built.card.appendChild(el("p", "chart-hint", data.releases.length === 0
          ? "No release is recorded in the archive, so there is nothing to mark on the time axis."
          : "No release is marked, because this card drew no axis for a marker to sit on. Every " +
            "release the archive holds is listed below."));
        built.card.appendChild(cloneLink());
      }

      G.keep(created, G.buildCardSafely(series, function () {
        return G.chartCard(series, CONTRIBUTORS, ctx);
      }));
    } catch (error) {
      /* `live` is assigned only once every card is built, so a throw part-way
       * leaves `created` referenced by nothing but this frame. Destroy what
       * was built here, then let the shell render its failure note. */
      for (var j = 0; j < created.length; j++) {
        try {
          created[j].destroy();
        } catch (cleanupError) {
          if (typeof console !== "undefined" && typeof console.error === "function") {
            console.error("insights: releasing a delivery chart after a failed render also failed.",
              cleanupError);
          }
        }
      }
      throw error;
    }
    G.attach(slot, [hero, series, detail]);
    live = created;
  }

  /*
   * Runs before the slot is emptied. Removing the nodes alone would leave
   * every instance's window listeners, its resize observer and its membership
   * of the page's cursor-sync group alive.
   *
   * `live` is cleared first so a destroy that throws cannot leave a
   * half-destroyed instance behind to be destroyed twice; the first failure
   * is re-thrown once the rest have been released.
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

  I.registerSection("delivery-body", render, teardown);
})();
</script>
```

The lane is collected against **the drawn axis**, which is what the code above does and what `chartCard`'s `releasesFor` contract requires: the span the releases are sorted against has to be the span this card actually drew, or a release inside the range but outside the axis would be reported as marked while nothing was painted for it. Give the `collectReleases` call this comment:

```js
      /* Collected against the span this card drew, which chartCard hands in
       * once `expand` has run, rather than against the window the range
       * control asked for. The two differ whenever the CI series is younger
       * than the window, and reporting a release as marked when no marker was
       * painted for it is the one thing this caption must not do.
       *
       * The painter separately declines anything outside the live scale, so a
       * drag can leave the canvas with no marker while the caption still names
       * every release it listed. Double-clicking restores the full span and
       * every marker with it. */
```

- [ ] **Step 7: Add the `long` and `no-releases` fixture modes**

Two states this task's verification needs and no mode produces: an archive long enough for the release trend to be stated rather than refused (the 40-day archive cannot reach back 60 days, so every 30-against-30 comparison on it refuses), and an archive holding no release at all.

In `insights-fixture.mjs`, add `'long'` and `'no-releases'` to `MODES`, document them in the header comment:

```
 *   long         ninety days of traffic and four releases at different
 *                distances, two of them inside the last thirty days and one
 *                in the thirty before, so the thirty-against-thirty
 *                comparisons have both windows inside the archive and state a
 *                signed figure that only the right arithmetic produces
 *   no-releases  as `high`, with no releases.csv at all
```

change `const DAYS = 40;` to `const DAYS = mode === 'long' ? 90 : 40;`, and replace the releases write with:

```js
  /*
   * `long` writes four: TWO inside the last thirty days, one inside the thirty
   * before them, and one before the archive begins.
   *
   * Two and one, not one and one. With one in each window the trend is zero,
   * and zero is also what a swapped window, an off-by-one at either boundary
   * and a double-counted release all produce, so the fixture would state a
   * figure that proves nothing. Two against one gives +1, which only the
   * correct arithmetic produces. The release before the archive begins is
   * there so the caption has one to report as outside the drawn span.
   */
  if (mode === 'long') {
    s.writeCsv('releases.csv', ['date', 'tag', 'name'], [
      { date: new Date(Date.UTC(2026, 6, 1)).toISOString().slice(0, 10), tag: 'v1.0.0', name: '1.0.0' },
      { date: day(DAYS - 45), tag: 'v1.1.0', name: '1.1.0' },
      { date: day(DAYS - 10), tag: 'v1.1.2', name: '1.1.2' },
      { date: day(DAYS - 4), tag: 'v1.1.3', name: '1.1.3' },
    ]);
  } else if (mode !== 'no-releases') {
    s.writeCsv('releases.csv', ['date', 'tag', 'name'], [{ date: day(10), tag: 'v1.1.2', name: '1.1.2' }]);
  }
```

- [ ] **Step 8: Run the recipe at `long`, `no-releases`, `high` and `dimensions-only`**

**What counts as a pass, and what counts as a failure:**

At `long`:

- The `delivery-body` slot has one `figures` entry (the group head) with `label: "Releases shipped"`, `value: "4"`, `sub` beginning `latest v1.1.3 on`, and a `chip` reading `+1 · 30d` with a `chipTitle` containing `2 releases shipped in the 30 days to` and `against 1 in the 30 days before them`. Two in the recent window against one in the prior window is the only arrangement that produces `+1` here; a `0` means a boundary or a window is wrong, and the dash means `releaseTrend` refused a comparison the archive can make.
- The slot holds three `cards`: `CI activity` (`compact: false`), `Contributors` (`compact: true`) and `Releases`.
- `CI activity` reports `plot.canvasHeight` of 280 and `plot.overTop` of 34 or more. `canvasHeight` is the height the profile asked for; `overHeight` is the plot area, which is the canvas minus the reserved top padding and minus the x-axis strip, so it reads about 216 here and asserting 280 on it fails for the wrong reason. `canvasHeight` 150 means the hero took the compact profile; `overTop` under 34 means the release lane reserved no room.
- `Contributors` reports **no plot** and a `note` beginning `One measurement is not a history.` The fixture writes one contributors row, so this is the one-point rule firing. A plot here means the rule is not applied and the axis runs to 2029.
- The `Releases` card lists four rows, newest first: rank 1 is `v1.1.3`, rank 4 is `v1.0.0`. The card's rows carry no `.rank-fill`, so the report's `width` and `fill` fields are `null` for every one of them. A crashed report here rather than a `null` means Task 1's rank-row guard was undone.
- The `CI activity` card's `metas` list contains `releases marked v1.1.0 (2026-09-15)` and `outside this span v1.0.0 (2026-07-01)`, and one of its `hints` begins `1 release recorded in the archive falls outside the span drawn here`. Assert against the list rather than `meta`, which holds the card's own span line and not the caption. Three releases fall inside the CI span, so the marked list may be truncated by `MAX_LISTED`; assert the first group and the outside group rather than all three names.
- The old `chart-reach` slot still holds its own `CI activity` card. Compare the two cards' `meta` `span` and `measured` values: they must be identical. A difference means the group renderer expanded a different set of columns than the section it is duplicating.

At `no-releases`:

- The group head's `value` is the dash glyph with `unmeasured: true` and `sub: "The archive holds no release record."` A `0` here is the null-versus-zero rule failing on the one figure derived from an array length.
- The `Releases` card holds the note `The archive holds no release record, so there is nothing to list.`
- The `CI activity` card still draws its plot, and its `meta` contains `releases none recorded in the archive`.

At `high` (40 days, one release):

- The single release is dated `day(10)`, which is `2026-08-11`, and the recent window opens at `archiveEndDay - 29 days`, which is also `2026-08-11`. So the group head's chip reads `+1 · 30d` with a `chipTitle` containing `1 release shipped in the 30 days to 2026-09-09, against 0 in the 30 days before them`. This is the deliberate boundary case: the recent window is inclusive at its opening day, and a strict comparison at that edge would print `0` here. A 40-day archive states this comparison rather than refusing it, which is the point of dropping the reach test.

At `dimensions-only`:

- The `delivery-body` slot holds the note `The archive holds no dated measurement, so there is no time axis to draw the CI or contributor charts on, and no axis for a release to be marked against.`, plus a `Releases` card. The release card renders without a window; a slot holding only the note means `G.attach` was called before the detail band was filled.
- This is the one mode where the release trend refuses. The group head's chip reads the dash glyph with a `chipTitle` containing `the archive holds no dated measurement to anchor a window to`. It is now the only refusal path `releaseTrend` has, which is why it is asserted here rather than left implicit.

On every run: `console messages: 1` (the planted probe and nothing else), `failed or 4xx/5xx requests: 0`, `console capture proof: PASS`. Then resize the browser window from 1440px to 380px and confirm the CI hero scrolls inside its own container below about 570px while the Contributors card never does, and that the body never scrolls sideways at any width.

- [ ] **Step 9: Update `docs/systems/metrics.md`**

- Section 10 opening: the count becomes "Eight sections" and the list gains "**delivery** (CI activity with the release markers, contributors, and a dated list of every release)". Say that Delivery's CI card is the same series the reach section draws and that the duplication is temporary; delete that clause in Task 6.
- Section 10.6: add the per-card state introduced here, after the paragraph about a chart card with no measured step: "A card whose series carries exactly one measured step also states its reading instead of drawing: uPlot handed a single point on a time scale invents an x range of its own, measured here as an axis running two and a half years past the last recorded day. `contributors` is the live case rather than a hypothetical, because it records a row when its total changes and the archive holds one."
- Section 10.7: add "The release lane sits on the Delivery hero rather than on the growth charts. The lane needs a release inside the chart's span, and the CI series is reconstructed from the Actions API back to the first release where the star history begins on the day the collector first ran, so on the current archive the markers draw here and would not draw there."
- Section 11: add `long` and `no-releases` to the state list and to the mode table, with one line each on what they are for.

- [ ] **Step 10: Commit**

```bash
git add site/insights/index.html scripts/metrics/fixtures/insights-fixture.mjs docs/systems/metrics.md
git commit -m "feat(insights): add the delivery group"
```

---

## Task 5: The Adoption group

Spec sections 3.2, 4.1, 5.3, 6.4 and 8.2. **This task depends on spec section 16's call 3: Adoption's hero is App downloads and stays App downloads even after telemetry clears the threshold. If that is reversed, the hero and the detail band swap places and the rest of this task stands.** It also implements decision 4 of this plan (fill implies a zero-based axis).

**Files:**
- Modify: `site/insights/index.html` (a new `#adoption` panel, the telemetry IIFE retargeted, the `#instances` panel deleted, the nav, `SLOT_IDS`)
- Modify: `docs/systems/metrics.md` sections 10 opening and 10.8

**Interfaces:**
- Consumes: everything Task 4 produced.
- Produces: the `adoption-body` slot; the telemetry rendering as a band builder rather than a section.

- [ ] **Step 1: Add the `#adoption` panel, delete `#instances`, fix the nav**

Insert before `#delivery`:

```html
  <section class="panel" id="adoption">
    <div class="wrap">
      <p class="ch-label ch-mint">adoption</p>
      <h2>Adoption</h2>
      <p class="sec-copy">
        Downloads count files fetched from the release page rather than installs anyone kept, and
        the opt-in figures below are a floor: an instance that never switched the ping on is
        invisible here.
      </p>
      <div class="slot" id="adoption-body"></div>
    </div>
  </section>
```

Delete the whole `#instances` panel. Move its two paragraphs into `#method`, after the first paragraph, verbatim except that the second paragraph loses the sentence spec section 7.2 makes the Adoption caption ("A self-hosted instance can choose to send one small ping a day, and most do not, so **every figure here is a lower bound** rather than a total." stays in `#method`; the caption above is the spec's own wording and is not a copy of it). The em dashes in those paragraphs are replaced with the punctuation the sentences need.

In the nav, replace `<a class="nav-link" href="#instances">Instances</a>` with `<a class="nav-link" href="#adoption">Adoption</a>`. In `SLOT_IDS` and `NOTE_SLOT_IDS`, replace `"telemetry"` with `"adoption-body"`.

- [ ] **Step 2: Turn the telemetry section into the Adoption group**

The telemetry IIFE keeps everything it has: `THRESHOLD`, `CARDS`, `RANKINGS`, `NEUTRAL`, `telemetryOf`, `stateNote`, `cardHost`, `columnsFor`, `chartMeta`, `releaseAll`, `buildCard`, `snapshotDay`, `rankedRow`, `buildRanking`, `latestDay`, `belowThresholdNote`, and the gate. Six things change.

Three of the six are small and easy to lose:

- **The IIFE declares only `var I` and `var C`** (`index.html:5894-5895`). The new `render` calls `F.windows`, `G.groupHead`, `G.band`, `G.keep`, `G.buildCardSafely`, `G.chartCard` and `G.attach`, and under `"use strict"` each of those is a `ReferenceError`. Add `var F = window.INSIGHTS_FIGURES;` and `var G = window.INSIGHTS_GROUPS;` beside them.
- **`cardHost` builds `el("p", "chart-title", title)`** (`index.html:6032`). Change that one `p` to an `h3`. Spec section 10 makes every card title a heading so a screen reader gets a real outline, and `G.detailCard` and `G.chartCard` both emit `h3`, so leaving this one would give five of the page's twelve cards no heading element at all. The `h3.chart-title` rule Task 3 adds already carries the styling and `* { margin: 0 }` means no reset is needed. The harness records `titleTag`, so Step 3 asserts it.
- **The band no longer appends its own `.chart-window` line.** `#method`'s coverage line states the selected range once for the page (spec section 2), and each card's meta line states the span it drew. Delete the line and whatever builds it; nothing else reads it.

The header comment gains a paragraph:

```
 * It is now the detail band of the Adoption group rather than a section of
 * its own. The group always has a hero and a compact card whatever telemetry
 * does, so the threshold's state note is an empty state INSIDE a band and
 * never a group-shaped hole in the page. The gate itself, its three wordings
 * and the rule that the figures are public in the plain tables from the first
 * archived ping are unchanged.
```

The two Adoption chart cards are added above the telemetry band:

```js
  var LEAD = {
    label: "App downloads", kind: "point", series: "repo", field: "downloads_app"
  };

  /*
   * The hero: installers and archives only, never the updater feed.
   *
   * It is drawn on a zero baseline and carries an area fill, and those two go
   * together: a fill reads as area under the curve measured from zero, so a
   * card that fits its axis to the values must not carry one. This is a count
   * of files fetched with a true floor at zero, so the fill is honest here
   * where it would not be on the star chart.
   *
   * Rows the archive recorded before the download split are null and break
   * the line, as they do on the at-a-glance card today.
   */
  var HERO = {
    profile: "hero",
    title: "App downloads",
    figure: null,
    columns: { downloads: { series: "repo", field: "downloads_app" } },
    lines: [{
      column: "downloads", label: "App downloads",
      token: "--mint", fallback: "#86efac",
      fill: "rgba(134, 239, 172, 0.10)", width: 2
    }],
    yPolicy: "zero",
    breakPhrase: "drawn as breaks, not as a fall to zero",
    notes: [
      "Installers and archives only. GitHub counts an electron-updater feed file and a " +
      "blockmap in the same download counter as an installer, and every installed client " +
      "fetches the feed on every update check, so a combined total is dominated by polling. " +
      "The two are counted separately here and in the card beside this one.",
      "A row the archive recorded before the two were counted separately carries no value for " +
      "either, so the line breaks across it rather than falling to zero."
    ]
  };

  var UPDATES = {
    profile: "compact",
    title: "Update checks",
    figure: { label: "Update checks", kind: "point", series: "repo", field: "downloads_updates" },
    columns: { updates: { series: "repo", field: "downloads_updates" } },
    lines: [{ column: "updates", label: "Update checks", token: "--sky", fallback: "#7dd3fc" }],
    yPolicy: "zero",
    breakPhrase: "drawn as breaks, not as a fall to zero",
    notes: [
      "This counts update polling rather than installs: an electron-updater feed file and a " +
      "blockmap, fetched by every installed client on every update check."
    ]
  };
```

`render` becomes:

```js
  function render(slot, data, rangeKey) {
    var ctx = {
      data: data,
      win: I.rangeWindow(data, rangeKey),
      wins: F.windows(data),
      step: I.resolutionStepDays(),
      downsampled: data.downsampled
    };

    G.groupHead(slot, LEAD, ctx);

    var hero = G.band("hero");
    var series = G.band("series");
    var detail = G.band("detail");
    var created = [];

    try {
      if (ctx.win !== null) {
        G.keep(created, G.buildCardSafely(hero, function () {
          return G.chartCard(hero, HERO, ctx);
        }));
        G.keep(created, G.buildCardSafely(series, function () {
          return G.chartCard(series, UPDATES, ctx);
        }));
      }
      /* The telemetry band, whatever the two cards above did. It is the only
       * part of this group that can be absent from the bundle entirely. */
      created = created.concat(buildTelemetryBand(detail, data, ctx));
    } catch (error) {
      releaseAll(created);
      throw error;
    }

    if (ctx.win === null) {
      slot.appendChild(el("p", "slot-note",
        "The archive holds no dated measurement, so there is no time axis to draw the download " +
        "charts on."));
    }
    G.attach(slot, [hero, series, detail]);
    live = created;
  }
```

`buildTelemetryBand(band, data, ctx)` is the old `render` body with three edits: it appends into `band` rather than `slot`, it takes its window from `ctx.win` rather than calling `rangeWindow` again, and it returns the plots it created rather than assigning `live`. Its gate line is copied character for character:

```js
    var cleared = block !== null && typeof block.instances7d === "number" &&
      block.instances7d >= THRESHOLD;
    if (!cleared) {
      band.appendChild(belowThresholdNote(block));
      return [];
    }
```

Each of the two telemetry chart cards and the three rankings is wrapped in `G.buildCardSafely` so a throw in one ranking does not take the group down.

Finally, register against the new slot: `I.registerSection("adoption-body", render, teardown);`.

- [ ] **Step 3: Run the recipe at every telemetry mode**

Run at `high`, `threshold`, `low`, `none`, `high-nodims`, `high-other`, `sparse`, `dimensions-only`, and once more at `high` followed by the `--strip-telemetry` pass.

**What counts as a pass, and what counts as a failure:**

- At `high`, the `adoption-body` slot holds: one `figures` entry labelled `App downloads` with `value: "79"` and a `chip` of `+30 · 30d`; an `App downloads` hero card with `plot.canvasHeight` 280 and a legend of one entry; an `Update checks` compact card with `plot.canvasHeight` 150; then `Instances reporting`, `Active users on reporting instances`, `Server versions`, `Countries` and `Client kinds`. Seven cards, in that order. Fewer means a card was lost when the section became a band.

  The chip is `+30`, not `+39`. The fixture writes `downloads_app: 40 + i` over 40 days from `2026-08-01`, so `archiveEndDay` is `day(39)` and the point window opens at `day(9)`, where the value is 49: `pointDelta` returns `79 - 49 = 30`. `+39` would mean the window opened at `day(0)`.
- Every one of the seven cards reports `titleTag: "H3"`. Five of them come from `cardHost`, which built a `<p>` before this task.
- The `App downloads` figure printed in the group head equals the `App downloads` figure on the at-a-glance card in `header-stats`, value, sub-line and chip text alike. They come from one `pointCard` call each; a difference means `figure` is dispatching on the wrong kind.
- At `threshold`, the two telemetry chart cards are drawn (the gate reads exactly 10 and passes). At `low`, they are absent and the band holds a `slot-note-detail` containing `4 instances reported inside the seven days ending` and `Charts appear here once that count reaches 10`. At `none`, the note contains `No instance has reported yet`. After `--strip-telemetry`, it contains `built from a bundle made before the instance pings were collected`. Four distinct wordings; any two collapsing into one is a failure.
- At every below-threshold mode the `App downloads` hero and the `Update checks` card still render. A group-shaped hole where the hero should be is the failure this arrangement exists to prevent.
- At `dimensions-only`, the slot holds the no-time-axis note and the telemetry band's own state note, and no chart card.
- The report's range sweep still shows `rankings identical to the first range` for all four ranges. The rankings are a snapshot, not a window, and a range that moved them means the band is reading the range where it should not.
- `console messages: 1` (the planted probe and nothing else) and `console capture proof: PASS` on every run.

- [ ] **Step 4: Update `docs/systems/metrics.md`**

- Section 10 opening: the count stays at "Eight sections". The list loses the **telemetry** entry Task 3 added to it and gains "**adoption** (app downloads, update checks, and the opt-in fleet figures behind their threshold)". There is no "instances" entry in that list to remove: the opening list is at a glance, reach, growth, referrers, paths, plus what Tasks 3 and 4 added, and the telemetry section is documented in section 10.8 rather than named there. The swap is telemetry out, adoption in.
- Section 10.8: retitle the paragraph "The sixth section, slot `telemetry`" to "The Adoption group's detail band, in slot `adoption-body`". Keep every sentence about the gate, the three wordings, the `SERIES_NAMES` exclusion, the absence of `bind`, the per-card expansion and the rankings exactly as they are. Add: "The group always has a hero and a compact card whatever telemetry does, so the state note is an empty state inside a band rather than a group-shaped hole in the page."

- [ ] **Step 5: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "feat(insights): add the adoption group"
```

---

## Task 6: Reach, part one: the traffic cards

Spec sections 3.1, 4.1, 4.3, 5.3 and 7.3. This task also lands spec section 16's call 1 in full: the old reach section is deleted here, and with it the second copy of the CI activity chart. It lands spec section 16's call 9 as well: it builds the page's first two flow chips, so `flowTrend` and the `30d total` meta pair arrive with them.

**Files:**
- Modify: `site/insights/index.html` (the `#reach` panel rewritten, a new reach section IIFE, the old `chart-reach` IIFE deleted, `SLOT_IDS`)
- Modify: `docs/systems/metrics.md` sections 3.1, 4.5, 10 opening and 10.7

**Interfaces:**
- Consumes: everything Tasks 4 and 5 produced.
- Produces: the `reach-body` slot and the reach group renderer, which Task 8 extends with its detail band. On `window.INSIGHTS_FIGURES`:

  ```
  F.flowDelta(spec, data, win, step)  -> the existing one-window total, newly exported
                                         because a flow card's meta line prints it
  ```

  `flowTrend(series, field, wins, step)` is added in the same block and is deliberately **not** exported: `figure` is its only caller, and nothing outside it consumes the arithmetic.

- [ ] **Step 1: Rewrite the `#reach` panel**

```html
  <section class="panel" id="reach">
    <div class="wrap">
      <p class="ch-label ch-sky">reach</p>
      <h2>Reach</h2>
      <p class="sec-copy">
        Views count page loads on GitHub rather than people, and a break in a line is a day nobody
        measured rather than a day with no traffic.
      </p>
      <div class="slot" id="reach-body"></div>
    </div>
  </section>
```

Move both of the panel's existing paragraphs into `#method`, after the paragraph moved there in Task 5, verbatim except for the em dash replacements and except for the one sentence spec section 7.3 keeps on the clones card:

> GitHub counts this repository's own `actions/checkout` steps as clones, so this line measures the build pipeline as well as the audience.

That sentence becomes the clones card's standing caveat, with a link to `#delivery`.

In `SLOT_IDS` and `NOTE_SLOT_IDS`, replace `"chart-reach"` with `"reach-body"`.

- [ ] **Step 2: Add `flowTrend` to `INSIGHTS_FIGURES`, then write the reach section**

First the arithmetic, because the section below is its first consumer. In the `INSIGHTS_FIGURES` IIFE:

```js
  /*
   * The flow comparison: this 30 days against the 30 before them.
   *
   * `flowDelta` totals ONE window and refuses when it is not covered end to
   * end. This compares two, and each has to pass that same test on its own
   * measured rows, at the bundle's own step. A comparison against a window
   * that is missing days is short by an unknown amount in the direction
   * nobody can see.
   *
   * The two windows are inclusive and adjacent and never overlap:
   *   recent = [E - 29d, E]     prior = [E - 59d, E - 30d]
   *
   * On a downsampled bundle this inherits the problem `flowDelta` already
   * documents: a whole-week bucket cannot be split at the edge of a 30-day
   * window. Each window is labelled with the span its buckets actually stand
   * for, and if the two spans differ the comparison is refused rather than
   * made across unequal widths, because a difference between a 28-day total
   * and a 35-day one is not a change in anything.
   */
  function windowTotal(series, field, startMs, endMs, step) {
    var days = [];
    var sum = 0;
    for (var i = 0; i < series.dates.length; i++) {
      var ms = I.parseDay(series.dates[i]);
      if (isNaN(ms) || ms < startMs || ms > endMs) continue;
      if (series[field][i] === null) continue;
      days.push(ms);
      sum += series[field][i];
    }
    if (days.length === 0) return { ok: false, gap: null };
    days.sort(function (a, b) { return a - b; });
    var gap = coverageGap(days, { startMs: startMs, endMs: endMs }, step);
    if (gap !== null) return { ok: false, gap: gap };
    var spanEnd = days[days.length - 1] + (step - 1) * I.DAY_MS;
    return {
      ok: true, sum: sum, rows: days.length,
      spanDays: I.dayGap(spanEnd, days[0]) + 1
    };
  }

  function flowTrend(series, field, wins, step) {
    if (wins === null) {
      return unavailable("the archive holds no dated measurement to anchor a window to.");
    }
    if (oldestMeasured(series, field) === null) {
      return unavailable("this metric has never been measured, so there is nothing to total.");
    }
    var endMs = wins.flow.endMs;
    var recent = windowTotal(series, field, endMs - (I.DELTA_DAYS - 1) * I.DAY_MS, endMs, step);
    if (!recent.ok) {
      return unavailable(recent.gap === null
        ? "no day inside the last " + I.DELTA_DAYS + " days carries a measurement."
        : recent.gap);
    }
    var prior = windowTotal(series, field, endMs - (2 * I.DELTA_DAYS - 1) * I.DAY_MS,
      endMs - I.DELTA_DAYS * I.DAY_MS, step);
    if (!prior.ok) {
      return unavailable("the " + I.DELTA_DAYS + " days before this window are not measured end " +
        "to end, so there is nothing to compare this total with.");
    }
    if (recent.spanDays !== prior.spanDays) {
      return unavailable("this bundle is bucketed by week, and the buckets that fall inside the " +
        "two windows stand for " + recent.spanDays + " days and " + prior.spanDays +
        " days. A difference between two totals of unequal width is not a change in anything.");
    }
    return {
      available: true,
      signed: true,
      value: recent.sum - prior.sum,
      windowDays: recent.spanDays,
      headline: recent.spanDays === I.DELTA_DAYS
        ? "Change over the " + I.DELTA_DAYS + " days to " + I.formatDay(endMs)
        : "Change over " + recent.spanDays + " days" + I.resolutionSuffix(),
      detail: I.formatCount(recent.sum) + " over " + rowsLabel(recent.rows, step) +
        ", against " + I.formatCount(prior.sum) + " over " + rowsLabel(prior.rows, step) +
        " in the " + recent.spanDays + " days before them."
    };
  }
```

A flow spec gains a `trend` flag so `figure` knows which of the two to use:

```js
    if (spec.kind === "flow") {
      body = flowCard(spec, data, wins === null ? null : wins.flow, step);
      /* Every flow chip on the page prints a signed change (spec section 4.3),
       * so both of this page's flow specs set the flag. The flag exists rather
       * than the branch being unconditional because `flowCard` is also what
       * the at-a-glance grid calls, and that grid keeps its one-window chips
       * until Task 9 deletes it. */
      if (spec.trend === "compare") {
        body.delta = flowTrend(data.series[spec.series], spec.field, wins, step);
      }
    }
```

Export `flowDelta` from `INSIGHTS_FIGURES`, beside the names already there. It is needed by the meta line below. **Do not export `flowTrend`:** `figure` is its only caller.

Then the section itself. A new `<script>` block, placed where the old `chart-reach` block was:

```html
<script>
/*
 * Group "reach" -- who is finding this.
 *
 * Hero: page views, with unique visitors as the second dashed line. Views is
 * the direct answer to the group's question, it is the widest funnel the
 * archive measures, and it is the one traffic series the CI clone confound
 * does not touch: a checkout loads no page.
 *
 * Stars, forks and watchers are NOT here. They are people who chose to follow
 * the repository rather than people finding it, which is a different question,
 * and they have a group of their own: see #following. Task 8 adds the two
 * ranked dimension cards to the detail band this file already builds.
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var F = window.INSIGHTS_FIGURES;
  var C = window.INSIGHTS_CHARTS;
  var G = window.INSIGHTS_GROUPS;

  var LEAD = {
    label: "Page views", kind: "flow", series: "views", field: "count", trend: "compare"
  };

  var live = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /*
   * `downsampled` is wholesale: when it is true every range is weekly. A
   * weekly bucket's `uniques` is the sum of its days' uniques, and a visitor
   * who came back on three days is three daily uniques and one person, so the
   * weekly figure over-counts and is an upper bound rather than a count of
   * people. It is not recoverable from daily data, so the only honest move is
   * to label it, and the label travels on the series itself where a reader
   * hovering the line will see it.
   */
  function uniquesLabel(label, downsampled) {
    return downsampled ? label + " (weekly sum, upper bound)" : label;
  }

  /*
   * A traffic card's own meta pairs, on top of the shared ones.
   *
   * The uniques count first, and only when the two columns disagree, which is
   * the case worth naming: the count was recorded and the unique figure was
   * not, or the reverse.
   *
   * Then the 30-day window total. It is here because the chip above no longer
   * carries it. Every flow chip on this page prints a signed change, so that a
   * lead figure's chip and a card head's chip in the same idiom cannot mean
   * two different quantities, and the one-window total the chip used to print
   * is a figure this page prints today. It keeps a place rather than
   * disappearing, and this is the honest place for it: a mono meta line beside
   * the span and the measured-step count, where a card's other measured facts
   * already are.
   *
   * `flowDelta` is the page's existing one-window total, unchanged and called
   * exactly as `flowCard` calls it, so this pair and the at-a-glance chip
   * cannot disagree about the number while both are on the page. It refuses
   * unless the window is covered end to end, and it labels itself with the
   * span its rows actually stand for when the bundle is weekly, which is why
   * the key is built from `windowDays` rather than hard-coded to 30. A refused
   * total is not printed at all: it is not a figure, and the chip beside it
   * already says the window is not covered.
   */
  function trafficMeta(seriesName, field, countColumn, uniquesColumn, ctx) {
    return function (axis, offsets, stepDays) {
      var out = [];
      var counted = axis.measured[offsets[countColumn]];
      var uniqueCounted = axis.measured[offsets[uniquesColumn]];
      if (uniqueCounted !== counted) {
        out.push(G.pair("uniques measured",
          uniqueCounted + " of " + G.steps(axis.xs.length, stepDays)));
      }
      var total = F.flowDelta({ series: seriesName, field: field }, ctx.data,
        ctx.wins === null ? null : ctx.wins.flow, ctx.step);
      if (total.available) {
        out.push(G.pair(total.windowDays + "d total", I.formatCount(total.value)));
      }
      return out;
    };
  }

  function weeklyUniquesNote(label) {
    return "This bundle is bucketed by week. A bucket's unique figure is the sum of its days' " +
      "unique counts, so someone who came back on several days is counted more than once: read " +
      "the " + label.toLowerCase() + " line as an upper bound rather than a count of people.";
  }

  function heroSpec(ctx) {
    return {
      profile: "hero",
      title: "Page views",
      figure: null,
      columns: {
        count: { series: "views", field: "count" },
        uniques: { series: "views", field: "uniques" }
      },
      lines: [
        {
          column: "count", label: "Views", token: "--sky", fallback: "#7dd3fc",
          fill: "rgba(125, 211, 252, 0.10)", width: 2
        },
        {
          column: "uniques", label: uniquesLabel("Unique visitors", ctx.downsampled),
          token: "--lavender", fallback: "#c4b5fd", width: 1.5, dash: [5, 4]
        }
      ],
      yPolicy: "zero",
      breakPhrase: "drawn as breaks, not zeros",
      metaExtra: trafficMeta("views", "count", "count", "uniques", ctx),
      notes: ctx.downsampled ? [weeklyUniquesNote("Unique visitors")] : []
    };
  }

  /* The clone line's own caveat, and the link to the chart that explains most
   * of its shape. The two series sit in different groups now, so each names
   * the other; the page-wide cursor never depended on their adjacency,
   * because it syncs on scale values rather than on pixels. */
  function cloneCaveat() {
    var note = el("p", "stat-note");
    note.appendChild(document.createTextNode(
      "GitHub counts this repository's own actions/checkout steps as clones, so this line " +
      "measures the build pipeline as well as the audience. The "));
    var link = el("a", null, "CI activity chart in Delivery");
    link.href = "#delivery";
    note.appendChild(link);
    note.appendChild(document.createTextNode(
      " is this repository's own workflow-run count, so the overlap can be read directly " +
      "rather than taken on trust."));
    return note;
  }

  function clonesSpec(ctx) {
    return {
      profile: "compact",
      title: "Repository clones",
      figure: {
        label: "Clones", kind: "flow", series: "clones", field: "count",
        note: "includes this repo's own CI checkouts"
      },
      columns: {
        count: { series: "clones", field: "count" },
        uniques: { series: "clones", field: "uniques" }
      },
      lines: [
        { column: "count", label: "Clones", token: "--mint", fallback: "#86efac" },
        {
          column: "uniques", label: uniquesLabel("Unique cloners", ctx.downsampled),
          token: "--amber", fallback: "#fcd34d", dash: [5, 4]
        }
      ],
      yPolicy: "zero",
      breakPhrase: "drawn as breaks, not zeros",
      metaExtra: trafficMeta("clones", "count", "count", "uniques", ctx),
      caveat: cloneCaveat(),
      notes: ctx.downsampled ? [weeklyUniquesNote("Unique cloners")] : []
    };
  }

  /*
   * No window line. The old reach section printed one at the top of its slot
   * and so did growth and telemetry, which is the same sentence three times on
   * a page whose stated problem is too much text. #method's coverage line
   * states the selected range and the dates it resolves to once for the whole
   * page, and each card's own meta line states the span it actually drew,
   * which is the number that differs from card to card. Nothing is lost: the
   * range that was asked for is stated beside the control that asks for it.
   */
  function render(slot, data, rangeKey) {
    var ctx = {
      data: data,
      win: I.rangeWindow(data, rangeKey),
      wins: F.windows(data),
      step: I.resolutionStepDays(),
      downsampled: data.downsampled
    };

    G.groupHead(slot, LEAD, ctx);

    var hero = G.band("hero");
    var series = G.band("series");
    var detail = G.band("detail");

    if (ctx.win === null) {
      slot.appendChild(el("p", "slot-note",
        "The archive holds no dated measurement, so there is no time axis to draw these charts " +
        "on."));
      G.attach(slot, [detail]);
      return;
    }

    var created = [];
    try {
      G.keep(created, G.buildCardSafely(hero, function () {
        return G.chartCard(hero, heroSpec(ctx), ctx);
      }));
      G.keep(created, G.buildCardSafely(series, function () {
        return G.chartCard(series, clonesSpec(ctx), ctx);
      }));
    } catch (error) {
      for (var j = 0; j < created.length; j++) {
        try {
          created[j].destroy();
        } catch (cleanupError) {
          if (typeof console !== "undefined" && typeof console.error === "function") {
            console.error("insights: releasing a reach chart after a failed render also failed.",
              cleanupError);
          }
        }
      }
      throw error;
    }
    G.attach(slot, [hero, series, detail]);
    live = created;
  }

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

  I.registerSection("reach-body", render, teardown);
})();
</script>
```

Delete the old `chart-reach` IIFE in full, including its `CHARTS` array, `metaLine`, `buildEmptyCard`, `buildChart`, `overrunNote`, `windowLine` and `uniquesLabel`. The CI card's note text has already been carried to Delivery in Task 4; check that nothing else in the deleted block is referenced anywhere else before removing it.

- [ ] **Step 3: Run the recipe at `long`, `high` and `dimensions-only`**

**What counts as a pass, and what counts as a failure:**

- The `reach-body` slot holds a group head labelled `Page views` whose `value` equals the `Views` value on the at-a-glance card in `header-stats`. They come from one `flowCard` call each. At `long` the value is the sum of `40 + i` over 90 days; the check is that the two printings agree, not the arithmetic.
- The group head's **chip does not** match the at-a-glance card's, and that is the point of this task's chip change. At `long` the head reads `+900 · 30d` (views `40 + i`: `day(60)` to `day(89)` totals 3,435 against 2,535 for `day(30)` to `day(59)`) while the at-a-glance Views chip reads the one-window total `3,435 · 30d`. At `high` the head reads the dash glyph with a `chipTitle` containing `the 30 days before this window are not measured end to end`, because a 40-day archive cannot cover the prior window, while the at-a-glance chip still reads its one-window total. Both paths, on two modes.
- **The `30d total` pair proves the total did not vanish.** At `high` the `Page views` card's `meta` contains `30d total 1,935` and that string is character for character the number in the at-a-glance Views chip; the `Repository clones` card's `meta` contains `30d total 885` against the at-a-glance Clones chip. Compare the pairs to the chips in the same report. This is the check that the constraint "no figure printed today stops being printed" is met, and it is only checkable while the at-a-glance grid is still on the page, which is until Task 9.
- The slot holds two cards: `Page views` with `compact: false`, `plot.canvasHeight` 280 and a two-entry legend, and `Repository clones` with `compact: true`, `plot.canvasHeight` 150 and a two-entry legend. Assert `canvasHeight`, not `overHeight`: `overHeight` is the plot area, the canvas minus the top padding and the x-axis strip, so it reads about 216 and 112 here. A compact card reporting a `canvasHeight` of 220 or 280 means the profile did not reach `plotSize`.
- **No slot on the page holds a `.chart-window` line any more except the ones the sections still to be dismantled render.** The `reach-body` slot's `window` field is `null`. It becomes `null` for every slot once Tasks 7 and 8 land, at which point the report's per-range `window` column is empty by design and the `method-coverage` column is what carries the per-range evidence.
- The `Repository clones` card's `figure.note` reads `includes this repo's own CI checkouts` and the card carries a `stat-note` containing `GitHub counts this repository's own actions/checkout steps as clones`. The link in it points at `#delivery`; click it in the browser and confirm the Delivery panel's heading lands clear of the sticky bar.
- **No slot on the page holds a `CI activity` card except `delivery-body`.** The report lists every slot; grep it. Two of them means the old section was not deleted.
- The `chart-reach` slot is gone from the report entirely.
- `#method` now carries the archive paragraph directly under its `h2`, then a **Traffic** `h3` with this task's two reach paragraphs, then the **Opt-in pings** `h3` with Task 5's two telemetry paragraphs, then **Provenance and coverage**. Insert the Traffic heading above Opt-in pings, which is its final position. Read the paragraphs in the browser and check against spec section 7.3's table that no sentence was dropped in the move and that the clones sentence appears on the card rather than in `#method`.
- At `dimensions-only`, the slot holds the no-time-axis note and no card.
- `console messages: 1` (the planted probe and nothing else), `console capture proof: PASS`.

- [ ] **Step 4: Update `docs/systems/metrics.md`**

- Section 3.1, the clones caveat: the sentence naming where the CI confound is disclosed now names the Reach clones card and `#method` rather than the reach section copy.
- Section 4.5: "Both series are plotted as separate stacked charts" becomes "The two are plotted in different groups, clones in Reach and workflow runs in Delivery, joined by the page-wide cursor and by a link in each direction." The rule that they are never combined into one corrected figure is unchanged and stays stated.
- Section 10 opening: the count stays at "Eight sections". The list loses "reach (views, clones, and this repository's own CI activity)" and gains "**reach** (page views as the hero, repository clones beside it; the ranked dimension cards arrive in Task 8)". Delete the temporary clause about the duplicated CI card added in Task 4.
- Section 10.7: the Reach paragraph explaining why Reach isolates each card is still true and still the rule. Rewrite its first sentence to say the isolation now happens per card inside a group rather than per card inside a section, and note that the CI series that motivated it has moved to Delivery while the rule it forced stays.

- [ ] **Step 5: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "feat(insights): move the traffic charts into the reach group"
```

---

## Task 7: The Following group

Spec sections 3.2, 4.1, 5.3, 6.4 and 9. **This task depends on four of the reversible calls in spec section 16: call 2 (the release markers move off the growth charts, so stars and forks no longer need one axis), call 5 (Watchers gains a compact plot), call 7 (Stars is Following's hero and is the one hero on the page with no area fill) and call 8 (the lead figure row carries four figures, and Following's is Stars). If call 7 is reversed the hero changes series; if call 8 is reversed this group's head disappears and the rest of the task stands.**

This is the fourth group. It exists because Reach was answering two questions: page views, clones, referring sites and popular paths are traffic, people finding the project, while stars, forks and watchers are people who clicked a button to keep track of it. The two were together only because the dissolved growth section had nowhere else to go, and left together Reach would hold seven of the page's twelve cards while being the first group a reader meets.

**Files:**
- Modify: `site/insights/index.html` (a new `#following` panel, a new following section IIFE, the `#growth` panel and the `chart-growth` IIFE deleted, the nav, `SLOT_IDS`)
- Modify: `docs/systems/metrics.md` sections 10 opening and 10.7

**Interfaces:**
- Consumes: everything Tasks 4, 5 and 6 produced, and `C.fittedCounts` and `C.measuredPositions` (Task 4) in particular.
- Produces: the `following-body` slot.

- [ ] **Step 1: Add the `#following` panel, the nav link and the slot**

Insert between `#reach` and `#adoption`, so the page reads Reach, Following, Adoption, Delivery: one funnel from the outside in, a visitor finds the repository, some of them mark it, fewer run the software, and the last question is whether what they ran is still being worked on.

```html
  <section class="panel" id="following">
    <div class="wrap">
      <p class="ch-label ch-amber">following</p>
      <h2>Following</h2>
      <p class="sec-copy">
        Stars, forks and watchers count people who clicked a button on GitHub rather than people
        running the software, and each is a running total that this archive can only see from the
        day it started recording.
      </p>
      <div class="slot" id="following-body"></div>
    </div>
  </section>
```

Add `<a class="nav-link" href="#following">Following</a>` after the `#reach` link, and `"following-body"` to both `SLOT_IDS` and `NOTE_SLOT_IDS`.

The page declares one `.ch-*` rule per accent it uses. If there is no `.ch-amber`, add `.ch-amber::before { color: var(--amber); }` beside the others, so this group's channel label takes its hero's colour the way the other three do. Four groups, four distinct label accents: sky, amber, mint, rose.

- [ ] **Step 2: Write the following section**

A new `<script>` block placed where the old `chart-growth` block was, so it runs after the reach block and before the dimension block.

```html
<script>
/*
 * Group "following" -- who chose to follow it.
 *
 * Hero: stars. Of the three series here it is the one that actually moves.
 * Forks and watchers change a handful of times a year on this repository,
 * while the star count is the number a reader goes to a repository page to
 * look for, and it is the widest of the three, so it is the one worth giving
 * the full width to.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE ONE HERO ON THIS PAGE WITH NO AREA FILL
 *
 * A fill reads as area under the curve measured from zero, so a card that
 * fits its axis to the values must not carry one. All three series here are
 * cumulative counters and all three need a fitted axis: a star count moving 60
 * to 64 over a month, drawn from zero, is a flat line at the top of an axis
 * that is 94 percent empty, which hides the only thing the chart is for.
 *
 * The two rules cannot both hold on one card, so the fill is what gives way.
 * That costs one of the four things the page relies on to carry the hero
 * hierarchy at a single column, and the other three still apply here: the hero
 * plot is 280px against 150, it sits on --chat against a lighter recessive
 * panel, and the group's lead figure is a large number directly above it. It
 * is a real loss and it is smaller than the loss of leaving seven of twelve
 * cards in the group a reader meets first.
 * ─────────────────────────────────────────────────────────────────────────
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var F = window.INSIGHTS_FIGURES;
  var C = window.INSIGHTS_CHARTS;
  var G = window.INSIGHTS_GROUPS;

  var LEAD = { label: "Stars", kind: "point", series: "stars", field: "total" };

  /* Every live uPlot instance this group owns. Assigned only once a render
   * has completed; a render that throws destroys what it built itself. */
  var live = [];

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /*
   * Verbatim from the growth section's `axisNote`, in the singular. That
   * sentence said "the vertical axis on both charts is fitted", which
   * described two series sharing one axis; there are three cards with an axis
   * each now, so there is no "both charts" for it to refer to. The claim it
   * makes is unchanged, and it is rendered inside each card rather than once
   * per section, because a fitted baseline is the other half of the
   * truncated-axis trade and must not be silent.
   */
  var FITTED_NOTE = "The vertical axis is fitted to the values drawn rather than pinned to a " +
    "zero baseline, so a move of a few is visible rather than flattened. Read the height of " +
    "the line against its own axis labels, not against the bottom of the frame.";

  /*
   * Verbatim from the growth section, where it was true and stays true: a
   * weekly bucket is keyed on the Monday that opens its week while a
   * cumulative field carries the LAST value measured in that week, so a point
   * sits up to six days earlier on the axis than the reading it shows.
   *
   * This is the sentence that could NOT travel to the Delivery hero, whose
   * series is summed rather than carried. It stays here, where it is exact.
   */
  var WEEKLY_CUMULATIVE_NOTE = "This bundle is bucketed by week. A point is dated on the Monday " +
    "that opens its week but carries the last value measured in that week, so it sits up to " +
    "six days earlier on the axis than the reading it shows.";

  function cumulativeSpec(profile, title, figure, series, field, label, token, fallback,
    downsampled) {
    var notes = [FITTED_NOTE];
    if (downsampled) notes.push(WEEKLY_CUMULATIVE_NOTE);
    var line = { column: "total", label: label, token: token, fallback: fallback };
    /* A hero's stroke is 2px against the compact profile's 1.5. No `fill` on
     * any of the three, hero included: see the header comment. */
    if (profile === "hero") line.width = 2;
    return {
      profile: profile,
      title: title,
      figure: figure,
      columns: { total: { series: series, field: field } },
      lines: [line],
      yPolicy: "fitted",
      breakPhrase: "drawn as breaks, not as a fall to zero",
      notes: notes
    };
  }

  function render(slot, data, rangeKey) {
    var ctx = {
      data: data,
      win: I.rangeWindow(data, rangeKey),
      wins: F.windows(data),
      step: I.resolutionStepDays(),
      downsampled: data.downsampled
    };

    G.groupHead(slot, LEAD, ctx);

    /* This is the one group with no detail band. Every card it holds needs a
     * time axis, so on a bundle with no dated measurement there is nothing it
     * can draw and the no-time-axis state is the whole group rather than part
     * of it. The other three each hold at least one card that needs no window:
     * a ranked list, a release list, a threshold note. */
    if (ctx.win === null) {
      slot.appendChild(el("p", "slot-note",
        "The archive holds no dated measurement, so there is no time axis to draw the star, " +
        "fork and watcher counts on."));
      return;
    }

    var hero = G.band("hero");
    var series = G.band("series");
    var created = [];
    try {
      G.keep(created, G.buildCardSafely(hero, function () {
        /* The hero carries no card-head figure: the group head directly above
         * it prints the same series' figure, and printing it twice a hundred
         * pixels apart is the duplication `INSIGHTS_FIGURES` exists to make
         * unnecessary. Reach's and Adoption's heroes do the same. */
        return G.chartCard(hero, cumulativeSpec("hero", "Stars", null,
          "stars", "total", "Stars", "--amber", "#fcd34d", ctx.downsampled), ctx);
      }));

      /* Each on its own y axis. Stars and forks shared one while a single set
       * of release markers was painted across both and the markers made the
       * comparison; the markers are on the Delivery hero now, and the two
       * differ by an order of magnitude in the live archive, so a shared axis
       * would flatten the fork line onto the floor for no remaining gain. */
      G.keep(created, G.buildCardSafely(series, function () {
        return G.chartCard(series, cumulativeSpec("compact", "Forks",
          { label: "Forks", kind: "point", series: "forks", field: "total" },
          "forks", "total", "Forks", "--coral", "#fb923c", ctx.downsampled), ctx);
      }));

      /* Watchers gains a plot it does not have today. It is the uniform
       * application of the small-card rule rather than an addition of scope:
       * no series is added and no figure is derived that the page does not
       * already print. */
      G.keep(created, G.buildCardSafely(series, function () {
        return G.chartCard(series, cumulativeSpec("compact", "Watchers",
          { label: "Watchers", kind: "point", series: "repo", field: "subscribers" },
          "repo", "subscribers", "Watchers", "--lavender", "#c4b5fd", ctx.downsampled), ctx);
      }));
    } catch (error) {
      /* `live` is assigned only once every card is built, so a throw part-way
       * leaves `created` referenced by nothing but this frame. Destroy what
       * was built here, then let the shell render its failure note. */
      for (var j = 0; j < created.length; j++) {
        try {
          created[j].destroy();
        } catch (cleanupError) {
          if (typeof console !== "undefined" && typeof console.error === "function") {
            console.error("insights: releasing a following chart after a failed render also " +
              "failed.", cleanupError);
          }
        }
      }
      throw error;
    }
    G.attach(slot, [hero, series]);
    live = created;
  }

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

  I.registerSection("following-body", render, teardown);
})();
</script>
```

Two smaller edits go in this commit, because this is where they stop being true:

- The `INSIGHTS_FIGURES` header comment says the surface has "four consumers instead of one, the lead figure row and each of the three groups' compact card heads". It is five and four now. Correct the count.
- The `INSIGHTS_GROUPS` header comment's "four groups draw the same two kinds of card" is already correct as Task 4 wrote it; check it rather than changing it.

- [ ] **Step 3: Delete the growth section**

Delete the `#growth` panel and the whole `chart-growth` IIFE, remove `"chart-growth"` from `SLOT_IDS` and `NOTE_SLOT_IDS`, and remove the now-dead `<a class="nav-link" href="#growth">Growth</a>`.

Move the panel's paragraph into `#method` under a new `<h3>Cumulative counts</h3>`, inserted between the **Traffic** heading Task 6 added and the **Opt-in pings** heading Task 5 added, which is its final position. Em dashes are replaced with the punctuation the sentences need; nothing else is reworded.

Before deleting, confirm that nothing outside the block still calls `fittedCounts` (it moved to the toolkit in Task 4), `collectReleases`, `releaseCaption`, `releaseNarrative`, `listGroups`, `listOutside` or `releaseLabel` (all moved to the toolkit in Task 2). `singlePointNote`, `stepWord`, `plural`, `steps`, `readings`, `measuredPhrase`, `stepPhrase`, `latestReading`, `weeklyNote`, `axisNote` and the growth `metaLine` go with the block. `stepWord` in particular is the copy Task 2 deliberately left behind, and this is the commit that removes it. Their surviving content is the two notes in Step 2, the Delivery hero's own weekly caution from Task 4, and the shared one-point rule from Task 4.

- [ ] **Step 4: Run the recipe at `long`, `high` and `dimensions-only`**

**What counts as a pass, and what counts as a failure:**

- The `following-body` slot holds a group head labelled `Stars` whose `value`, `sub`, `chip` and `chipTitle` are identical to the `Stars` card in `header-stats`. Both are `pointCard` calls on one spec shape; a difference means `figure` dispatched a different kind than the at-a-glance `CARDS` entry declares. This is a point figure, so its chip is unaffected by Task 6's flow-chip change.
- The slot holds three cards in order: `Stars` with `compact: false` and `plot.canvasHeight` 280, `Forks` with `compact: true` and `plot.canvasHeight` 150, `Watchers` with `compact: true` and `plot.canvasHeight` 150. Assert `canvasHeight`, not `overHeight`, which is the plot area and reads about 216 and 112 here.
- `Forks` and `Watchers` each carry a `figure` whose `value`, `sub` and `chip` match the same-named at-a-glance card exactly. Compare both pairs.
- **No card in this group reports a `fill` on any line, the hero included.** Confirm by eye that the star chart has no shaded area under it. It is the only hero on the page without one and the only place a reviewer might "fix" it back; the header comment in Step 2 is the reason it stays.
- Each of the three carries a hint containing `fitted to the values drawn rather than pinned to a zero baseline`.
- The `Forks` card draws its own axis. In the fixture, forks is a constant 4 across the archive while stars climb, so the two cards' plots must differ and the fork line must not be a flat line pinned to the top of a star-scaled axis. Read the two `.u-axis` label sets in the browser: the fork axis tops out near 5 and the star axis near 100 at `high`, near 160 at `long`.
- The `Watchers` card draws a plot. The fixture writes `subscribers: 9` on every one of its days, which is a flat line on a fitted axis with one whole unit of air either side, and it is a plot rather than a stated reason because there are far more than two measured positions.
- The `chart-growth` slot is gone from the report, and no slot other than `following-body` holds a card titled `Stars`, `Forks` or `Watchers`.
- The report's `nav` lists `#following Following` and no longer lists `#growth`.
- The `reach-body` slot still holds exactly two cards, `Page views` and `Repository clones`. Three would mean a growth card landed in the wrong group.
- At `dimensions-only`, `following-body` holds the group head, the no-time-axis note, and no card at all. It is the one group that renders nothing else in that state, because it has no card that works without a window.
- `console messages: 1` (the planted probe and nothing else), `console capture proof: PASS`.

- [ ] **Step 5: Update `docs/systems/metrics.md`**

- Section 10 opening: the count stays at "Eight sections". The list loses "growth" and gains "**following** (stars as the hero, with forks and watchers beside it)". Say that this group exists because reach was answering two questions, traffic and people who chose to follow the repository, and that its hero is the one chart on the page drawn on a fitted axis without an area fill.
- Section 10.7: replace the paragraph explaining that stars and forks share an axis because one set of release markers is painted across both. They are now expanded per card like every other card in a group, they each get their own y axis, and the markers sit on the Delivery hero. Keep the rule itself unchanged: a chart's x axis spans the days that chart was measured on, and two charts share an axis only when they share a history.

- [ ] **Step 6: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "feat(insights): add the following group"
```

---

## Task 8: Reach, part two: the ranked dimension cards

Spec sections 3.1 and 5.3. Nothing about the dimension renderer's behaviour changes: all three of its states, every conditional hint and the join on the dimension string are preserved.

**Files:**
- Modify: `site/insights/index.html` (the dimension IIFE becomes a card builder, `#referrers` and `#paths` deleted, the reach section, `SLOT_IDS`)
- Modify: `docs/systems/metrics.md` section 10 opening

**Interfaces:**
- Consumes: the reach section's `detail` band (Task 6).
- Produces: `window.INSIGHTS_DIMENSIONS.build(band, spec, data, rangeKey)` returning **the single plot handle it mounted, or null**, and `window.INSIGHTS_DIMENSIONS.SECTIONS`.

- [ ] **Step 1: Turn the dimension IIFE into a card builder**

Keep every function in the block. Change only the wrapper: `makeRenderer(spec)` becomes `build(band, spec, data, rangeKey)` and the two `registerSection` calls go. Its `render` body is unchanged except that:

- everything it appends to `slot` is appended to a single `.chart-card` it creates through `G.detailCard(band, spec.rankedTitle)` instead, so the ranked list, the movement chart and every stated reason live in one card rather than in a section;
- the inner `chart-stack` it built is dropped: a detail card is the container now;
- the `rankCard` it built is dropped for the same reason, and its children go straight into the detail card;
- the block's `live` section state becomes a local variable, and `build` **returns the one plot handle it mounted, or null**. The section owns at most one instance, which is what the comment at `index.html:4671` already says, and the caller in Step 2 pushes that handle into the array whose members Reach's `teardown` calls `.destroy()` on. Returning an array instead would make that teardown throw `pending[i].destroy is not a function` on every re-render;
- the movement chart's `mount` call (`index.html:5820`) gains `profile: "compact"` beside its `yRange` and `hooks`. Spec section 5.3 says the dimension cards' movement chart is drawn compact, and without the option it takes the hero default and Step 4's geometry check fails. It is compact because it sits inside a detail card and is a subordinate reading of the ranked list above it;
- the two inner `<p class="chart-title">` captions, `Movement between snapshots` and `Change since the previous snapshot` (`index.html:5772` and `:5455`), **stay as they are**, `<p>` and class included. They are captions for the plot below them rather than titles of the card, so the card keeps exactly one heading and the page's outline stays one `h3` per card. The harness's `cardOf` reports the first `.chart-title` in document order, which is the card's own `<h3>`, so the report is unaffected.

**Move the whole dimension `<script>` block above the reach block, where the old `chart-reach` block was.** The reach IIFE reads `var D = window.INSIGHTS_DIMENSIONS;` at IIFE scope (Step 2), and the dimension block sits at `index.html:4588`, after the growth block and therefore later in the document. Left where it is, `D` captures `undefined` and `D.SECTIONS` throws a `TypeError` on every reach render, taking the whole group to its slot note. The fault would not appear at load, because `registerSection` renders immediately only when the fetch has already resolved, so it surfaces at first render and looks like a data problem. After this task the block registers no sections and exports only `INSIGHTS_DIMENSIONS`, so its position is free, and moving it matches how `INSIGHTS_FIGURES` and `INSIGHTS_GROUPS` are already ordered.

The `SECTIONS` array keeps both entries and gains nothing. Export:

```js
  window.INSIGHTS_DIMENSIONS = { SECTIONS: SECTIONS, build: build };
```

The `slotId` field on each entry is now unused; delete it, and change `rankedTitle` for the referrers entry from `"Referring sites, ranked"` to `"Referring sites"` and for paths from `"Paths, ranked"` to `"Popular paths"`, so the detail card's `<h3>` names the card rather than describing the list inside it. The ranked meta line under the title already says the list is a ranking.

- [ ] **Step 2: Call it from the reach section**

In the reach section's `render`, after the clones card:

```js
      /* The two ranked dimension cards. They come from one snapshot and need
       * neither a window nor a time axis, so they are built whether or not
       * the rest of the group could draw, and they are the reason the detail
       * band is attached even on a bundle with no dated measurement at all. */
      for (var d = 0; d < D.SECTIONS.length; d++) {
        var dimension = D.SECTIONS[d];
        var built = G.buildCardSafely(detail, (function (spec) {
          return function () { return D.build(detail, spec, data, rangeKey); };
        })(dimension));
        if (built !== null && built !== undefined) created.push(built);
      }
```

with `var D = window.INSIGHTS_DIMENSIONS;` at the top of the IIFE.

**The loop goes above the `if (ctx.win === null)` early return**, so the detail band is built in that state too, and that branch becomes `G.attach(slot, [detail]); return;`. Move `var created = [];` above the early return with it. `var` hoists, so leaving the declaration where it is puts `created.push(built)` in front of an `undefined`, which is a `TypeError` outside the `try` and fails the whole Reach slot, in precisely the `dimensions-only` state the move exists to serve. The three band variables are already declared above the return; `created` is the one that is not.

The loop runs outside the `try` on purpose. Each card carries its own containment through `G.buildCardSafely`, and the `try` below it exists to release plots built by the chart cards, which do not exist yet at this point in the render.

- [ ] **Step 3: Delete the two panels**

Delete the `#referrers` and `#paths` panels and their nav links, remove `"ranked-referrers"` and `"ranked-paths"` from `SLOT_IDS` and `NOTE_SLOT_IDS`, and move both paragraphs into `#method` as one paragraph covering both, as spec section 7.3 directs: the trailing 14-day basis is stated once for referrers and paths together.

- [ ] **Step 4: Run the recipe at `high` and `dimensions-only`**

**What counts as a pass, and what counts as a failure:**

- The `reach-body` slot holds four cards: `Page views`, `Repository clones`, `Referring sites` and `Popular paths`, the last two with `compact: false` and a `rows` array. The `ranked-referrers` and `ranked-paths` slots are gone from the report. Four is the point of the split: with stars, forks and watchers in Following, the group a reader meets first holds four of the page's twelve cards rather than seven.
- The `Referring sites` card's rows carry the same names, numbers, subs and fill colours the `ranked-referrers` slot reported before this task, and the same bar *ratios*. Not the same pixel widths: this task is what moves the card from a full-width slot into a two-column band, so a row at 100 percent share goes from about 1000px to about 453px, and a criterion demanding equal widths cannot hold. Measured on the delivered page, a 453px track gives 453 and 166 for shares of 1 and 11/30, and 11/30 of 453 is 166.1. Capture the report before the change and diff those two card entries on everything except `width`, and check `width` as a ratio against the track. **Check `fill` at a mode where fills can differ.** At `high` every row is neutral, so an identical `fill` there discriminates nothing; the colour join to the movement chart is only observable where a dimension has several snapshots.
- The fixture writes exactly one referrer snapshot, so both cards take the "fewer than two differenceable snapshots" path and state their reason rather than drawing a movement chart. The card's `note` must contain that stated reason, and `plots` for the slot must not have increased. If a movement chart appears, the snapshot count is being read from the wrong place.
- At `dimensions-only` the two cards render in full, with their ranked lists, while the rest of the group is the no-time-axis note. This is the state the detail band's unconditional build exists for; a slot holding only the note is a failure.
- The report's `nav` no longer lists `#referrers` or `#paths`.
- `console messages: 1` (the planted probe and nothing else), `console capture proof: PASS`.

To exercise the movement chart, hand-edit `"$SP/fx/archive/traffic/referrers.ndjson"` to hold the same dimension on three consecutive snapshot dates with different counts, re-run the bundle step and the check, and confirm the `Referring sites` card now reports a plot with `canvasHeight` 150 and a `movement` meta line. A `canvasHeight` of 220 or 280 means the `profile: "compact"` option from Step 1 did not reach the mount call. Assert `canvasHeight`, not `overHeight`, which is the plot area and reads about 112 here.

- [ ] **Step 5: Update `docs/systems/metrics.md` section 10 opening**

The count becomes "Six sections" and the section list loses "referrers" and "paths", leaving at a glance, method coverage, reach, following, adoption and delivery. The Reach entry names all four of its cards. State that the two dimension cards are detail cards inside Reach and that their three states, their conditional hints and their snapshot basis are unchanged.

- [ ] **Step 6: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "feat(insights): move the ranked dimension cards into the reach group"
```

---

## Task 9: The lead figure row, and the cutover

Spec sections 4, 5.1, 8.1, 10, 11.1 and 11.4. **This task lands spec section 16's call 6: the at-a-glance section dissolves.**

**Files:**
- Modify: `site/insights/index.html` (the lead figure row, `#at-a-glance` deleted, the nav, `#chart-hint`, `placeHint`, `SLOT_IDS`, `INSIGHTS_FIGURES`)
- Modify: `docs/systems/metrics.md` sections 10 opening, 10.6 and 11

**Interfaces:**
- Consumes: everything.
- Produces: `renderFigure`'s `"summary"` mode and the `lead-figures` slot. Nothing new on `INSIGHTS_FIGURES`.

- [ ] **Step 1: `flowTrend` is already in place**

`flowTrend`, `windowTotal` and the `trend: "compare"` dispatch landed in Task 6, because Reach's group head and its clones card head are the page's first two flow chips and they needed it three commits before this one. This step adds nothing to `INSIGHTS_FIGURES`.

What it does is put the same spec object behind both printings. Reach's `LEAD` already carries `trend: "compare"`; the `FIGURES` array in Step 3 declares the same flag on its Page views entry, and Step 6 asserts that the row and the group head come out character for character identical. If they ever differ, one of the two specs was edited without the other, which is the failure this whole surface exists to prevent.

Recheck while you are here: `flowTrend` takes `(series, field, wins, step)` and reads no `data`. If a fifth argument is still being threaded through, drop it.

- [ ] **Step 2: Add the `"summary"` mode**

In `renderFigure`, the summary presentation is an anchor rather than a div:

```js
  function renderFigure(fig, mode) {
    var box;
    if (mode === "summary") {
      /* A real link, so it is keyboard reachable and announced as one. The
       * three figures are the page's table of contents. */
      box = el("a", "lead-figure");
      box.href = fig.anchor;
      box.appendChild(el("p", "stat-label", fig.label));
    } else if (mode === "heading") {
      box = el("div", "group-head");
      box.appendChild(el("p", "stat-label", fig.label));
    } else {
      box = el("div", "card-figure");
    }
    /* ... the head, sub and note exactly as Task 4 wrote them: the .card-head
       div holding the .stat-value and the chip, then the .stat-sub, then the
       .stat-note when there is one ... */
  }
```

Note what is not in the elided part: `"card"` mode emits **no** `.stat-label`. A compact card's `<h3>` already names the series, and a label under it would print the name twice. Only `"summary"` and `"heading"` add one, which is why the two branches above append it and the `else` does not.

`figure` copies `spec.anchor` onto the returned object beside `label`.

- [ ] **Step 3: Add the lead figure row and delete the at-a-glance section**

In the markup, after `#status-region` and before `.controls`:

```html
    <div class="slot lead-row" id="lead-figures"></div>
```

It sits above the range control on purpose: the figures do not move with the range, their window is fixed at 30 days, and putting them below a control that does not govern them would invite the reading that it does.

Delete the whole `#at-a-glance` panel and its IIFE. Add `"lead-figures"` to `SLOT_IDS` and **not** to `NOTE_SLOT_IDS`; remove `"header-stats"` from both. Add a new `<script>` block:

```html
<script>
/*
 * Section "lead-figures" -- one figure per group, at the top of the page.
 *
 * They are the page's table of contents: three numbers, each a link to the
 * group it heads, each repeated as that group's own headline. Both printings
 * come out of one `INSIGHTS_FIGURES.figure` call per figure per render, which
 * is the whole reason that surface exists: the row and a group head printing
 * different numbers for the same series is a failure nothing else on this
 * page would catch.
 *
 * No curation. Each figure is printed at whatever value it holds, however
 * small, and at full precision: 72 is 72 and 12,480 is 12,480.
 *
 * The window is a fixed 30 days ending on the archive's newest measured day,
 * deliberately not the selected range, so the three stay comparable to each
 * other whatever the control shows.
 */
(function () {
  "use strict";

  var I = window.INSIGHTS;
  var F = window.INSIGHTS_FIGURES;

  /* In page order, so the row reads left to right in the order a reader will
   * meet the groups below it. Three of the four are at-a-glance cards
   * promoted rather than figures invented; Releases shipped is the only one
   * new to the page, and it is a count of rows in an array the page already
   * carries. */
  var FIGURES = [
    {
      label: "Page views", kind: "flow", series: "views", field: "count",
      trend: "compare", anchor: "#reach"
    },
    { label: "Stars", kind: "point", series: "stars", field: "total", anchor: "#following" },
    {
      label: "App downloads", kind: "point", series: "repo", field: "downloads_app",
      anchor: "#adoption"
    },
    { label: "Releases shipped", kind: "releases", anchor: "#delivery" }
  ];

  function render(slot, data) {
    var wins = F.windows(data);
    for (var i = 0; i < FIGURES.length; i++) {
      slot.appendChild(F.renderFigure(F.figure(FIGURES[i], data, wins), "summary"));
    }
  }

  I.registerSection("lead-figures", render);
})();
</script>
```

The four group renderers' `LEAD` constants gain the matching `anchor`, so the row and the heads are the same four specs. Reach's already carries `trend: "compare"` from Task 6.

- [ ] **Step 4: Pin the chart hint under the sticky bar and retire `placeHint`**

Move the `<div class="wrap"><p class="chart-hint" id="chart-hint"></p></div>` block from between the deleted panels to immediately after the `.controls` div, outside it.

In `INSIGHTS_CHARTS`, delete `placeHint`, `lastHost`, `childOf`, `forgetHost` and `liveHosts`, and the `liveHosts.push(host)` / `forgetHost(host)` calls in `mount` and its rollback. `syncHint` keeps its count and its two wordings and loses its call to `placeHint`. Replace `placeHint`'s comment block with:

```js
  /*
   * The page's one interaction hint, directly under the sticky range control.
   *
   * It used to move: it was appended by whichever section drew last, because
   * a hint sitting under a section that drew nothing would read as a caption
   * for something that is not there. Under the sticky bar it is page chrome
   * rather than a caption, so it has one fixed place and needs no
   * bookkeeping. The count is still what chooses the wording: with exactly
   * one plot on the page there is no "every chart" to speak of.
   */
```

- [ ] **Step 5: Rewrite the nav**

```html
    <a class="nav-link" href="#reach">Reach</a>
    <a class="nav-link" href="#following">Following</a>
    <a class="nav-link" href="#adoption">Adoption</a>
    <a class="nav-link" href="#delivery">Delivery</a>
    <a class="nav-link" href="#method">Method</a>
```

- [ ] **Step 6: Run the recipe at `long`, `high`, `low`, `none`, `dimensions-only` and `no-releases`**

**What counts as a pass, and what counts as a failure:**

- The `lead-figures` slot holds exactly four `figures`, labelled `Page views`, `Stars`, `App downloads` and `Releases shipped`, in that order, which is the page order of the groups they link to.
- Each of the four equals its group head, field for field: `value`, `sub`, `chip` and `chipTitle`. Compare `lead-figures` against `reach-body`, `following-body`, `adoption-body` and `delivery-body` in the same report. A single mismatched character is a failure, and it is the failure this whole surface exists to prevent.
- At `long`, the `Page views` chip is a signed number with a `chipTitle` naming both totals and containing `against`. At `high` (40 days) it is the dash glyph with a `chipTitle` containing `the 30 days before this window are not measured end to end`. Both paths, on two modes, in one task.
- At `no-releases`, the `Releases shipped` figure is the dash glyph with `sub: "The archive holds no release record."` and is still printed: a refused trend never suppresses a figure, and a missing figure never withholds a group. Confirm the Delivery group still renders its hero and its cards on that run.
- **Pin `releaseTrend`'s window edges, which no mode covers today.** Add a fixture mode `release-edge`: the same shape as `long`, with one release dated exactly on `priorStart` (`E - 59 * D`), one inside the prior window, and two inside the recent window. Assert the chip reads `+1 · 30d` and the `chipTitle` says `2 releases shipped in the 30 days to` and `against 2 in the 30 days before them`, so the boundary release is counted in the prior window and not in the recent one and not in both. Move the boundary release one day later in a scratch copy and confirm the chip changes; that is what makes the assertion falsifiable rather than merely true.

  This exists because Task 4 could not close it from `long`, and said so rather than forcing it: in that archive no date is both outside the drawn CI span and adjacent to a window edge, so a release placed on the boundary either lands inside the drawn span, where it gets marked and moves the lead value, the release list and the caption that Step 8 asserts, or produces a trend of `0`, which is the value a swapped window and an off-by-one also produce. A dedicated mode is the only way to test the edge without breaking four assertions that are already correct. Off-by-one at a window edge is the exact defect class that got this plan's first fixture rewritten, and `releaseTrend` has no unit test and cannot get one, because it is page JavaScript.
- The four figures are `<a>` elements. Tab through the page in the browser: focus order is nav, the four figures, the four range buttons, then the page. Each shows the 2px sky focus ring at 3px offset, and pressing Enter on each lands on the matching group heading clear of the sticky bar.
- The `header-stats` slot is gone from the report, and `#at-a-glance` is gone from `sections`. Every one of its eight cards is accounted for: **three as lead figures** (Views, Stars, App downloads) **and five as compact card heads** (Forks, Watchers, Clones, Contributors, Update checks). Walk spec section 5.3's mapping table against the report and confirm all eight. The fourth lead figure, Releases shipped, was never one of the eight.
- At 1440px the lead row is four columns; below 1000px it is two columns and two rows deep, with the values at the heading size. Check both, and check that the two-row block does not push the sticky range control below the fold at 900px.
- The report's `hint.after` names the controls bar. The hint text is present whenever the page holds more than one plot and reads the multi-chart wording. Drag across any chart and confirm every chart on the page rezooms; the report's zoom-sync block must show `redrew` for every entry, across all four groups.
- The report's `nav` lists exactly five links: `#reach Reach`, `#following Following`, `#adoption Adoption`, `#delivery Delivery`, `#method Method`. They hide at or below 900px, which is the page's existing rule and is not raised for the fifth link.
- With JavaScript disabled in the browser, the page still shows the `h1`, the four group headings with their captions, the `#method` heading with its five subheadings and all its prose, the `BUILD:SUMMARY` figures, the `noscript` pointer and the footer. Nothing that was readable without JavaScript before this plan is missing.
- `console messages: 1` (the planted probe and nothing else) and `console capture proof: PASS` on every mode.

- [ ] **Step 7: Update `docs/systems/metrics.md`**

- Section 10 opening: the count becomes the final shape: six registered sections, `lead-figures`, `reach-body`, `following-body`, `adoption-body`, `delivery-body` and `method-coverage`; the four groups and what each holds; the lead figure row, its four figures and its fixed 30-day window; and the note that the at-a-glance grid's eight cards survive as three lead figures and five compact card heads.
- Section 10.6: the per-group and per-card states from spec section 8.2, and the note that `renderSlots` writes into the four group slots only.
- Section 11: the harness paragraph gains the final mode list and a sentence that the check script reads every slot, so the eight-card mapping can be walked against one report.

- [ ] **Step 8: Commit**

```bash
git add site/insights/index.html docs/systems/metrics.md
git commit -m "feat(insights): add the lead figure row and retire the at-a-glance grid"
```

---

## Final verification

- [ ] `pnpm --filter @backspace/metrics test` passes with no change in the test count. Nothing in this plan edits `scripts/metrics/src/**`, so a change here means something was edited that should not have been.
- [ ] `node scripts/metrics/fixtures/insights-check.mjs "$SP/fx/site" --prove-console` at each of `long`, `high`, `threshold`, `low`, `none`, `high-other`, `high-nodims`, `sparse`, `no-releases`, `dimensions-only`, and once more at `high` after the `--strip-telemetry` pass. Zero console messages and zero failed requests on all eleven.
- [ ] Walk spec section 2's three inventory tables against one `long` report and one browser window. Every row's destination is where the table says it is. This is the check the owner will make, and it is the one that decides whether the change is finished.
- [ ] The page at 1440px, 1000px, 984px, 910px, 900px, 760px, 560px and 380px: the body never scrolls sideways, the hero cards scroll inside their own containers below about 570px, no compact card scrolls at any width (240px minimum against a 320px viewport's 256px host), and the hero is visibly taller than every card under it at every width. The lead row is four columns at and above 1000px and two below it. The series band drops to two columns at 984px and the detail band to one at 910px, which are the intrinsic thresholds spec section 9.1 states rather than breakpoints anything declares.
- [ ] Following's hero is the only chart on the page with a fitted axis and no area fill, and the other three heroes all carry one. Confirm by eye in one pass down the page.
- [ ] Chrome's rendering panel with `prefers-reduced-motion: reduce` and `prefers-reduced-transparency: reduce`: no animation runs, anchor scrolling is instant, and the nav and range pill are solid.
- [ ] `grep -n "—" site/insights/index.html` and read the lines this plan touched. `grep -c` prints a count and names nothing, and the count is not zero and is not meant to be: the file's comments carry many em dashes and the copy rule leaves a string that stays where it is alone. The arrows in window and span lines are `→`, not `—`, so they do not appear in this grep at all. What must not appear is an em dash inside a sentence this plan moved or wrote.
- [ ] `git diff --stat main...HEAD` names these files and no others. Four are the ones this plan sets out to change:
  - `site/insights/index.html`
  - `scripts/metrics/fixtures/insights-check.mjs`
  - `scripts/metrics/fixtures/insights-fixture.mjs`
  - `docs/systems/metrics.md`

  Three more are expected and are not scope creep:
  - `scripts/metrics/src/bundle.test.ts`, one test Task 1 added. The Global Constraints allow a task to pin a bundler-side guarantee it leans on, and require the test to be written in that task rather than deferred.
  - `docs/superpowers/plans/2026-09-07-insights-facelift.md`, this plan, which the branch introduces and amends as reviews land.
  - `docs/superpowers/specs/2026-09-06-insights-facelift-design.md`, amended once when the design moved from three groups to four.

  Anything outside those seven is scope creep and has to be justified or reverted. The original wording of this check said four files full stop, which was wrong from the first commit: the plan document is itself part of the branch.
- [ ] `git log --oneline main..HEAD` shows nine commits, none with an attribution trailer and none with a session link.

---

## Not in this plan

- **The telemetry charts themselves.** Track F built them; this plan moves them into the Adoption detail band and changes nothing about what they draw.
- **`scripts/metrics/src/datapage.ts`.** Spec section 13 checked every caveat leaving a group header against the data page and found all of them already stated there. The required change is none, and that is a finding rather than an omission.
- **The bundle contract, the collector, the archive schemas, the workflows and the deploy wiring.** Untouched.
- **`<title>`, `<meta name="description">` and either JSON-LD block.** They describe the dataset, the dataset has not changed, and the committed block is kept in sync by hand with what `summary.ts` emits.
- **A light theme, localisation, a new series, and any chart of `open_issues`, `downloads_total` or the five undrawn telemetry network columns.** All out of scope by spec section 15, and the last group stays in the archive, in the bundle and in the static tables where it is read.
