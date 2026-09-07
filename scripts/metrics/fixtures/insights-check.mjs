/*
 * Loads a fixture copy of the insights page in headless Chrome and reports
 * what it finds: every console message, every page exception, every request
 * that failed, and then the page as it actually rendered: every slot with its
 * figure blocks and its cards, each plot's rendered geometry, the rankings
 * under each range button, and whether a drag on one chart rezoomed the rest.
 *
 * Companion to `insights-fixture.mjs`. Together they are what stands in for
 * the automated tests `site/insights/index.html` cannot have without a new
 * dependency. Neither script adds one: this uses only Node built-ins, the
 * global `WebSocket`, and whatever Chrome the machine already has.
 *
 * Usage:
 *   node scripts/metrics/fixtures/insights-check.mjs <siteDir> [--prove-console]
 *
 * `<siteDir>` is the `<outDir>/site` the fixture script wrote. The page is
 * served from there and opened at `/insights/`.
 *
 * `--prove-console` installs a `console.warn` in the page itself, before any
 * page script runs, and expects to see it come back. Run it at least once per
 * session before believing a clean console: a listener that was never
 * attached and a page that logged nothing look exactly alike from here, and
 * "the console was clean" is worth nothing without that distinction.
 *
 * Exit code is 0 when the run completed, 1 when it could not (no Chrome, a
 * navigation failure, or `--prove-console` not seeing its own warning). A
 * dirty console is reported, not turned into an exit code, because deciding
 * which messages matter is the reader's job.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [, , siteDirArg, ...flags] = process.argv;
if (siteDirArg === undefined) {
  console.error('usage: node insights-check.mjs <siteDir> [--prove-console]');
  process.exit(2);
}
const siteDir = path.resolve(siteDirArg);
const proveConsole = flags.includes('--prove-console');
const PROBE = 'insights-check: console capture is live';

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/* A static server narrow enough to be obviously safe: it resolves inside
 * `siteDir` and answers 404 to anything that escapes it. */
function serve(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const full = path.resolve(root, '.' + rel);
    if (full !== root && !full.startsWith(root + path.sep)) {
      res.writeHead(404).end('no');
      return;
    }
    readFile(full).then(
      (body) => {
        res.writeHead(200, { 'content-type': MIME[path.extname(full)] ?? 'application/octet-stream' });
        res.end(body);
      },
      () => res.writeHead(404).end('not found'),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function poll(fn, tries, waitMs) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw last;
}

/* A thin CDP client. `send` resolves with the command result; every event is
 * handed to `onEvent`. */
function connect(wsUrl, onEvent) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry === undefined) return;
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result);
      return;
    }
    onEvent(message.method, message.params);
  });
  const ready = new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`cannot reach ${wsUrl}`)));
  });
  return {
    ready,
    close: () => socket.close(),
    send(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        socket.send(JSON.stringify({ id, method, params: params ?? {} }));
      });
    },
  };
}

/* Everything the run saw, in arrival order. */
const console_ = [];
const failures = [];

/*
 * Frames Chrome has finished loading, and a hook the navigation waiter
 * installs.
 *
 * Buffered rather than awaited directly because `Page.frameStoppedLoading`
 * can arrive before the `Page.navigate` command's own reply hands back the
 * frame id to match it against.
 */
const stoppedFrames = new Set();
let onFrameStopped = null;

function onEvent(method, params) {
  if (method === 'Runtime.consoleAPICalled') {
    const text = (params.args ?? [])
      .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type)))
      .join(' ');
    console_.push({ source: 'console.' + params.type, text });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params.exceptionDetails;
    console_.push({
      source: 'exception',
      text: d.exception?.description ?? d.text,
    });
  } else if (method === 'Log.entryAdded') {
    console_.push({ source: 'log.' + params.entry.level, text: params.entry.text });
  } else if (method === 'Page.frameStoppedLoading') {
    stoppedFrames.add(params.frameId);
    if (onFrameStopped !== null) onFrameStopped();
  } else if (method === 'Network.loadingFailed') {
    failures.push(`${params.type} ${params.errorText}`);
  } else if (method === 'Network.responseReceived') {
    if (params.response.status >= 400) {
      failures.push(`HTTP ${params.response.status} ${params.response.url}`);
    }
  }
}

