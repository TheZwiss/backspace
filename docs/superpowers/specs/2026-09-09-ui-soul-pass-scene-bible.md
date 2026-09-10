# UI soul pass: scene bible

Status: first pass built 2026-09-09 and rejected on the populated instance 2026-09-10 (see section 12). Second pass under the darkness rule in progress, local only. Nothing is pushed until it is good.

This is the document that lets many independent agents produce one product.
It is not a token list; Aether Drift already has tokens. It says what each
surface depicts, what light every layer obeys, how much may move, and which
of two treatments a surface gets. The reference for the bar is
`packages/web/src/components/telemetry/answers/HiButton.tsx` and
`SilenceButton.tsx`, with their co-located CSS.

## 1. The world

Backspace already has a world. It was built for the telemetry ask and it is
good: a small crewed craft with a warm cabin light, holding station in a
quiet, warm-dark space; a pilot who waves; a plotted course to a new world;
and, on the far side, a derelict plate that stopped transmitting. The app's
own name is a spacecraft's habitable volume.

Every scene in this pass is a place on that same journey. The rule for
choosing a subject is the one that made the two buttons work: **the scene
depicts what the surface is for.** The empty voice channel is a rendezvous point with nobody moored yet, and
pressing Join is the departure. Add friend is a hail going out to one specific person. The login
card is the airlock you come home through. Never "put space behind it". A
nebula pasted on everything becomes wallpaper in a week.

What is *not* in this world: characters that emote at the user, confetti,
purple corporate glow, anything that reads as a "landing page hero".

## 2. Nori

There is already a mascot. `Mascot.tsx` draws a mint blob with two eyes and
a blush in four moods (idle, sleeping, excited, lonely), animated by a
622-line Web Animations hook, and English copy names it: "No pending
requests, Nori is napping." It appears on five empty states today (friends
online/all/pending/activity, the DM list) and twice on mobile.

Nori and the ship are currently two different visual languages. The blob is
lit by a flat radial gradient with near-black eyes; the ship is lit by one
key light and shades toward its own hue. One of these has to give, and it is
the blob's *rendering*, not the character.

**Proposal: Nori is the crew.** Same silhouette, same moods, same hook, but
redrawn under the scene's light rule (section 4): key light from upper
left, shade toward lavender, eyes in `pilot` not `#0d0d12`, a proper contact
shadow instead of a grey ellipse. Nori then sits inside scenes as the
someone who is there when no one else is: at the window when nobody is
online, asleep at the console when there are no pending requests, at the
hailing desk when there are no friends yet. The porthole pilot in the
telemetry scene stays a silhouette; the two are not the same drawing at the
same scale and do not need to be.

