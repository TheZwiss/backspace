# UI soul pass: scene bible

Status: rows approved 2026-09-09. Batch 0 (rows 0, 4, 5, 9, 11) is built; scene batches follow.

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

## 4. The light rule

**One key light, above and to the left, outside the frame, warm white.**
Everything in every scene obeys it. It picks out the top-left of a rim, the
top-left of a hull, the top-left crescent of a world, the upper edge of a
seat back. What it does not reach falls to the object's own hue turned
toward lavender, never toward black. A green thing in shadow is
`hullShade`, not olive.

Inside a room the key comes through the window, still upper left. There is
no fill light. Depth is done with falloff and with atmosphere caught in the
glass, not with a second light.

**Emitters** are the only things allowed to be brighter than the key:
cabin and console lights (amber, `window` / `windowLit`), signals (mint),
hails (peach to coral). An emitter blooms outward from itself with one
shared blur, the way the craft's plume and porthole do. Nothing else glows.

The derelict is the exception that proves it: no local light at all, only
starlight from the same upper left, so everything there is matte and the
depth comes from texture.

## 5. Motion budget

Slow and expensive, never busy. The measure is `HiButton`: several infinite
animations, all long period, all transform or opacity, and it still reads as
still.

At rest, per screen:

- **Scene tier**: at most one scene visible per screen, with at most three
  infinite animations, every period six seconds or longer, transform and
  opacity only. No animated blur, no animated `backdrop-filter`, no animated
  gradients. Motion that is a story beat (a wave, a ping, a sheen) spends
  most of its cycle not happening.
- **Material tier**: nothing moves at rest. The sheen crosses only on hover
  and only once per few seconds.
- **Reduced motion** freezes every scene into a still frame chosen because
  it is the best frame, and strips nothing. `SilenceButton`'s block is the
  model: the ping caught a third of the way across, already fading.
- **Raspberry Pi and mobile**: a scene may use at most two `backdrop-filter`
  layers and at most two SVG filters. Everything else is gradients and
  masks. If a workbench screenshot takes longer than a second to settle on
  the Pi, the scene is over budget.

On interaction the budget doubles for the duration of the interaction and
returns to rest afterwards.

## 6. The two tiers

**Material tier.** Cheap, reusable, extracted from `HiButton` into
`globals.css` (edited by the lead only, never by an agent). Five layers,
each a class that can be stacked on any floating surface:

| Class | What it is | Extracted from |
|---|---|---|
| `.mat-rim` | The hairline that turns hue: warm white where the key lands, mint along the top, near nothing lower right, lavender coming back. A masked gradient border, so the hue can turn. | `.hi-button__rim` |
| `.mat-gloss` | The resting specular: one sheet of glass over the surface, caught at the top-left corner. | `.hi-button__gloss` |
| `.mat-aura` | The light the surface throws onto what is around it. Hover and focus only. | `.hi-button__aura` |
| `.mat-scrim` | A photographic vignette that seats a scene in its frame by taking light away, and a soft well under a label. | `.hi-button__scrim` |
| `.mat-sheen` | The travelling specular. Parked off-frame, crosses once on hover. | `.hi-button__sheen` |

All five read one `--lift` channel (0 at rest, 1 on hover and focus) and one
`--push` channel, so a host sets two numbers and every layer moves together.
Modals, popovers, toasts, and the primary call to action get material and
nothing else. Material never contains a subject.

**Scene tier.** Bespoke and expensive: a component with a co-located CSS
file, one subject, layered like the reference (void, depth, subject, scrim,
gloss, rim, label), one agent, four or more iterations. Roughly one scene
per screen. A scene may use the material classes for its frame.

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
