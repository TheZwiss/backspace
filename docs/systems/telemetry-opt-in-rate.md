# Telemetry opt-in rate

**Purpose:** estimate what fraction of instances running a telemetry-capable
version (1.2.0 or later) have said yes to the hello, so that the fleet numbers
on the insights page can be read against a plausible real fleet. The rate is
not observable: the receiver sees only the instances that said yes, and nothing
counts the ones that did not. This note triangulates it from the shape of the
ask and from published participation figures of comparable projects.

**Compiled:** 2026-09-21, twelve days after the first third-party ping, on the
day 1.4.0 shipped. Fleet at the time: 25 live third-party instances, 32 ever,
110 registered users, 91 active in the last week.

**Spec:** [telemetry.md](telemetry.md), section 7 for the ask itself.

---

## 1. Estimate

About **35 percent** of instances on 1.2.0+ whose admin has loaded the app
since upgrading have said yes, with a plausible range of **20 to 55 percent**.
Counted against every 1.2.0+ instance, including ones where no admin has logged
in since the upgrade, it is nearer 30 percent, range 15 to 50.

Read the other way: 25 live opted-in instances stand for roughly 60 to 120 real
ones. The width comes from the denominator, which nobody can see (see section 6).

No comparable project publishes a clean number for this exact shape (in-product
modal, off by default, no incentive). The bracket for "opt-in, shown in
product" from the projects that do publish is 5 to 25 percent. Backspace's ask
is better on every lever the consent-design experiments measure, and its early
audience is unusually favourable, which is why the centre sits above that
bracket. Expect the rate to fall as the fleet broadens past early adopters.

---

## 2. The ask, as the code has it

This is a description of what shipped in 1.4.0; the spec in
[telemetry.md](telemetry.md) is authoritative if the two ever differ.

**Who sees it, when.** `TelemetryAsk` mounts once at the root of `App.tsx` on
web, desktop and mobile alike. It opens when the signed-in user is an admin of
the home instance and `GET /api/admin/telemetry` returns `askDue: true`. Every
admin is asked, not only the first, and any admin's answer settles it for the
instance. It is not gated on the admin panel: it opens on any authenticated
page load, at most once per load. On a fresh install the first registered user
becomes admin, so the modal appears seconds after the first registration,
before a space exists, with no competing onboarding flow. On an upgraded
instance it appears on the first admin page load after 1.2.0.

**What it looks like.** A `max-w-3xl` glass modal, fullscreen on mobile. The
`HelloScene` on the left: starfield, a small ship, a pilot waving in the
porthole on a loop. The text on the right, in the maintainer's first person.
Title: "Hi. It's Jannis. I built this." The body explains that nothing is
tracked today, that building the project "feels like shouting into space and
never hearing anything back", and asks for a daily hello of rounded counts.
The real payload is available under a collapsed "Show the message" link. A
footnote names Cloudflare as the receiver host and the source of the country.

**The answers.** "Hiii 👋" and "Radio silence", each an illustrated component of
equal size and flex basis, plus a small text link "Decide later". The yes
button is a lit scene (ship, plume, beacon, a glow that spills past the button);
the no button is a dark hull plate with a flatline. Same size, deliberately
different mood. Neither is a default: nothing is autofocused, neither is a
submit button, and no button says "Continue" or "OK". After yes: "Signal
acquired." After no: "Understood." A failed save keeps the modal open.

**What does not block.** Escape, a click on the scrim, and "Decide later" all
close it without saving anything on the server.