**Decided 2026-09-09: Nori stays**, on the condition that the redraw and the
animations fit the world. The animation hook finds parts by attribute only
(`data-mascot`, `data-eye`, `data-side`, the sleep z's, the particles), so a
redraw that keeps those attributes keeps every mood working. "Fit" means
three things, and they are row 12's brief:

- **Light.** Highlight and shadow placed where the shared key light puts
  them, upper left; the body shades toward lavender on the lower right, not
  toward a darker mint; the grey ellipse becomes a cast shadow that stays
  under the body while it breathes.
- **Eyes.** The near-black eyes become the palette's `pilot`, with the
  catchlight moved to the upper left to agree with the key.
- **Motion.** The idle breath runs at 3.8 seconds today, under the six-second
  floor; it slows to the floor, and the wiggle and look-around periods are
  checked against the budget. No new animation is added; timings are the
  only thing in the hook that changes.

## 3. Palette

One palette, extending `packages/web/src/components/telemetry/scene/palette.ts`.
Every value is derived from an Aether Drift token in `globals.css`; nothing
here is pure black or white. The existing eleven entries stay as they are.
New entries, with the token they come from:

| Key | From | Role |
|---|---|---|
| `deck` | `--bg-channel` warmed one step | Interior floor and bulkheads of any room scene |
| `bulkhead` | `--bg-elevated` | The lit face of interior structure |
| `console` | `--accent-sky` at low alpha | Standby lights on instruments, the colour of "ready" |
| `seat` | `hullShade` (lavender toward primary) | Anything turned away from the key inside a room |
| `signal` | `--accent-mint` | An outgoing or live signal, a plotted course, a friend who is here |
| `hail` | `--accent-peach` toward `--accent-coral` | An incoming call, someone wanting attention |
| `warn` | `--accent-rose` at the derelict's saturation | A beacon that has gone dark, an invalid invite |
| `dust` | `--sil-rime` (from SilenceButton) | Frost, motes, the cold end of the range |

`SilenceButton` currently defines its cold palette as private custom
properties. Batch 0 lifts them into this file so the derelict vocabulary is
reusable (dead beacons, expired connections) without a second definition.

## 4. The darkness rule

This section replaces the light rule that shipped in the first pass. That
rule ("one key light, shade every layer toward it, rim and gloss on
everything") was extracted from a 42px button and produced rendered 3D
illustration at panel scale: bevels, lit lips, glossy fills, grain, rooms
with furniture. Jannis's verdict on 2026-09-10: "you forcibly tried to make
and shade everything 3d and ruined the liquid glass calm aether drift
aesthetic". The buttons looked like Windows Vista. He was right.

**Depth comes from darkness and distance, never from shading.**

- **Space is the darkest thing on screen.** A scene's void sits at or below
  `--bg-base` (11 11 16) and is always darker than the chrome around it. The
  channel header, the sidebars and the modal glass must never be darker than
  the space next to them. No nebula wash, no grain overlay, no gloss sheet,
  no vignette that lifts the black. If a layer adds light to the void, it is
  wrong.
- **Stars are small, crisp points at distance.** One to two pixels, sharp,
  in `star` or `dust`, with a rare very slow twinkle on a few. No blurred
  "far field", no bloom, no four-point sparkles, no coloured haze around
  them. Sparse. A star field that reads as a texture is too dense.
- **Objects are flat, clean vector shapes**, the way the telemetry hello
  scene draws the ship: one fill per face, a soft edge where a lit side
  meets a shaded side, no form-shadow passes, no specular strokes, no rims,
  no bevels, no grain. If a shape needs more than two fills to read, it is
  too detailed for this world.
- **Light is atmosphere, not a lamp.** A planet may carry one thin, clean
  atmosphere line on its lit limb. A cabin may glow softly. That is the
  whole allowance. Nothing else emits, and nothing casts a shadow.
- **Vastness is composition.** Objects are small in a large dark frame, far
  apart, with empty space between them that is allowed to stay empty. No
  rooms, no walls, no windows, no furniture, no consoles, no instruments.
  The subject is still specific (a ship on its way, a world, a friend who
  is not here yet), but it floats in the open.
- **No plotted lines.** Dotted courses, dashed headings, orbit rings and
  scanner sweeps read as 2000s dashboards. The journey is implied by where
  the ship is pointed.

## 5. Motion budget

Soothing and calm. Motion that is noticed is too much.

- At rest, per screen: at most three animation definitions, transform and
  opacity only, and every travel distance small (a few pixels of drift, a
  slow roll, a star's opacity easing between two values). No blur,
  backdrop-filter or gradient animation. No sheens, no sweeps, no pulses.
- Amended 2026-09-10, after the twelve-second floor read as "frozen and
  dead" on the voice channel: a sky is allowed to breathe. Stars twinkle on
  four- to nine-second periods, out of phase, never to zero; a Sternschnuppe
  falls once a minute or so; a moored craft drifts a few pixels on a
  nine-second loop. Slower than that is still, not calm.
- Every animation runs on the compositor. A CSS animation on an element
  inside an inline SVG runs on the main thread and repaints the whole SVG
  every frame; the shared sky (`telemetry/scene/StarField`) draws its still
  stars in one SVG painted once and its breathing stars as spans, one layer
  each, for that reason. Scenes take their stars from it.
- Nothing continuous flows at sixty frames a second. A screen that is
  always redrawing costs a tenth of a core on an M1 Pro before a single
  blur is counted, and it never sleeps. So the breath steps on a shared
  quarter-second beat (`BREATH_TICK`): every period and phase is a multiple
  of it and every star uses a `steps()` easing with one step per tick, so
  the whole sky changes four times a second and the compositor draws four
  frames, not sixty. Nori's loops inside her SVG step on the same beat.
  Smooth motion is reserved for rare, short events (a streak, the
  crossing) and for the one moored craft that is looked at, not idled on.
- Hover changes one thing softly (a plume a little longer, a glow a little
  warmer) over half a second or more. Press does nothing theatrical.
- `prefers-reduced-motion: reduce` freezes into the best frame and strips
  nothing.
- Raspberry Pi and mobile: no `backdrop-filter` in a scene, no live SVG
  filters, at most one rasterised data-URI image.

## 6. Materials

There is no material tier. The batch 0 chrome (glossy buttons with lit
lips and rims, modal gloss and rim pseudo-elements, lit toasts) is reverted
to the original Aether Drift surfaces: flat `accent-primary` buttons, the
plain `.glass-modal` border, the flat 50% modal backdrop, the coloured
left border on toasts. Aether Drift's glass is felt, not seen; a scene may
sit behind glass but never wears it.

A scene is one component with a co-located stylesheet and one subject. It
reads no store, handles no click and owns no string. Its whole vocabulary
is: a dark void, sparse crisp stars, at most two or three flat objects,
one soft glow, one or two very slow motions.

## 7. Where everything lives: the inventory

From a read-only tour of a live instance at desktop, narrow desktop, mobile
and reduced-motion widths on 2026-09-09. Screenshots are session material
and are not in the repo. "Dead space" is the fraction of the surface with
nothing in it.

| Surface | File | What is there now | Dead space | Seen |
|---|---|---|---|---|
| Login | `auth/LoginPage.tsx` | A card on a flat base with a 6% radial tint at the top | ~85% | Every session |
| Register | `auth/RegisterPage.tsx` | Same card, longer | ~75% | Once, first impression |
| Join / invalid invite | `JoinPage.tsx` | Same card; a rose warning glyph in a circle | ~85% | Every invite link |
| Voice channel, nobody in it | `layout/MainContent.tsx` lines 405 to 436 | Channel name, one line of copy, a pill button, a purple radial pulse | ~90% | Every voice channel click |
| Friends: online, empty | `chat/FriendsPage.tsx` line 193 | Nori idle, one line | ~90% | Every open of the home tab when nobody is on |
| Friends: all, empty | line 213 | Nori lonely, one line | ~90% | New users |
| Friends: pending, empty | line 233 | Nori sleeping, one line | ~90% | Often |
| Friends: activity, empty | line 307 | Nori sleeping, one line | ~60% | Often |
| DM list, empty | `layout/ChannelSidebar.tsx` line 514 | Nori sleeping, one line | sidebar column | New users |
| Mobile DM list / spaces list, empty | `MobileDmsScreen.tsx` 302, `MobileSpacesScreen.tsx` 905 | Nori | full screen | New mobile users |
| Channel welcome header | `chat/MessageList.tsx` `WelcomeHeader` | A hash in a grey disc, a title, a line, a rule | fixed block | Every new channel, every scroll to top |
| DM and group welcome header | same | Avatar or stack, title, a line, two buttons | fixed block | Every DM top |
| Explore, empty | `chat/ExplorePage.tsx` line 132 | Nori lonely | ~90% | Instances with no public spaces |
| Explore cards without a banner | same | Flat two-stop gradient | card top | Most cards |
| Modal chrome | `ui/Modal.tsx`, `.glass-modal` | Glass with one uniform border | frame | Every modal |
| Primary call to action | 30+ inline class strings | Flat `accent-primary` fill, opacity hover | button | Everywhere |
| Incoming call | `voice/IncomingCallModal.tsx` | Glass modal, `call-refraction`, ripple keyframes exist | modal | Every call |
| Toasts, update toasts | `ui/ToastContainer.tsx`, `UpdateToast.tsx`, `InstanceUpdateToast.tsx` | `glass-pill` with a coloured left border | pill | Often |
| Search popover, empty | `chat/SearchPopover.tsx` | One line of copy in a glass panel | ~70% | Every search open |
| Confirm dialog | `ui/ConfirmDialog.tsx` | Modal chrome | modal | Destructive actions |
| Profile popout and modal | `ui/UserProfilePopout.tsx`, `modals/UserProfileModal.tsx` | User banner or flat colour | banner | Often |
| Mobile You screen | `layout/MobileYouScreen.tsx` | Profile card, four rows, log out | lower 50% | Every mobile session |
| Mobile settings list | `layout/MobileSettingsScreen.tsx` | Six rows | lower 60% | Often |
| Boot skeleton | `layout/AppLayout.tsx` | Skeleton bars | n/a | Every load |
| Space strip buttons | `layout/SpaceSidebar.tsx` | Three round buttons | strip | Always |
| Settings panels | `modals/settingsPanels/*`, `instanceSettingsPanels/*` | Forms | varies | Settings |
| Voice, connected | `voice/VoiceGrid.tsx`, `VoiceControlBar.tsx` | LiveKit tiles and controls | n/a | Voice |
| Channel sidebar, member list, message list, composer, space strip | Tier 2 files | Dense, stateful | n/a | Always |

Two things the tour found that are not design work: the home sidebar shows
two greyed "Coming Soon" rows in production, and the friends page has an
"Activity" tab in the code that did not render on the tour. Both are for
Jannis to decide, not for a design agent.

## 8. Feasibility, by tier

**Tier 1, swarmable now.** Self-contained or cheaply extractable, low state,
generous canvas: the auth backdrop (three pages share one 6% gradient div
that becomes one component), the voice-empty panel (a 30-line JSX block in
`MainContent` that reads only the channel name and a join handler), the five
friends and DM empty states (pure presentation blocks inside store-heavy
files, extractable into one component with variants), the explore empty
state and card banners, modal chrome, the primary call to action, the
incoming call modal (148 lines, two stores, all state is "ringing or not"),
toasts, the search popover empty state, the confirm dialog.

**Tier 2, needs a human-directed plan.** The welcome header lives inside
`MessageList.tsx`, whose scroll model and position memory are documented in
`docs/systems/message-list.md`. The visual part is extractable as a
presentational component, but its rendered height is part of the scroll
contract and must stay static. `ChannelSidebar`, `SpaceSidebar`,
`MessageInput`, the mobile screen stack, and everything connected to
LiveKit stay off the swarm.

**Tier 3, leave alone.** Settings panels, the boot skeleton, the member
list, profile banners (user content dominates), the mobile You and settings
lists (a scene under a menu is wallpaper), the space strip buttons (too
small for a subject; material hover at most).

## 9. Subjects, ranked

Rank is visibility times dead space times feasibility. Effort: S is a
material-only change or one small component; M is one agent, one scene,
four or more iterations; L is a scene that needs a primitive or a Tier 2
extraction first. Every scene ships with its own workbench page.

| # | Surface | Current state | Proposed subject | Tier | Effort | Depends on |
|---|---|---|---|---|---|---|
| 0 | Palette, material classes, workbench harness | Two buttons carry everything privately | Extract the five material layers into `globals.css`, extend the palette, write the shared workbench frame (`.is-hover`, `.is-focus`, 3x, real surround) | material | M, lead only | nothing |
| 1 | Voice channel, nobody in it | Name, line, pill, purple pulse | **The rendezvous, and nobody is moored yet.** Open space, the porthole of the telemetry answer at panel scale: the craft holds station left with its cabin lit; low right a large world on its night side, and in orbit above its lit limb a small rendezvous beacon with its docking light on and nothing moored to it. A dotted course runs from the ship, behind the channel name, to the beacon, and Join Voice sits on that line as the material call to action. Hover throttles the plume and brightens the beacon; press is the launch, and the voice grid that replaces the panel is the arrival. Ship anchored left, world anchored lower right, title and button centred, so every panel width reads as the same porthole. Desktop only; mobile opens voice channels as chat. | scene | M | 0 |
| 2 | Login, register, join, invalid invite | Card on flat black | **Docking.** One `AuthBackdrop` behind all three cards: the slow approach to a station, its running lights strung along the lower edge of the frame, one large soft world low right, the card itself given the material rim and gloss so it reads as the airlock window. Register adds a second running light coming on. Invalid invite reuses the derelict vocabulary: the beacon you followed has gone dark. | scene + material | M | 0 |
| 3 | Friends and DM empty states (five sites plus two mobile) | Nori and one line, five times | **The crew quarters.** One `CrewEmptyState` with a variant per mood. Nobody online: the quarters with lights dimmed, Nori at the window. No friends yet: the hailing desk, no contacts plotted. No pending: Nori asleep at the console, screen on standby (the copy already says this). No activity: the ship at cruise, nothing on the board. | scene | L | 0, Nori decision |
| 4 | Primary call to action | 30+ flat inline fills | **Material only.** A `.cta-primary` class with rim, gloss, aura on hover and a scrim under the label; the eight highest-visibility sites swapped (Log In, Continue, Join Voice, Create, Add Friend, Join Space, Message, Save). Quieter than the reference: no stars, no scene. | material | M, lead only | 0 |
| 5 | Modal chrome | Glass, one uniform border | **Material only.** `.glass-modal` gains the turning rim and the top-left gloss; the backdrop scrim becomes a vignette rather than a flat 50% black. Every modal inherits it. | material | S, lead only | 0 |
| 6 | Incoming call | Glass modal with ripples | **A hail.** The comm panel lighting up: the caller's avatar is the signal source, rings leave it at the ripple's existing cadence, the panel's console lights come up from standby to `hail`. Accept is the material call to action in `signal`; decline is a quiet material button. Workbench only, since a live call cannot be surveyed read-only. | scene | M | 0, 5 |
| 7 | Channel, DM and group welcome header | Hash in a disc, title, rule | **First light.** A presentational `WelcomeHero` extracted from `MessageList`, same height as now: the hash or the avatar sits in a porthole with the key light catching its top-left rim and a thin plotted line running out to the right where the conversation will go. DM variant keeps the avatar; group keeps the stack. | scene | L | 0, message-list plan |
| 8 | Explore | Nori lonely; flat card gradients | **The charts.** Empty state: a star chart with nothing plotted yet and a faint grid, the compass glyph the page already uses becoming the chart's rose. Cards without a banner get the material scrim and rim so a two-stop gradient stops reading as a placeholder. | scene + material | M | 0, Nori decision |
| 9 | Toasts and update toasts | Glass pill, coloured left border | **Material only.** Rim and an edge light in the toast's own colour, so a success toast is lit mint from the left rather than bordered by it. | material | S | 0 |
| 10 | Search popover, empty | One line in a glass panel | **Scanning.** A short sweep line in the panel that runs once when it opens and parks; the copy stays. | scene, small | S | 0 |
| 11 | Confirm dialog | Modal chrome | Inherits 5; the danger variant's confirm gets the derelict's cold rim instead of the warm one. | material | S | 5 |
| 12 | Nori redraw | Flat radial blob, near-black eyes | Same silhouette and moods, relit under the light rule; the hook is untouched. | primitive | M | Jannis |

Not proposed: mobile You and settings lists, boot skeleton, settings
panels, space strip, profile banners, anything connected to voice while
connected.

## 10. Batches

Dependencies are real. Material first, because accent work reuses it.
Palette and bible before any scene. Harness before any agent. Primitives
before the surfaces that compose them. Within a batch every agent owns only
its component file and its co-located CSS, and nothing shared.

| Batch | Contents | Who | PR |
|---|---|---|---|
| 0 | Rows 0, 4, 5, 9, 11: palette, material classes, `.cta-primary`, modal and toast chrome, the workbench frame, this bible committed | lead | one |
| 1 | Rows 1, 2, 6 in parallel, plus 12 if approved | three or four agents | one |
| 2 | Rows 3, 8 in parallel (both need Nori settled and the `CrewEmptyState` contract), row 10 | three agents | one |
| 3 | Row 7, after a written plan against `message-list.md` | one agent, lead-directed | one |

Each batch closes with the lead running `pnpm typecheck`,
`node scripts/check-i18n.mjs`, `pnpm --filter @backspace/web test`, and a
side-by-side look at every workbench screenshot for drift.

## 11. The agent brief, fixed parts

Every dispatched agent receives, verbatim: this document's sections 1, 3, 4,
5 and 6; its own row from section 9 expanded into a subject, a mood and a
story; the workbench URL; the screenshot recipe with a unique
`--user-data-dir` and the warning that `--virtual-time-budget` never
settles; the four-iteration minimum with a written critique naming the
single weakest thing after every screenshot; the anti-slop list; the
non-negotiables; the definition of done; and the request for a layer-by-layer
report.

Anti-slop list: flat single-colour fills; one uniform border; a lone small
SVG floating in dead space; no light source; no texture; no depth; motion
that just slides something across; an even repeat that reads as a barcode;
a purple radial glow behind a title.

Non-negotiables: CSS and inline SVG only, no canvas, no JS animation loops,
no new dependencies, no external assets. `prefers-reduced-motion: reduce`
freezes into a still frame that is itself beautiful. Visible keyboard focus,
full label contrast, unreduced hit area, decoration spills by absolute
positioning or `overflow: visible` and never by margin. Survives its real
width range and mobile widths. TypeScript strict, no `any`, exported
signatures unchanged. Every user-facing string through the i18n catalogs in
English, German and Russian; `node scripts/check-i18n.mjs` passes. CSS
commented the way a design system is: what each layer is and why.

Done means `pnpm typecheck` passes and the final screenshot is something
the agent would defend as an art piece.

## 12. Second pass, 2026-09-10

The first build was rejected on the populated instance. The cause was
section 4's original light rule, and it is replaced above. What each row
becomes in the second pass, with Jannis's words where they exist:

| Row | Verdict on the first pass | Second pass |
|---|---|---|
| 0, 4, 5, 9, 11 (material, buttons, modal chrome, toasts, confirms) | "cheap ass vista knockoffs. revert that" | Reverted to the original surfaces. The `cta-primary`, `cta-danger` and `cta-warning` classes stay as names and now paint exactly the original flat buttons. |
| 1 (voice) | "washed out and cheap looking", brighter than the header above it; wanted "deep dark space with a rocket ship on its way, soothing calm movements, stars that actually look like beautiful clear stars in the distance" | Same composition (ship left, world low right, on its way), re-rendered flat and dark under section 4. Beacon, orbit ring, course line, glass, grain and nebula removed. |
| 2 (auth) | not commented, same fault in milder form | Keep the world and the stars, flat and dark. The drawn station with panels, lamps, masts and gantry goes; at most a faint arc of a few lights, or nothing. |
| 3 (crew) | "claustrophobic and not like vast endless awe inducing space" | The room, window, bulkhead, shaft, console and berth go. Nori alone in open space, small in a large dark frame, over a sparse star field. |
| 6 (call) | not commented, drawn instruments | Instrument strip, grain, bevelled buttons and console lights go. A dark panel, the caller's avatar, one soft ring that eases out very slowly, flat accept and decline. |
| 7 (welcome hero) | "the green line is so 2000s and the forcibly 3d logo is so windows vista" | Reverted to the plain header. The `WelcomeHero` extraction stays as structure with no decoration. |
| 8 (explore) | not commented, drawn objects | Card banner material reverted to the plain gradient. The empty state becomes Nori in open space like row 3, with no chart, rose or scanner. |
| 10 (search) | not commented, a sweep and a grid | Reverted to the plain hint. |
| 12 (Nori) | "the shading of the nori screen is a bit weird" (about the scene) | The relight stays unless Jannis says otherwise: it is flat-shaded, no bevel, and the character reads the same. |

## 13. The home backdrop, 2026-09-10

Jannis's direction after the second pass: the friends page's sky changed
between Online, All and Pending, which read as "jumpy and glitchy", and stars
alone with "the absence of a planet or the spaceship or anything other spacy"
read as "random dots on background". His proposal, agreed: **make the space
the backdrop and persistent**, with life in it, and lay the page's controls
and content over it in glass, so "the transparency makes the life still shine
through but it feels alive in the background."

This is Aether Drift's own rule applied to a page: content on matte panels,
persistent controls on glass. Three components, the friends page only for
now (the explore page next if it works; never chat, whose list needs a
solid ground):

- **`chat/HomeSpace`**, the living backdrop, behind the friends main column
  only (not the DM sidebar, not the Active Now list). Under section 4: the
  void at or below `--bg-base`; one sky, the same on every tab, with a soft
  density band (more points along one diagonal, no colour, no gradient) and
  two star scales with the twinkle on the small ones; the same flat dark
  world with its one atmosphere line that the voice channel and the login
  page have, low right and mostly off-frame. Rare life, none of it near the
  panel: the ship far and small crossing the top once every two to four
  minutes over about twenty seconds; a Sternschnuppe every 45 to 90 seconds,
  under a second. Frozen under reduced motion. No `backdrop-filter` in the
  scene itself.
- **`chat/FriendsGlass`**: `FriendsHeader` replaces the top bar with glass
  pills on `.glass-bubble`: the title with its icon in one pill, Online, All
  and Pending as one segmented pill with the active tab lifted, Add Friend
  as its own mint pill, the member-list toggle in a small pill at the right.
  There is no content panel. Jannis's correction on the first workbench:
  "a bubble must only be as large as it needs to be to hold its contents,
  not artificially stretch itself to match the whole screen real estate."
  So `FriendsPanel` is a transparent scroll region, each friend or request
  row is its own bubble sized to its content (`friends-row`), the section
  count is its own small pill (`friends-count`), and the empty states are
  bare: Nori and the line sit directly on the living backdrop, part of the
  scene. The crew states draw no stars of their own, and the hero size is
  positioned over the tab's box rather than in its flow, so an empty tab
  has nothing to scroll.
- Nori's mood cross-fades on tab change (a 300ms arrival in
  `CrewEmptyState`).

Cost rule: glass re-blurs whatever moves behind it, once per frosted
element per frame, for as long as anything behind it moves. The first build
frosted every row, and a long friends list over the breathing sky lagged and
heated the laptop (measured: four times the GPU time per frame, and dropped
frames while scrolling). So only the header's pills are `.glass-bubble`; the
rows and the count are the same fill and edge without the blur, which over a
near-black sky of points reads the same. Nothing drifts continuously behind
the rows except the breath. `prefers-reduced-transparency` gets solid rows
and pills as the design system already promises.
