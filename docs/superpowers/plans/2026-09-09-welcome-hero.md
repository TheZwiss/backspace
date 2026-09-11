# Welcome hero: extraction plan for scene bible row 7

Status: plan, not built. Batch 3 of the UI soul pass. Written against
`docs/systems/message-list.md`, which is the reason this row is not swarmable
as it stands.

## What the header is today

`WelcomeHeader` in `packages/web/src/components/chat/MessageList.tsx` (from
line 796) renders at the top of the scroll content whenever `hasMore` is
false. It has three branches with different data needs:

| Branch | Picture | Store reads | Actions |
|---|---|---|---|
| Text channel | A hash glyph in a 68px `bg-surface-elevated` disc | none | none |
| Direct message | `ProfileAvatar` of the other member at 80px | dmChannels, authUser, friends | remove friend |
| Group DM | `AvatarStack` of the others at 80px, or the group icon | dmChannels, authUser | open settings, leave group, owner popout |

Every branch ends with a title, one or two lines of copy, an optional row of
buttons, and a rule (`mt-6 border-b`).

## The constraint

`message-list.md` "Top-of-list reservation slot": the header mounts in the
tree position of the constant-height pagination slot when the last page
loads, and the prepend formula `scrollTop = prevScrollTop + (scrollHeight -
prevScrollHeight)` absorbs the height difference once, at that moment. After
that the header's height must never change on its own, or the scroll
position drifts under the reader. That rules out anything in the hero that
changes layout after mount: lazy assets that reflow, hover states that grow,
animations that move the block, content that wraps differently once fonts
load. Effects B and C would absorb a shift, but only when the reader is at
the bottom; the header is at the top.

The header also lives inside a scroll container with `overflow: auto`, so
decoration that spills past the header's box is clipped by the container,
not by the header. Spill downward would run behind the first messages.

## The extraction

One presentational component, `WelcomeHero`, in
`packages/web/src/components/chat/WelcomeHero.tsx` with a co-located
`WelcomeHero.css`, owned by the row 7 agent. `MessageList.tsx` keeps every
store read, every handler and every string, and passes the hero what to
draw:

```ts
interface WelcomeHeroProps {
  kind: 'channel' | 'dm' | 'group';
  /** The 68px hash disc, the 80px ProfileAvatar, or the AvatarStack, rendered by the caller. */
  figure: ReactNode;
  title: string;
  /** Copy lines and the optional button row, rendered by the caller in its current markup. */
  children: ReactNode;
}
```

`WelcomeHeader` becomes a thin function that builds `figure`, `title` and
`children` per branch exactly as now and returns `<WelcomeHero>`. The lead
does this extraction in the harness step, before the agent runs, so the
agent owns only the two new files.

## The subject, restated for the agent

**First light.** The figure sits in a porthole: a ring that catches the key
light on its top-left rim, with the void behind it inside the ring only (a
few stars, one soft nebula wash), and a thin plotted course leaving the
porthole to the right, behind the title, running out toward where the
conversation will go. The channel variant's hash is drawn on the glass as
the porthole's label. The DM variant keeps the real avatar inside the ring;
the group variant keeps the stack. Nothing below the rule changes.

## Rules for the agent, on top of the bible

- The hero's rendered height for a given `kind` and title is fixed and
  equal to today's header height. Verify by measuring before and after with
  `getBoundingClientRect()` in the workbench for each of the three kinds and
  for a two-line title.
- All decoration is absolutely positioned inside the hero's own box with
  `overflow: hidden` on the hero root. No spill; the scroll container would
  clip it anyway and it would run behind messages.
- Motion is transform and opacity on absolutely positioned layers only,
  never on anything in flow. Two infinite animations at most, six-second
  periods or longer. Still frame under reduced motion.
- No new strings. The hero has no copy of its own.
- The hero never reads a store and never handles a click; the figure and the
  children are the caller's.

## Workbench

`dev-welcome-hero.html` renders the three kinds inside a replica of the
message list's scroll container at 700px and 1200px wide, each with three
short messages below the hero so the join with the first message is judged,
plus a two-line title case and a group case with a six-member stack. The
harness seeds nothing; figures are passed in as static elements.

## Verification, lead-run after the agent

- `pnpm --filter @backspace/web test -- MessageList` (the scroll tests) and
  the full web suite.
- Manual, per `message-list.md` "Manual repro recipe": Slow 3G, open a
  channel with deep history, scroll to the top, watch the slot become the
  hero without a jump.
- `docs/systems/message-list.md` gets one paragraph under "Top-of-list
  reservation slot" naming `WelcomeHero` and the fixed-height rule.