**Cadence** (from PR #224):

| State | What the admin sees over time |
|---|---|
| never answered | the modal on the next page load; a snooze writes a 7-day timestamp to that browser's local storage; it returns every 7 days, forever, until an answer is stored; each admin browser has its own snooze |
| said yes | never again, on any release |
| said no | quiet for the rest of that minor and its patches; due again on the next minor or major, as the identical modal; nothing in it refers to the earlier answer |

Until 2026-09-15 the second snooze in a browser ended the ask for good.

**Outside the modal.** `install.sh` documents `TELEMETRY=on|off` and, when the
variable is unset, prints one line after the summary saying that an optional
ping and a note wait after first login. It never prompts in the shell. The
README has the env-var row and a privacy paragraph in the same voice. While
the hello is off, the Instance settings tab strip renders the "Say hi to
Jannis" entry as the animated yes button instead of a plain label.

**Payload versus prose.** The modal names "how many people are here, which
version runs, whether voice and federation are on, and which country the hello
came from". The JSON also carries message and storage counts, `installedAt`,
the runtime and the build commit, which the prose does not list. Id stability
(minted once, kept across off and on since PR #165) is explained in the
settings panel and the spec, not in the modal.

**How it evolved.** #135 (1.2.0) shipped plain grey "Say hi" / "No thanks"
buttons and a two-snoozes-then-silent rule. #151 carried the scene into the
settings panel. #165 stopped rotating the id. #177 (1.3.0) illustrated the two
answers and added the settings invitation. #181 stopped switching on from
costing a day of data. #224 (1.4.0) set the current cadence. Admins on 1.2.x
saw the grey buttons and the old snooze rule.

---

## 3. Comparable projects

"Published" is a first-party statement. "Inferred" is computed from public data
or a secondary quote. "Not found" means nobody has said.

| Project | Default | How it asks | Participation | Status | Source |
|---|---|---|---|---|---|
| Home Assistant | opt-in, four unchecked levels | onboarding step, later in Settings; never re-asked; promoted in release posts | 686,283 reporting (2026-09); "we estimate that less than a fourth of all Home Assistant users opt in"; 2021: "4-5x more installations than people that opt-in" | published estimate | analytics.home-assistant.io; home-assistant.io/blog/2021/11/12/100k-analytics/ |
| Ubuntu 18.04 ubuntu-report | opt-out, box pre-ticked | first-login page with the data shown | "Opt In rate: 67%" | published | ubuntu.com/blog/a-first-look-at-desktop-metrics |
| Endless OS | opt-out | initial setup page | "roughly 90% of users have the full metrics system enabled" | published | blogs.gnome.org/wjjt, 2023-07-05 |
| Firefox | opt-out | preferences checkbox, first-run bar | "93% of release channel profiles have telemetry enabled" | published | docs.telemetry.mozilla.org/datasets/pings |
| Go toolchain | opt-in | `go telemetry on`; gopls prompt in the IDE (5% rollout in 2024, 100% since gopls 0.43.4) | ~100 reports after launch; ~1,800 weekly at the 5% rollout; 6,400 to 6,900 weekly in 2026-09. Denominator per Russ Cox: "three million Go installations" | counts published; rate inferred, about 0.2% | go.dev/blog/gotelemetry; research.swtch.com/telemetry-opt-in; telemetry.go.dev/data/ |
| Debian popularity-contest | opt-in, debconf default No | installer question | 289,881 submissions (2026-09); "the guestimate is that 1-10% of Debian users enable popcon" (Halchenko, 2019) | count published; fraction inferred | popcon.debian.org; github.com/scipy/scipy-articles/issues/153 |
| Matrix Synapse | opt-in | mandatory yes/no at config generation (`--report-stats`); Debian package asks via debconf | no count or fraction published | not found | element-hq.github.io/synapse (reporting_homeserver_usage_statistics) |
| Nextcloud | off by default, app shipped | in-app admin notification about a day after install, per-category checkboxes | never published | not found | github.com/nextcloud/survey_client |
| Grafana | opt-out | config only, no prompt | "1M+ active instances", which "only includes installations that have usage reporting enabled" | count published; fraction not found | grafana.com/blog/2022/11/23 |
| GitLab Service Ping | opt-out (Free); cannot disable on paid | admin checkbox; paid features offered for reporting | no fraction published | not found | docs.gitlab.com/administration/settings/usage_statistics/ |
| Mattermost | opt-out | System Console toggle | company metrics are "Telemetry-Enabled Daily Active Servers"; no fraction | not found | handbook.mattermost.com |
| Rocket.Chat | opt-out; setting hidden since 7.0; non-reporting workspaces go read-only | env var only | "845,000 servers" (2021, no method) | not found | RocketChat/Rocket.Chat, AirGappedRestriction.ts |
| Zulip | opt-in at server level, then opt-out | install flag | not published | not found | zulip.readthedocs.io |
| KDE KUserFeedback | opt-in | System Settings slider | "just shy of 100,000 updates" in 7 months (2020); no participant count | count only | blog.davidedmundson.co.uk |
| GNOME gnome-info-collect | opt-in, one-off | CLI tool, recruited on Discourse | 2,560 responses | published | blogs.gnome.org/aday, 2023-01-18 |
| Fedora | opt-out proposal withdrawn; opt-in approved 2024, never built | initial-setup page | owner's reason for rejecting opt-in: "few users would opt in, and these users would not be representative" | statement | fedoraproject.org/wiki/Changes/Telemetry; lwn.net/Articles/980598/ |
| Homebrew | opt-out | notice on first `brew update` | a podcast transcript has the maintainer saying "the vast majority of people opt out" against GitHub download counts; the wording is ambiguous and it is not used here | unverified | mikemcquaid.com interview, 2026-01-27 |
| Portainer (before 2.38) | opt-out, pre-ticked at first admin setup | setup checkbox | not published; removed in 2.38.0 | not found | docs.portainer.io FAQ |
| Netdata, n8n, Umami, Homarr, Coolify, VS Code, .NET SDK | opt-out | env var, settings or first-run notice | nothing published | not found | |
| Gitea, Jellyfin, Immich, Plausible, Pi-hole, Dokploy, pip, cargo | no telemetry | | | verified | |
| Audacity, 2021 | proposed opt-in with a dialog | permission dialog | PR #835 drew 3,316 thumbs-down; telemetry dropped | published | github.com/audacity/audacity/pull/835 |

Consent-design experiments:

| Study | Finding | Source |
|---|---|---|
| Utz et al. 2019, 82,890 real visitors | highlighted Accept versus a plain text link: 26.9% vs 21.1% desktop, 50.8% vs 39.2% mobile; pre-selected checkboxes about 30% mobile / 10% desktop accept all; unchecked opt-in under 0.1% accept all, 1 to 4% accept some; only 4 to 42% interact with a banner at all; an equal-buttons binary notice lands near one in ten accepting with a plurality taking no action (approximate, read from a figure) | arxiv.org/abs/1909.02638 |
| Nouwens et al. 2020 | removing the reject button from the first page raises consent by 22 to 23 points; granular controls on the first page lower it by 8 to 20 points | arxiv.org/abs/2001.02479 |
| Johnson and Goldstein 2003 | opt-in 42% versus opt-out 82% versus a forced neutral choice 79% | science.org/doi/10.1126/science.1091721 |

---

## 4. From the comparables to the estimate

The three anchors that resemble the Backspace shape are Home Assistant
(in-product, off by default, every new install sees it: under 25 percent),
Debian popcon (installer question, default No: 1 to 10 percent guessed), and Go
(opt-in with an IDE prompt: about 0.2 percent of installs). The opt-out
projects (Ubuntu 67 percent with a pre-ticked box, Endless 90, Firefox 93) show
what the default is worth. Johnson and Goldstein put a forced neutral choice
(79) far closer to opt-out (82) than to opt-in (42), and the Backspace modal is
closer to a forced choice than to a buried flag.

Pushing Backspace above the Home Assistant bracket:

- **Attention.** A focused modal on the admin's first authenticated screen, on
  every device, returning every seven days until answered. Home Assistant asks
  once during onboarding and never again; Go relied on release notes until the
  IDE prompt multiplied its sample eighteenfold at a 5 percent rollout. The
  re-ask is the largest structural difference: it turns "never answered" into
  an answer eventually.
- **One binary choice.** No categories, no levels. Utz and Nouwens both put
  granular controls at minus 8 to 20 points, and unchecked category boxes near
  zero; Home Assistant offers four levels.
- **A personal voice and a concrete reason.** No comparable has a named
  maintainer asking in the first person. The wording effect in Utz's framing
  arm was small, so this is weighted modestly.
- **A mild nudge toward yes.** Same size, but the lit ship against the dead
  plate does what a highlighted button does in Utz: about +6 points desktop,
  +12 mobile.
- **The preview and the open-data promise.** Ubuntu's 67 percent came with the
  data on screen; Home Assistant publishes everything it receives. Nothing in
  the literature shows transparency lowering acceptance.
- **A small, warm audience.** Anyone running a 1.2.0+ instance in September
  2026 found the project on purpose. Early adopters of a two-month-old project
  opt in more readily than a mature install base will.

Pushing it down:

- **Privacy-sensitive self-hosters.** The Debian and Home Assistant population,
  which lands at 1 to 25 percent for opt-in.
- **"Decide later" is free.** Escape and the scrim do the same. Utz found the
  plurality take no action when they can; Nouwens found a visible way out costs
  22 to 23 points. The seven-day return recovers part of that, but the snooze is
  per browser, so an admin on two devices is asked twice.
- **The Cloudflare footnote and the country field.** Honest, and a line some
  admins stop at.
- **No is quiet for a whole minor.** Every 1.2- and 1.3-era no became due again
  only on 2026-09-21 with 1.4.0; the first weeks of data had no second chances.
- **Version skew of the ask.** 1.2.x admins saw the grey buttons and the old
  two-snoozes rule.

Not adjusted for: the Russian-speaking share of the audience. Seven of the
first twenty opted-in instances were in Russia, so Russian admins opt in at
least as readily as anyone else, and there is no documented cultural consent
gap to cite.

Putting numbers on it: the honest bracket from the comparables is 5 to 25
percent. The ask is better on every lever the experiments measure (binary,
nudged, personal, transparent, persistent) and the audience is favourable, so
the centre moves to about 35 percent of instances whose admin has loaded the
app, range 20 to 55. The eventual yes rate among instances that keep an active
admin should drift upward with each seven-day cycle, since there is no cap and
a no is quiet for one minor only.

**Population that never sees the ask, outside the rate:**

- instances on 1.1.x or earlier: no code, no columns, no ask;
- instances on 1.2.0+ whose admin has not loaded the app since upgrading
  (auto-updated but dormant); `askDue` stays true and the modal waits;
- unattended installs with `TELEMETRY=off`: stamped as declined on the install
  version, so quiet until the next minor; `TELEMETRY=on` installs are yeses that
  never saw the modal;
- forks whose version string does not parse: asked while never answered, never
  re-asked after one no;
- admins who only ever use a federated account on another instance.

---

## 5. What the comparables suggest changing

Would raise the rate:

1. **Expand the preview by default.** The strongest published number for a
   first-login ask (Ubuntu, 67 percent) came with the data on the page, and the
   copy already says "here is exactly what it would say today" above a
   collapsed link. Cost: modal height. Evidence: moderate; no controlled test
   isolates the preview.
2. **Say it at the release moment, outside the modal.** Home Assistant
   attributes its climb to release posts and livestreams; Go's sample grew from
   about 100 to about 1,800 the moment a prompt reached 5 percent of users. The
   surfaces an admin reads right before the re-ask fires are the update toast
   and the release notes. One line there reaches every admin on the day a
   minor ships.
3. **Keep the nudge; do not remove "Decide later".** Nouwens shows removing
   the third exit would add 22 to 23 points, but the re-ask cadence is the
   honest substitute, and this audience punishes pressure (Audacity, Go's
   reversal, Fedora's withdrawn proposal all came from opt-out or coercion).

Would lower it:

- any move to opt-out, refused on 2026-09-15 for exactly this reason;
- splitting the hello into levels: minus 8 to 20 points in the experiments, and
  the shape that gives Home Assistant "less than a fourth";
- copy that refers to the earlier no on a re-ask, reverted in #224;
- incentives of the GitLab kind or Rocket.Chat's read-only coercion, which move
  the number at the cost of "no costs nothing".

---

## 6. Open uncertainties

- **The denominator.** Nothing exposes the number of running 1.2.0+ instances;
  GHCR pull counts, stars and desktop downloads do not pin it. The estimate is
  a rate applied to a guessed count that could be off by two either way.
- **Twelve days of data on a two-month-old project.** Early-adopter opt-in is
  higher than steady state.
- **The 1.4.0 re-ask had not fired yet** when this was compiled. How many
  earlier nos flip is the first direct measurement of the cadence's effect;
  they will appear as new instances with an `installedAt` earlier than 2026-09.
- **No comparable publishes the exact shape.** Nextcloud is nearest and has
  never published; Synapse asks at config generation and has never published.
- **Utz's binary-notice figure** is approximate, read from a figure.
- **Activity cold start.** Not about the rate, but the active-user series
  undercounts for the first month after each upgrade and reads as growth; see
  [telemetry.md](telemetry.md), section 4.
