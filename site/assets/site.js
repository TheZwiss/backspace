(function () {
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var root = document.documentElement;
  if (!reduced) root.classList.add("js");

  /* ---- scroll reveals ---- */
  var revealEls = document.querySelectorAll(".reveal");
  if (!reduced && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
    revealEls.forEach(function (el) { io.observe(el); });
  } else {
    revealEls.forEach(function (el) { el.classList.add("in"); });
  }

  /* ---- live project figures, read from the insights bundle ----
     Deliberately placed above the reduced-motion return: these are content,
     not animation, and must load for every visitor.

     The governing rule matches the dashboard's: a figure that was never
     measured is left out entirely, never rendered as a zero. The archive
     writes null for a value it did not record, and a 0 printed here would be
     indistinguishable from a real measurement of nothing. Coverage is stated
     per figure, because the series do not all start on the same day. */
  (function () {
    var host = document.getElementById("nums");
    var note = document.getElementById("nums-note");
    if (!host || !note) return;

    function lastValue(series, field) {
      if (!series || !Array.isArray(series[field])) return null;
      var v = series[field];
      for (var i = v.length - 1; i >= 0; i--) {
        if (v[i] !== null && v[i] !== undefined) return v[i];
      }
      return null;
    }
    function sum(series, field) {
      if (!series || !Array.isArray(series[field])) return null;
      var v = series[field], acc = null;
      for (var i = 0; i < v.length; i++) {
        if (v[i] === null || v[i] === undefined) continue;
        acc = (acc === null ? 0 : acc) + v[i];
      }
      return acc;
    }
    function edgeDate(series, first) {
      if (!series || !Array.isArray(series.dates) || !series.dates.length) return null;
      return first ? series.dates[0] : series.dates[series.dates.length - 1];
    }
    function card(value, label, coverage) {
      var el = document.createElement("div");
      el.className = "num";
      var b = document.createElement("b");
      b.textContent = value.toLocaleString(document.documentElement.lang || "en");
      var s = document.createElement("span");
      s.textContent = label;
      el.appendChild(b);
      el.appendChild(s);
      if (coverage) {
        var i = document.createElement("i");
        i.textContent = coverage;
        el.appendChild(i);
      }
      return el;
    }

    fetch(host.dataset.src, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (d) {
        if (!d || d.empty || !d.series) throw new Error("archive holds no rows");
        var cards = [];
        var stars = lastValue(d.series.stars, "total");
        var views = sum(d.series.views, "count");
        var clones = sum(d.series.clones, "count");
        var starsOn = edgeDate(d.series.stars, false);
        var viewsFrom = edgeDate(d.series.views, true);
        var clonesFrom = edgeDate(d.series.clones, true);
        if (stars !== null) {
          cards.push(card(stars, host.dataset.stars, starsOn ? host.dataset.asof + starsOn : null));
        }
        if (views !== null) {
          cards.push(card(views, host.dataset.views, viewsFrom ? host.dataset.since + viewsFrom : null));
        }
        if (clones !== null) {
          cards.push(card(clones, host.dataset.clones, clonesFrom ? host.dataset.since + clonesFrom : null));
        }
        if (!cards.length) throw new Error("nothing measured yet");
        for (var i = 0; i < cards.length; i++) host.appendChild(cards[i]);
        host.hidden = false;
        note.textContent = note.dataset.note;
        note.hidden = false;
      })
      .catch(function () {
        /* No figures rather than invented ones. The link below still reaches
           the archive, which states its own condition when it cannot load. */
        note.textContent = note.dataset.noteError;
        note.hidden = false;
      });
  })();

  if (reduced) {
    var j = document.getElementById("vu-jonas");
    if (j) j.hidden = false;
    return;
  }

  /* ---- hero chat sequence ---- */
  var typing = document.getElementById("typing");
  var typingWho = document.getElementById("typing-who");
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function showTyping(who) { typingWho.textContent = who + typingWho.dataset.suffix; typing.classList.add("on"); }
  function hideTyping() { typing.classList.remove("on"); }
  function showMsg(step) {
    var el = document.querySelector('.msg[data-step="' + step + '"]');
    if (el) el.classList.add("shown");
  }
  function setSpeaking(id, on) {
    var el = document.getElementById("vu-" + id);
    if (el) el.classList.toggle("speaking", on);
  }

  async function runChat() {
    await sleep(700);
    showTyping("mara"); await sleep(1300); hideTyping(); showMsg(1);
    await sleep(800);
    showTyping("jonas"); await sleep(1000); hideTyping(); showMsg(2);
    await sleep(500);
    showTyping("mara"); await sleep(1400); hideTyping(); showMsg(3);
    await sleep(1000);
    showTyping("felix"); await sleep(1000); hideTyping(); showMsg(4);
    await sleep(500);
    setSpeaking("mara", false); setSpeaking("felix", true);
    await sleep(900);
    document.getElementById("vu-jonas").hidden = false;
    await sleep(800);
    showTyping("jonas"); await sleep(1200); hideTyping(); showMsg(5);
    await sleep(600);
    showTyping("felix"); await sleep(1000); hideTyping(); showMsg(6);
    idle();
  }

  function idle() {
    var speakers = ["mara", "felix", "jonas"];
    var i = 1;
    setInterval(function () {
      speakers.forEach(function (s) { setSpeaking(s, false); });
      setSpeaking(speakers[i % speakers.length], true);
      i++;
    }, 2600);
    setInterval(async function () {
      showTyping("jonas"); await sleep(2800); hideTyping();
    }, 9000);
  }

  var winEl = document.getElementById("win");
  if (winEl) runChat();

  /* ---- terminal typing ---- */
  var term = document.getElementById("term");
  if (term && "IntersectionObserver" in window) {
    var started = false;
    var tio = new IntersectionObserver(function (entries) {
      if (started || !entries.some(function (e) { return e.isIntersecting; })) return;
      started = true; tio.disconnect(); runTerm();
    }, { threshold: 0.4 });
    tio.observe(term);
  }

  async function typeInto(el) {
    var text = el.getAttribute("data-text");
    var caret = document.createElement("span");
    caret.className = "caret";
    el.after(caret);
    for (var i = 0; i <= text.length; i++) {
      el.textContent = text.slice(0, i);
      await sleep(18 + Math.floor(24 * ((i * 7) % 3) / 3));
    }
    caret.remove();
  }

  async function runTerm() {
    var lines = term.querySelectorAll(".tl[data-t]");
    for (var k = 0; k < lines.length; k++) {
      var line = lines[k];
      line.classList.add("vis");
      var tt = line.querySelector(".tt");
      if (tt) { await typeInto(tt); await sleep(260); }
      else { await sleep(340); }
    }
  }
})();