/*
 * Read back out of the page. Runs in the page, returns plain data.
 *
 * Every slot, not only the telemetry one: after the facelift there are five,
 * and a report that can only see one of them cannot tell whether a figure
 * moved or vanished. The page head's lead sentence and the four provenance
 * values come back too, so a task asserting either reads it out of the report
 * rather than proving it out of band.
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
  /*
   * Every live uPlot instance on the page, so a card's y scale and its
   * series' fills can be read rather than guessed at.
   *
   * Neither is in the DOM. uPlot paints its axis ticks and its area fills
   * onto the canvas, so a card drawn on a fitted axis and the same card
   * drawn on another card's axis produce byte-identical reports, and so do a
   * filled line and an unfilled one. Both are properties this plan asserts:
   * a group whose cards each need an axis of their own, and the one hero on
   * the page that carries no fill. Asserting either from the report meant
   * widening the report to carry it.
   *
   * The instances are reachable because every plot on this page joins one
   * cursor-sync group, and uPlot's sync registry keeps a live array of the
   * plots registered under a key. The key is the page's own, so a page that
   * renamed it would leave this list empty: that is reported in words below
   * rather than passed off as "no fill anywhere".
   */
  var syncPlots = [];
  if (typeof uPlot !== "undefined" && typeof uPlot.sync === "function") {
    syncPlots = uPlot.sync("insights-time").plots;
  }
  /* A series' fill after uPlot has initialised it is a function returning the
   * declared value, or null when none was declared. Both forms are handled,
   * because which one a version normalises to is uPlot's business and not a
   * fact this report should depend on. */
  function fillOf(instance, index) {
    var declared = instance.series[index].fill;
    var value = typeof declared === "function" ? declared(instance, index) : declared;
    return value === null || value === undefined || value === "" ? "none" : String(value);
  }
  /*
   * How much of a series was plotted, and in how many unbroken runs.
   *
   * The one property that separates a line from a scatter of dots, and it
   * was in nothing this walk collected. The page breaks a line at every
   * null on purpose, so the run count is the whole shape of the drawing:
   * one run is a continuous line, and a run per measured step is the same
   * card rendered as loose points. A card that must not join across gaps
   * and a card that must hold across them produce identical fills, y
   * ranges, x ranges, canvas sizes and captions, so a step asserting either
   * one was asserting something the report could not show — the same gap
   * that let a card draw an axis to 2029 unnoticed, in the other direction.
   *
   * Read off the instance's own data rather than the values the page built,
   * so it reports what was handed to the canvas.
   */
  function strokeOf(instance, index) {
    var values = instance.data[index];
    var label = instance.series[index].label;
    if (values === undefined || values === null) return label + ": no data";
    var drawn = 0;
    var runs = 0;
    var inRun = false;
    for (var i = 0; i < values.length; i++) {
      var present = values[i] !== null && values[i] !== undefined;
      if (present) {
        drawn += 1;
        if (!inRun) runs += 1;
      }
      inRun = present;
    }
    return label + ": " + drawn + " of " + values.length + " in " +
      runs + (runs === 1 ? " run" : " runs");
  }
  function figureOf(scope) {
    var value = scope.querySelector(".stat-value");
    if (value === null) return null;
    var chip = scope.querySelector(".stat-delta");
    return {
      /* The element the figure is presented as, and where it points.
       *
       * Task 9's lead figures are links rather than divs, so that the three
       * numbers at the top of the page are keyboard reachable and announced
       * as the table of contents they are. Nothing else in this report can
       * tell an anchor from a div: the label, value, sub and chip of a lead
       * figure and of a div-shaped one are identical, so a step asserting
       * the presentation was asserting something the walk never collected. */
      tag: scope.tagName,
      href: scope.getAttribute("href"),
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
    var instance = null;
    for (var p = 0; p < syncPlots.length; p++) {
      if (syncPlots[p].root === root) { instance = syncPlots[p]; break; }
    }
    var fills = null;
    var strokes = null;
    var yRange = null;
    var xRange = null;
    if (instance !== null) {
      fills = [];
      strokes = [];
      for (var s = 1; s < instance.series.length; s++) {
        fills.push(instance.series[s].label + ": " + fillOf(instance, s));
        strokes.push(strokeOf(instance, s));
      }
      var scale = instance.scales.y;
      yRange = scale === undefined || scale === null ? null : [scale.min, scale.max];
      /*
       * The span the plot actually DREW, as days, beside the span the card
       * says it drew in its meta line.
       *
       * The two can disagree, and the disagreement is invisible in every
       * other reading this walk collects. Handed a single point on a time
       * scale uPlot invents an x range of its own: a card whose meta line
       * says one measured day rendered an axis running to 2029-05-01, and
       * the canvas width, the canvas height, the y range, the legend and
       * the note were all exactly what a correct card produces. Without
       * this field a step asserting that a card refuses to plot a lone
       * point is asserting something the report cannot show.
       */
      var xscale = instance.scales.x;
      xRange = xscale === undefined || xscale === null ? null : [
        new Date(xscale.min * 1000).toISOString().slice(0, 10),
        new Date(xscale.max * 1000).toISOString().slice(0, 10)
      ];
    }
    return {
      /* Null for all three means this plot was not found in the sync group at
       * all, which is a broken reading rather than a plot with no fill and no
       * scales. */
      fills: fills,
      strokes: strokes,
      yRange: yRange,
      xRange: xRange,
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
    /* The amber subset, separately.
     *
     * A caution carries .chart-hint too, so a note that lost its amber class
     * and a note that never had one produce the same hints array: the page can
     * silently downgrade "be careful reading this" to "here is some
     * background" with nothing in the report changing. That happened three
     * times while the four groups were built, once per group that routed an
     * inherited caution through the shared note channel.
     *
     * No backtick anywhere in here: this comment lives inside the OBSERVE
     * template literal. */
    var cautions = [];
    card.querySelectorAll(".chart-caution").forEach(function (h) { cautions.push(text(h)); });
    /* EVERY .chart-meta in the card, not only the first.
     *
     * A card can carry more than one: its own span line, and then a release
     * caption appended after it. querySelector returns the span line, so a
     * report reading only that cannot see the caption at all, and a step
     * asserting the caption would be asserting something this walk never
     * collected. Proved by mutation during Task 2's review: changing the
     * caption's "releases marked" literal left the report byte-identical.
     *
     * meta stays the first for every existing reader, and metas carries the
     * whole list beside it. */
    var metas = [];
    card.querySelectorAll(".chart-meta").forEach(function (m) { metas.push(text(m)); });
    /* EVERY .stat-note in the card, and every link in it.
     *
     * figureOf reads only the first .stat-note, which is the figure head's own
     * note, so a standing caveat rendered in the same idiom below the head was
     * invisible to this walk: a card carrying one and a card carrying none
     * produced the same report. The Reach clones card is the first to carry
     * one, and its whole job is to name a confound and point at the chart that
     * measures it, so the link target is collected beside the text rather than
     * clicked for by hand.
     *
     * No backtick anywhere in here: this comment lives inside the OBSERVE
     * template literal, so one would end the string and take the file's syntax
     * with it. */
    var statNotes = [];
    card.querySelectorAll(".stat-note").forEach(function (n) { statNotes.push(text(n)); });
    var links = [];
    card.querySelectorAll("a[href]").forEach(function (a) {
      links.push(a.getAttribute("href") + " " + text(a));
    });
    var entry = {
      title: text(card.querySelector(".chart-title")),
      titleTag: card.querySelector(".chart-title") === null
        ? null : card.querySelector(".chart-title").tagName,
      compact: card.classList.contains("is-compact"),
      meta: metas.length === 0 ? null : metas[0],
      metas: metas,
      note: text(card.querySelector(".slot-note")),
      statNotes: statNotes,
      links: links,
      hints: hints,
      cautions: cautions,
      figure: figureOf(card),
      plot: plotOf(card),
      rows: []
    };
    /* A rank row need not carry a bar. A ranking row does, and its width is
     * the whole point of measuring it, but a dated list row is the same kind
     * of row with a date where the bar would be. Reading the bar unguarded
     * would throw, and an expression that throws takes the entire report down
     * without saying so. */
    card.querySelectorAll(".rank-row").forEach(function (row) {
      var fill = row.querySelector(".rank-fill");
      entry.rows.push({
        rank: text(row.querySelector(".rank-n")),
        name: text(row.querySelector(".rank-name")),
        num: text(row.querySelector(".rank-num")),
        sub: text(row.querySelector(".rank-sub")),
        width: fill === null ? null : Math.round(fill.getBoundingClientRect().width),
        fill: fill === null ? null : getComputedStyle(fill).backgroundColor
      });
    });
    return entry;
  }
  var out = {
    slots: [], syncPlots: syncPlots.length, chartRoots: document.querySelectorAll(".uplot").length,
    head: null, provenance: null, hint: null, nav: [], sections: []
  };
  /* The page's own headline claim, and the four provenance values under
   * #method. Both are read here rather than proved out of band: Task 3 changed
   * the lead sentence and had to establish it by grep, and read the provenance
   * strip out of a throwaway DOM dump, so neither fact reached the report a
   * reviewer actually reads. pv-since is the one of the four that moves with
   * the archive rather than with the collector's clock. */
  var head = document.querySelector(".page-head");
  out.head = head === null ? null : { lead: text(head.querySelector(".lead")) };
  /*
   * The paragraph the bundler writes into the served page.
   *
   * It is the only place on this page a headline figure is computed by
   * something other than the page's own figure surface: renderSummaryHtml
   * sums the traffic series in TypeScript, the lead row sums the same series
   * in the page's JavaScript, and the two are supposed to be the same number.
   * Two implementations of one figure in two languages is exactly the shape
   * INSIGHTS_FIGURES exists to prevent for the row and the group heads, so
   * the one case that cannot be collapsed gets checked instead.
   *
   * No backticks anywhere in this string: it is the body of a template
   * literal, and one backtick in a comment ends the expression mid-way and
   * fails the whole script at parse time.
   */
  var summary = document.querySelector(".static-figures");
  out.staticFigures = summary === null ? null : text(summary);
  out.provenance = {
    since: text(document.getElementById("pv-since")),
    generated: text(document.getElementById("pv-generated")),
    lastRun: text(document.getElementById("pv-lastrun")),
    lastSuccess: text(document.getElementById("pv-lastsuccess"))
  };
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
    /* Any standing note in the slot, at any depth, EXCEPT one that belongs to
     * a card: cardOf already reports those, and counting them twice would
     * make a card's note read as a slot's. Depth matters because a slot's
     * content can be wrapped in bands, and a note the report cannot see is,
     * for review purposes, a note that does not exist. */
    slot.querySelectorAll(".slot-note, .slot-note-detail").forEach(function (n) {
      if (n.closest(".chart-card") === null) entry.notes.push(text(n));
    });
    slot.querySelectorAll(".lead-figure, .group-head").forEach(function (box) {
      entry.figures.push(figureOf(box));
    });
    slot.querySelectorAll(".chart-card").forEach(function (card) {
      entry.cards.push(cardOf(card));
    });
    out.slots.push(entry);
  });
  return out;
})()`;

/* The names of the page's range buttons, in the order they are offered. */
const RANGE_LABELS = `Array.prototype.map.call(
  document.querySelectorAll(".range-btn"), function (b) { return b.textContent.trim(); })`;

/*
 * Clicks one range button by its label and says what happened. A disabled
 * button is reported as such rather than as a click, because a click that
 * did nothing would make "the rankings did not move" true for the wrong
 * reason.
 */
function clickRange(label) {
  return `(function () {
  var hit = null;
  document.querySelectorAll(".range-btn").forEach(function (b) {
    if (b.textContent.trim() === ${JSON.stringify(label)}) hit = b;
  });
  if (hit === null) return "missing";
  if (hit.disabled) return "disabled";
  hit.click();
  return "clicked";
})()`;
}

/* Just the ranking rows, as one comparable string per card. The rankings are
 * a snapshot rather than a window, so this must not move when the range
 * does. */
const RANKING_DIGEST = `(function () {
  function text(node) {
    return node === null ? "" : node.textContent.replace(/\\s+/g, " ").trim();
  }
  var out = [];
  document.querySelectorAll(".slot .chart-card").forEach(function (card) {
    var rows = [];
    card.querySelectorAll(".rank-row").forEach(function (row) {
      rows.push(text(row.querySelector(".rank-n")) + " " +
        text(row.querySelector(".rank-name")) + " " +
        text(row.querySelector(".rank-num")));
    });
    if (rows.length > 0) {
      out.push(text(card.querySelector(".chart-title")) + ": " + rows.join(" | "));
    }
  });
  return out;
})()`;

/*
 * The archive coverage line, read once per range button.
 *
 * `OBSERVE` runs once, before the range sweep, so it can say what the
 * coverage line reads at the range the page opened on and nothing more. The
 * one thing that has to be true of this line is that it MOVES with the
 * control: a coverage line that is identical at `30d` and at `all` means the
 * section is not re-rendering on a range change, which is a silent failure of
 * exactly the kind this script exists to catch. Null until the page has a
 * `method-coverage` slot to read.
 */
const METHOD_COVERAGE = `(function () {
  var slot = document.getElementById("method-coverage");
  return slot === null ? null : slot.textContent.replace(/\\s+/g, " ").trim();
})()`;

/*
 * What every chart card on the page says it actually drew, read once per range
 * button.
 *
 * This column used to read the first `.chart-window` line on the page. That
 * reading is being deleted out from under it: spec section 7.3 removes the
 * window line from every group, so after Task 6 the selector silently stopped
 * matching Reach and started matching Growth, and Task 7 takes Growth with it.
 * A column pointed at markup the plan is removing prints an ever more
 * misleading value and then an empty one, under a heading that reads like a
 * result. That is the failure this script exists to rule out.
 *
 * A card's own span line is the replacement, and it is the reading the page is
 * moving TOWARDS rather than away from: every card built through `chartCard`
 * emits a `.chart-meta` whose first pair is `span <first> -> <last>`, or
 * `window <from> -> <to>` on the one branch where the card drew nothing and
 * has no span of its own to state. Both are collected, under the key the page
 * used, so the difference between "this is what I drew" and "I drew nothing
 * across this window" stays visible.
 *
 * It moves with the range, which is the one property this column exists for,
 * and it is keyed by slot id and card title, so it can never be read as
 * belonging to a group it does not belong to the way the old single reading
 * was. It goes empty only when the page draws no chart card at all, which is
 * `dimensions-only` and is legitimate, and the report says so in words rather
 * than printing a blank.
 */
const CARD_SPANS = `(function () {
  function text(node) {
    return node === null ? "" : node.textContent.replace(/\\s+/g, " ").trim();
  }
  var out = [];
  document.querySelectorAll(".slot .chart-card").forEach(function (card) {
    var meta = card.querySelector(".chart-meta");
    if (meta === null) return;
    var stated = null;
    meta.querySelectorAll(":scope > span").forEach(function (pair) {
      if (stated !== null) return;
      var key = text(pair.querySelector(".k"));
      if (key === "span" || key === "window") {
        stated = key + " " + text(pair.querySelector(".v"));
      }
    });
    if (stated === null) return;
    var slot = card.closest(".slot");
    out.push((slot === null ? "?" : slot.id) + " / " +
      text(card.querySelector(".chart-title")) + ": " + stated);
  });
  return out;
})()`;

/* A cheap stable digest of every chart canvas on the page, keyed by a path to
 * its card. Used to see whether a drag on one chart redrew the others. */
const CANVAS_HASHES = `(function () {
  var out = {};
  document.querySelectorAll(".uplot").forEach(function (root, i) {
    var canvas = root.querySelector("canvas");
    if (canvas === null) return;
    var url = canvas.toDataURL();
    var h = 5381;
    for (var j = 0; j < url.length; j++) h = ((h * 33) ^ url.charCodeAt(j)) >>> 0;
    var card = root.closest(".chart-card");
    var section = root.closest(".slot");
    var title = card === null ? null : card.querySelector(".chart-title");
    out[i + " " + (section === null ? "?" : section.id) + " / " +
        (title === null ? "?" : title.textContent)] = h;
  });
  return out;
})()`;

/*
 * Drags across the first chart on the page, far enough to pass uPlot's 6px
 * drag threshold, so `cursor.drag.setScale` fires.
 *
 * `movementX` has to be set. While a drag is in progress uPlot discards any
 * move whose `movementX` and `movementY` are both zero, and a synthetic
 * `MouseEvent` reports zero for both unless it is asked not to. Without it
 * the selection stays at zero width, uPlot drops the drag, and the run
 * reports "nothing moved" for a reason that has nothing to do with the page.
 * A frame is awaited between the events for the same care.
 */
const DRAG_FIRST_CHART = `(async function () {
  var over = document.querySelector(".slot .uplot .u-over");
  if (over === null) return "no chart to drag";
  var box = over.getBoundingClientRect();
  if (box.width < 60) return "the first chart is too narrow to drag across";
  var y = box.top + box.height / 2;
  var from = box.left + box.width * 0.30;
  var to = box.left + box.width * 0.70;
  function frame() {
    return new Promise(function (r) { requestAnimationFrame(function () { r(); }); });
  }
  var last = from;
  function fire(target, type, x) {
    target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window,
      clientX: x, clientY: y, button: 0, buttons: type === "mouseup" ? 0 : 1,
      movementX: Math.round(x - last), movementY: 0
    }));
    last = x;
  }
  fire(over, "mousedown", from);
  await frame();
  fire(over, "mousemove", from + 20);
  await frame();
  await frame();
  fire(over, "mousemove", to);
  await frame();
  await frame();
  var select = document.querySelector(".slot .uplot .u-select");
  var width = select === null ? 0 : Math.round(select.getBoundingClientRect().width);
  fire(document, "mouseup", to);
  await frame();
  return "dragged from " + Math.round(from) + " to " + Math.round(to) +
    ", selection " + width + "px wide at mouseup";
})()`;

/*
 * Where the page's landmarks sit against a real viewport.
 *
 * The walk above runs in a 1440x2400 window on purpose, so that nothing is
 * clipped and every card lays out at its natural size. That window also makes
 * one whole class of defect unobservable: a laptop is 900 tall, not 2400, and
 * nothing in the report could say whether a reader lands with the range
 * control on screen or below it. The answer was argued from the CSS for a
 * while and belongs in a measurement.
 *
 * Run last, with the viewport overridden, because resizing re-lays out every
 * plot on the page and a re-laid-out plot is a worse thing to hash or drag.
 */
/*
 * The viewports the first screen is measured at.
 *
 * 1440x900 is the common laptop and the one the layout was argued about;
 * 1280x720 is the short end of what a desktop reader turns up with. Both are
 * CSS pixels, which is what the layout is written in.
 */
const FOLD_VIEWPORTS = [[1440, 900], [1280, 720]];

const FOLD = `(function () {
  var height = window.innerHeight;
  function mark(name, node) {
    if (node === null) return { name: name, top: null, visible: null };
    var top = Math.round(node.getBoundingClientRect().top + window.scrollY);
    return { name: name, top: top, visible: top < height };
  }
  return {
    viewport: [window.innerWidth, height],
    marks: [
      mark("lead row", document.getElementById("lead-figures")),
      mark("built summary", document.querySelector(".static-figures")),
      mark("range control", document.getElementById("rangectl")),
      mark("first group", document.getElementById("reach"))
    ]
  };
})()`;

async function main() {
  const chrome = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (chrome === undefined) {
    console.error('no Chrome or Chromium found. Looked at:\n  ' + CHROME_CANDIDATES.join('\n  '));
    process.exit(1);
  }

  const { server, port } = await serve(siteDir);
  const profile = await mkdtemp(path.join(tmpdir(), 'insights-check-'));
  const debugPort = 9222 + Math.floor(Math.random() * 500);
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--window-size=1440,2400',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let client = null;
  let observed = null;
  let dragResult = null;
  let before = null;
  let after = null;
  const ranges = [];
  const folds = [];
  try {
    const target = await poll(async () => {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page === undefined) throw new Error('no page target yet');
      return page;
    }, 60, 250);

    client = connect(target.webSocketDebuggerUrl, onEvent);
    await client.ready;

    /*
     * One `Runtime.evaluate`, with an exception inside the page turned into a
     * thrown error rather than an undefined result.
     *
     * This is the guard that matters most in the whole file. CDP reports an
     * expression that threw in the command REPLY, as `exceptionDetails`, and
     * NOT as a `Runtime.exceptionThrown` event. Reading `result.value` alone
     * therefore yields `undefined` for a broken expression while the console
     * stays clean, no request fails, and `--prove-console` still passes: the
     * run reports a perfectly healthy page whose entire observation is
     * missing. It is worse than a blank report, because a comparison of two
     * undefined results reads as "identical" and prints as a pass.
     *
     * Every expression in this file walks the whole page now, so one
     * unguarded selector against markup a later section introduces would
     * empty the report that is the only evidence the page works. The
     * individual null guards above are the first line; this is the one that
     * cannot be forgotten when a new expression is added.
     */
    const evaluate = async (expression, awaitPromise) => {
      const reply = await client.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: awaitPromise === true,
      });
      if (reply.exceptionDetails !== undefined) {
        const detail = reply.exceptionDetails;
        throw new Error('an expression threw inside the page, so its observation is missing: '
          + (detail.exception?.description ?? detail.text));
      }
      return reply.result.value;
    };
    await client.send('Runtime.enable');
    await client.send('Log.enable');
    await client.send('Network.enable');
    await client.send('Page.enable');
    if (proveConsole) {
      // In the page and before any page script, so seeing it back proves the
      // listeners are attached to the document that renders the dashboard.
      await client.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `console.warn(${JSON.stringify(PROBE)});`,
      });
    }

    const url = `http://127.0.0.1:${port}/insights/`;
    /*
     * Gate on the navigated frame reporting that it stopped loading, not on
     * `document.readyState`. The browser starts on `about:blank`, which is
     * already `complete`, so a poll started before the navigation lands reads
     * the OLD document and answers immediately. Everything after it would then
     * be measured against a blank page: no console messages, no failed
     * requests, and a clean run reported for a page that was never loaded.
     * That is the one failure this whole script exists to rule out.
     */
    stoppedFrames.clear();
    const navigation = await client.send('Page.navigate', { url });
    if (navigation.errorText !== undefined) {
      throw new Error(`navigation to ${url} failed: ${navigation.errorText}`);
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        onFrameStopped = null;
        reject(new Error(`${url} did not finish loading within 30s`));
      }, 30000);
      const check = () => {
        if (!stoppedFrames.has(navigation.frameId)) return;
        clearTimeout(timer);
        onFrameStopped = null;
        resolve();
      };
      onFrameStopped = check;
      // The event may already have been buffered while `Page.navigate` was in
      // flight, in which case no further one is coming.
      check();
    });

    /*
     * The page fetches `data.json` after load and renders from the reply, so
     * the load event is not the end of the story. Wait for the section to
     * actually hold something rather than sleeping a guessed interval, then
     * give uPlot one short settle for its first paint.
     */
    const drawn = Date.now();
    for (;;) {
      const ready = await evaluate(
        '(function () { var s = document.querySelectorAll(".slot");'
        + ' for (var i = 0; i < s.length; i++) { if (s[i].children.length > 0) return true; }'
        + ' return false; })()',
      );
      if (ready === true) break;
      if (Date.now() - drawn > 20000) {
        throw new Error('no slot on the page held anything 20s after load');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 600));

    observed = await evaluate(OBSERVE);

    // The range sweep runs before the drag, because the drag rescales every
    // chart on the page and a rescaled chart is a worse place to start.
    const labels = await evaluate(RANGE_LABELS);
    for (const label of labels) {
      const outcome = await evaluate(clickRange(label));
      await new Promise((r) => setTimeout(r, 400));
      ranges.push({
        label,
        outcome,
        spans: await evaluate(CARD_SPANS),
        rankings: await evaluate(RANKING_DIGEST),
        coverage: await evaluate(METHOD_COVERAGE),
      });
    }

    before = await evaluate(CANVAS_HASHES);
    dragResult = await evaluate(DRAG_FIRST_CHART, true);
    await new Promise((r) => setTimeout(r, 700));
    after = await evaluate(CANVAS_HASHES);

    try {
      for (const [width, height] of FOLD_VIEWPORTS) {
        await client.send('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: 1, mobile: false,
        });
        // The page's own resize handling is throttled through a ResizeObserver,
        // so a reading taken immediately measures the previous layout.
        await new Promise((r) => setTimeout(r, 500));
        folds.push(await evaluate(FOLD));
      }
    } finally {
      // However this block ends. The override outlives the loop otherwise, and
      // anything added after it would be measuring a 1280x720 page while
      // reporting as though it were the walk's own window.
      await client.send('Emulation.clearDeviceMetricsOverride');
    }
  } finally {
    if (client !== null) client.close();
    child.kill();
    // Chrome holds keep-alive sockets, and `close` alone waits for them, so
    // the run would hang on a browser that is slow to die.
    server.closeAllConnections();
    server.close();
    /*
     * Chrome can still be flushing its profile when it is killed, and the
     * rmdir then fails with ENOTEMPTY. Thrown out of a `finally` that would
     * discard the entire report the run just spent twenty seconds gathering,
     * and the run reads as a hard failure of the page rather than of the
     * cleanup. The directory is under the OS temp dir, so leaving one behind
     * costs nothing worth a lost report. Reported on stderr so it can never
     * appear in a captured report and read as a difference between two runs.
     */
    try {
      await rm(profile, { recursive: true, force: true });
    } catch (error) {
      console.error(`could not remove the temporary Chrome profile ${profile}: ${error.message}`);
    }
  }

  console.log('=== console and network ===');
  console.log(`console messages: ${console_.length}`);
  for (const m of console_) console.log(`  [${m.source}] ${m.text}`);
  console.log(`failed or 4xx/5xx requests: ${failures.length}`);
  for (const f of failures) console.log(`  ${f}`);

  console.log('\n=== page ===');
  /*
   * Said before the walk rather than left to be inferred from it. `fills`,
   * `strokes`, `yRange` and `xRange` come off the live uPlot instances, and
   * the only way to reach those is the page's own cursor-sync group. If the
   * page ever stops registering its plots under that key, every card would
   * report a null fill and a null y range, which reads exactly like a page
   * that draws no fills. This line is the difference between the two.
   */
  if (observed !== null) {
    const roots = observed.chartRoots ?? 0;
    const synced = observed.syncPlots ?? 0;
    if (roots > 0 && synced === 0) {
      console.log(`  NO PLOT REACHED: ${roots} chart roots are on the page and none of them is in`
        + ' the cursor-sync group, so every fill, stroke, y range and drawn span below is null'
        + ' for that reason and not because the page declared none');
    } else {
      console.log(`  ${synced} live plot(s) in the cursor-sync group, ${roots} chart root(s)`
        + ' in the document');
    }
  }
  console.log(JSON.stringify(observed, null, 2));

  /*
   * A verdict is only printed over a reading that was actually taken.
   *
   * "Rankings identical to the first range" is the PASS wording for this
   * check, so printing it after a walk that matched nothing is the worst
   * output this script can produce: four green lines over a comparison of two
   * empty arrays, under a `console capture proof: PASS`, at exit 0. An
   * expression that throws can no longer reach the report, but an expression
   * whose selectors quietly stop matching returns an honest empty array, and
   * Tasks 4 to 8 rebuild every card on the page, so a renamed `.rank-row` is
   * not a hypothetical. The same reasoning covers a page that offered no
   * range button and a page whose charts have no canvas: in both cases the
   * loop below would print nothing at all and the heading alone would read as
   * a section that passed.
   */
  console.log('\n=== range sweep ===');
  const first = ranges[0]?.rankings;
  const noRankings = !Array.isArray(first) || first.length === 0;
  if (ranges.length === 0) {
    console.log('  NOTHING SWEPT: the page offered no range button, so no range was exercised');
  }
  for (const r of ranges) {
    const verdict = noRankings
      ? 'NO RANKING ROWS TO COMPARE'
      : `rankings ${JSON.stringify(r.rankings) === JSON.stringify(first) ? 'identical to the first range' : 'CHANGED'}`;
    console.log(`  ${r.label} (${r.outcome}): ${verdict}`);
    console.log(`    method coverage: ${r.coverage === null ? '(no method-coverage slot)' : r.coverage}`);
    if (r.spans.length === 0) {
      console.log('    card spans: NO CHART CARD ON THE PAGE STATED A SPAN, so this range'
        + ' changed nothing this column can see');
    }
    for (const span of r.spans) console.log(`    card span: ${span}`);
  }
  if (ranges.length > 0 && noRankings) {
    console.log('  NO RANKING ROWS FOUND ANYWHERE ON THE PAGE: the verdicts above compared nothing.');
    console.log('  Either no card ranks anything, or the ranking walk stopped matching the markup.');
  }
  console.log('  rankings seen: ' + JSON.stringify(first ?? null, null, 2));

  console.log('\n=== served figures against the drawn ones ===');
  /*
   * `renderSummaryHtml` restates, in TypeScript, figures the page also
   * computes for itself in JavaScript. A reader without JavaScript sees only
   * the first; a reader with it sees only the second; nobody sees both at
   * once, so a divergence between them is invisible on the page by
   * construction and has to be caught here.
   *
   * EVERY figure stated on both sides is listed below. An earlier version
   * compared two of them and a comment beside it claimed there were only two,
   * which is the same class of error as a check that measures nothing: the
   * report looked complete while five duplicated figures went unread. Adding
   * a figure to `buildSummary` that the page also draws means adding a row
   * here.
   *
   * Matched on the wording the paragraph uses, never on position: the
   * paragraph drops a clause whenever its measurement is missing, and every
   * clause after it shifts up. The nouns take an optional plural because the
   * paragraph says "1 watcher" and "7 watchers".
   */
  /*
   * A grouped number, and NOT `[0-9,]+`, which was the first version of this
   * and swallowed the comma that follows "Releases shipped: 1," in the
   * paragraph. It captured `1,` against a drawn `1` and reported DIVERGED on
   * a page where nothing had diverged. Cheap to laugh at, except that the
   * same greed on a clause ending in a number would have gone the other way
   * and matched something true by accident.
   */
  const NUM = '([0-9]{1,3}(?:,[0-9]{3})*)';
  const PAIRED_FIGURES = [
    [new RegExp(`Page views: ${NUM}`), 'Page views'],
    [new RegExp(`Clones: ${NUM}`), 'Repository clones'],
    [new RegExp(`${NUM} stars?\\b`), 'Stars'],
    [new RegExp(`${NUM} forks?\\b`), 'Forks'],
    [new RegExp(`${NUM} watchers?\\b`), 'Watchers'],
    [new RegExp(`${NUM} contributors?\\b`), 'Contributors'],
    [new RegExp(`App downloads: ${NUM}`), 'App downloads'],
    [new RegExp(`Releases shipped: ${NUM}`), 'Releases shipped'],
  ];
  const servedFigure = (pattern) => {
    const text = observed?.staticFigures ?? null;
    if (text === null) return null;
    const m = pattern.exec(text);
    return m === null ? null : m[1];
  };
  /*
   * A figure with no measurement behind it renders as the page's dash, which
   * is a non-empty string and would otherwise be reported as a drawn value.
   * Only a printed number counts on either side.
   */
  const numeric = (value) =>
    typeof value === 'string' && /^[0-9,]+$/.test(value) ? value : null;
  const drawnFigure = (label) => {
    for (const slot of observed?.slots ?? []) {
      for (const fig of slot.figures ?? []) if (fig.label === label) return numeric(fig.value);
      for (const card of slot.cards ?? []) {
        if (card.title === label && card.figure !== null) return numeric(card.figure.value);
      }
    }
    return null;
  };
  for (const [pattern, drawnLabel] of PAIRED_FIGURES) {
    const served = servedFigure(pattern);
    const drawn = drawnFigure(drawnLabel);
    /*
     * Three outcomes, not two. Neither side stating a value is an archive
     * with nothing to state, which is fine. ONE side stating one is already a
     * divergence — the two disagree about whether the figure is measurable —
     * and it is also what a renamed card title looks like, which would
     * otherwise retire a comparison silently while the report stayed green.
     */
    if (served === null && drawn === null) {
      console.log(`  ${drawnLabel}: not compared, neither side states a value`);
    } else if (served === null || drawn === null) {
      console.log(`  ${drawnLabel}: ONE-SIDED, the served paragraph states `
        + `${served ?? 'nothing'} and the page draws ${drawn ?? 'nothing'}`
        + ' — either they disagree about what was measured, or this comparison'
        + ' has lost the element it reads');
    } else {
      console.log(`  ${drawnLabel}: served ${served}, drawn ${drawn}`
        + (served === drawn ? ' — MATCH' : ' — DIVERGED, one of the two is wrong'));
    }
  }

  console.log('\n=== first screen ===');
  if (folds.length === 0) {
    console.log('  not measured: the run ended before the viewport sweep');
  }
  for (const fold of folds) {
    console.log(`  ${fold.viewport[0]}x${fold.viewport[1]}`);
    for (const m of fold.marks) {
      if (m.top === null) {
        console.log(`    ${m.name}: not on the page`);
        continue;
      }
      console.log(`    ${m.name}: ${m.top}px from the top of the document, `
        + `${m.visible ? 'on the first screen' : 'BELOW THE FOLD'}`);
    }
  }

  console.log('\n=== zoom sync ===');
  console.log(`drag (first chart on the page): ${dragResult}`);
  const canvasKeys = Object.keys(after ?? {});
  if (canvasKeys.length === 0) {
    console.log('  NO CHART CANVAS FOUND ON THE PAGE: nothing was compared across the drag');
  }
  for (const key of canvasKeys) {
    const moved = before?.[key] !== after[key];
    console.log(`  ${moved ? 'redrew' : 'unchanged'}  ${key}  ${before?.[key]} -> ${after[key]}`);
  }

  if (proveConsole) {
    const seen = console_.some((m) => m.text.includes(PROBE));
    console.log(`\nconsole capture proof: ${seen ? 'PASS, the probe came back' : 'FAIL, the probe never arrived'}`);
    if (!seen) process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
