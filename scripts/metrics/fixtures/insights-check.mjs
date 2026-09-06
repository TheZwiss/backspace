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
      if (message.error) entry.reject(new Error(`${message.method}: ${message.error.message}`));
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
      var fill = row.querySelector(".rank-fill");
      entry.rows.push({
        rank: text(row.querySelector(".rank-n")),
        name: text(row.querySelector(".rank-name")),
        num: text(row.querySelector(".rank-num")),
        width: Math.round(fill.getBoundingClientRect().width),
        fill: getComputedStyle(fill).backgroundColor
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
  var out = [];
  document.querySelectorAll(".slot .chart-card").forEach(function (card) {
    var rows = [];
    card.querySelectorAll(".rank-row").forEach(function (row) {
      rows.push(row.querySelector(".rank-n").textContent + " " +
        row.querySelector(".rank-name").textContent + " " +
        row.querySelector(".rank-num").textContent);
    });
    if (rows.length > 0) out.push(card.querySelector(".chart-title").textContent + ": " + rows.join(" | "));
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
    out[i + " " + (section === null ? "?" : section.id) + " / " +
        (card === null ? "?" : card.querySelector(".chart-title").textContent)] = h;
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
  try {
    const target = await poll(async () => {
      const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page === undefined) throw new Error('no page target yet');
      return page;
    }, 60, 250);

    client = connect(target.webSocketDebuggerUrl, onEvent);
    await client.ready;
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
      const ready = (await client.send('Runtime.evaluate', {
        expression: '(function () { var s = document.querySelectorAll(".slot");'
          + ' for (var i = 0; i < s.length; i++) { if (s[i].children.length > 0) return true; }'
          + ' return false; })()',
        returnByValue: true,
      })).result.value;
      if (ready === true) break;
      if (Date.now() - drawn > 20000) {
        throw new Error('no slot on the page held anything 20s after load');
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 600));

    observed = (await client.send('Runtime.evaluate', {
      expression: OBSERVE, returnByValue: true, awaitPromise: false,
    })).result.value;

    // The range sweep runs before the drag, because the drag rescales every
    // chart on the page and a rescaled chart is a worse place to start.
    const evaluate = async (expression) =>
      (await client.send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
    const labels = await evaluate(RANGE_LABELS);
    for (const label of labels) {
      const outcome = await evaluate(clickRange(label));
      await new Promise((r) => setTimeout(r, 400));
      ranges.push({
        label,
        outcome,
        window: await evaluate('(document.querySelector(".slot .chart-window") || { textContent: "" })'
          + '.textContent.replace(/\\s+/g, " ").trim()'),
        rankings: await evaluate(RANKING_DIGEST),
      });
    }

    before = (await client.send('Runtime.evaluate', {
      expression: CANVAS_HASHES, returnByValue: true,
    })).result.value;
    dragResult = (await client.send('Runtime.evaluate', {
      expression: DRAG_FIRST_CHART, returnByValue: true, awaitPromise: true,
    })).result.value;
    await new Promise((r) => setTimeout(r, 700));
    after = (await client.send('Runtime.evaluate', {
      expression: CANVAS_HASHES, returnByValue: true,
    })).result.value;
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
  console.log(JSON.stringify(observed, null, 2));

  console.log('\n=== range sweep ===');
  const first = ranges[0]?.rankings;
  for (const r of ranges) {
    const same = JSON.stringify(r.rankings) === JSON.stringify(first);
    console.log(`  ${r.label} (${r.outcome}): rankings ${same ? 'identical to the first range' : 'CHANGED'}; ${r.window}`);
  }
  console.log('  rankings seen: ' + JSON.stringify(first, null, 2));

  console.log('\n=== zoom sync ===');
  console.log(`drag (first chart on the page): ${dragResult}`);
  for (const key of Object.keys(after ?? {})) {
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
