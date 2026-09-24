# Project Hub Design

**Date:** 2026-09-24
**Status:** Design, approved in conversation; spec reviewed by agent at the maintainer's request
**Scope:** The "Coming Soon" slot in the DM sidebar becomes a "Backspace" page with project information

---

## 1. What was asked, and what was decided

The maintainer asked for the placeholder "Coming Soon" item in the DM sidebar
(`packages/web/src/components/layout/ChannelSidebar.tsx`, the item after
Friends and Explore) to become a "Backspace" button that opens project
information as cards: one for the insights page, one for patch notes, one for
funding the project. The rest of this section records decisions taken in the
brainstorming conversation.

| Question | Decision |
|---|---|
| Which cards | What's new, Join the Backspace community, Support the project, Insights, Report a bug / request a feature, Host your own instance, Get the desktop app |
| Rejected cards | Roadmap, Help translate |
| Where release notes come from | **Link out** to the GitHub release page. No notes in the repo, no server fetch. Least maintenance, and it keeps the property in `releaseCheck.ts` that an instance nobody administers never contacts github.com |
| Funding platform | **Ko-fi**. Most people who see the card are chat users; GitHub Sponsors needs a GitHub account to donate, Ko-fi does not. The Ko-fi page does not exist yet |
| Community instance | Does not exist yet. The card is built completely and reads its target from one constant; while that is empty the card is hidden |
| Page or modal | A page at `/backspace` in the main area, like `/explore` |
| Support card on other people's instances | An admin can hide it. Default on |

### Non-goals

- Release notes rendered inside the app.
- A roadmap card or a translation card.
- Migrating the existing ad-hoc readers of `GET /api/instance/info`
  (`UserSettings`, `ExplorePage`, the admin panels) to the new shared reader in
  section 5. `ExplorePage` reads the endpoint once per mount on purpose
  (directory.md section 9), and moving the others is unrelated to this feature.

---

## 2. Project links: one constant

`packages/web/src/utils/projectLinks.ts` holds every outbound project URL and
the builders that derive URLs from them. Only the web client reads these, so
they live in `web`, not `shared` (which holds contracts between packages).

```ts
export interface CommunityTarget {
  /** Canonical origin of the community instance, e.g. "https://chat.example.org". */
  origin: string;
  /** Id of the community space on that instance. */
  spaceId: string;
}

export const PROJECT_LINKS: {
  repository: string;            // https://github.com/TheZwiss/backspace
  insights: string;              // https://backspacechat.com/insights/
  installGuide: string;          // repository + '#installation' (README heading "Installation")
  releases: string;              // repository + '/releases'
  license: string;               // repository + '/blob/main/LICENSE'
  security: string;              // repository + '/blob/main/SECURITY.md'
  contributors: string;          // repository + '/graphs/contributors'
  funding: string | null;        // Ko-fi page; null until it exists
  community: CommunityTarget | null; // null until the instance exists
};
```

`funding` and `community` ship as `null`. **A null value hides its card**; no
card ever renders a dead link. Filling them in later is a one-line change each,
with no other code touched.

Builders in the same file, all pure:

- `releaseNotesUrl(version: string): string` returns
  `${repository}/releases/tag/v${version}` when `version` matches
  `/^\d+\.\d+\.\d+$/` exactly, otherwise `releases`. A fork's label, a `-dev`
  suffix or an empty string all get the release list. Always upstream: the hub
  is about the project, the instance's own source link lives in section 8.
- `bugReportUrl(fields: { version: string; environment: string }): string`
  returns `${repository}/issues/new?template=bug_report.yml&version=…&environment=…`
  with both values encoded through `URLSearchParams`. The field ids `version`
  and `environment` are the ids in `.github/ISSUE_TEMPLATE/bug_report.yml`;
  GitHub issue forms prefill `input` and `textarea` fields from query
  parameters named after the field id. Dropdowns are not prefilled.
- `featureRequestUrl(): string` returns
  `${repository}/issues/new?template=feature_request.yml`.

A unit test asserts the constant is well formed: every non-null URL parses
with `new URL`, is `https:`, and `community.origin` equals
`new URL(community.origin).origin` (no path, no trailing slash). The test runs
against the real constant, so a malformed value filled in later fails CI.

### Environment string

`packages/web/src/utils/describeEnvironment.ts` exports
`describeEnvironment(userAgent: string, clientKind: ClientKind): string`,
pure, no new dependency. It returns `"<Browser> <major> on <OS>"`, for example
`"Firefox 131 on macOS"`, and for the desktop client
`"Desktop app (Chrome <major>) on <OS>"`. `ClientKind` is the existing type in
`packages/web/src/platform/clientKind.ts`. Browsers recognised: Edge, Opera,
Firefox, Chrome, Safari, checked in the order that avoids the known UA
overlaps (Edge and Opera carry "Chrome", Chrome carries "Safari"). OS: Windows,
macOS, iOS, Android, Linux, ChromeOS. Anything unrecognised becomes the word
the template's placeholder would expect a human to type anyway: an unknown
browser yields `"Unknown browser"`, an unknown OS drops the `" on …"` part. The
string is English on purpose: it is written into a GitHub issue, not shown in
the UI.

---

## 3. Server: the Support card setting

One new column, one new field on two existing responses.

- **`instance_settings.support_card_enabled`**, integer boolean, `NOT NULL
  DEFAULT 1`. Added in `packages/server/src/db/schema.ts` and through the
  existing migration mechanism in `packages/server/src/db/migrate.ts`, so an
  existing database gains the column with the value 1.
- **`GET /api/instance/info`** (`routes/instance.ts`, public) gains
  `supportCardEnabled: boolean`. `InstanceInfoResponse` in
  `packages/shared/src/types.ts` gains the field with a comment saying it only
  hides the card, it does not change anything the server does.
- **The admin settings read and write** that `GeneralPanel` already uses gain
  `supportCardEnabled`. The PATCH accepts a boolean and rejects anything else
  through the existing validation style of that route, with the existing error
  code for an invalid body.

---

## 4. The "seen version" state

The sidebar item, the mobile row and the page all need to agree on whether the
instance has updated since the user last opened the page. That is one piece of
shared state with one derived view.

**Storage.** `localStorage` key `backspace_hub_seen_version`. It is per origin
by construction, which is what we want: the version is the home instance's.
Every read and write is in `try/catch`; a throwing or empty storage means "no
stored value". Losing the value costs at most one extra dot, so browser
storage is appropriate.

**Store.** `packages/web/src/stores/projectHubStore.ts`, Zustand:

```ts
interface ProjectHubState {
  /** Last version the user saw on the Backspace page; null when none recorded. */
  seenVersion: string | null;
  /** Record `version` as seen, in memory and in localStorage. */
  markSeen: (version: string) => void;
}
```

`seenVersion` is initialised from storage when the store is created.

**Derived view.** One pure function in the same file:

```ts
export type HubUpdateState = 'unknown' | 'first-run' | 'current' | 'updated';
export function hubUpdateState(seenVersion: string | null, version: string | null): HubUpdateState;
```

| `version` (from instance info) | `seenVersion` | Result | Dot | What's new card says |
|---|---|---|---|---|
| null (not loaded, or failed) | any | `unknown` | no | "Release notes" with no version line |
| known | null | `first-run` | no | "You're on {version}" |
| known | equal to `version` | `current` | no | "You're on {version}" |
| known | different | `updated` | **yes** | "Updated to {version}" |

On `first-run` the caller records the version silently (`markSeen`), so the
first dot appears at the next update. A new user, and every existing user on
the day this ships, sees no dot. Opening the page records the version as seen.
The page takes a snapshot of the state **on mount**, before calling
`markSeen`, so the What's new card keeps saying "Updated to {version}" for that
visit while the sidebar dot clears at once.

Every surface that shows the dot or the card text calls `hubUpdateState`.
Nothing else compares versions for this purpose.

---

## 5. Reading the home instance's info

`packages/web/src/hooks/useHomeInstanceInfo.ts` exports
`useHomeInstanceInfo(): InstanceInfoResponse | null`, backed by a small module
store: the first subscriber triggers one `GET /api/instance/info` on the home
API client; concurrent subscribers share that request; a success is cached for
the session; a failure leaves `null` and the next mount of a subscriber tries
again. An `invalidateHomeInstanceInfo()` export drops the cache and refetches
if anything is subscribed. `GeneralPanel` calls it after a successful save, so
toggling the Support card is reflected on the page without a reload.

The sidebar item (for the dot), the mobile row and the page read version and
`supportCardEnabled` only through this hook.

---

## 6. Sidebar item and routing

**Route.** `App.tsx` gains `/backspace`, wrapped exactly like `/explore`
(`ProtectedRoute` around `AppLayout`). `MainContent.tsx` renders
`ProjectHubPage` when the path is `/backspace`, the same way it renders
`ExplorePage` for `/explore`.

**Which home item is selected.** Today the Friends item is selected when
`!currentChannelId && location.pathname !== '/explore'` and Explore when the
path is `/explore`, written inline twice each. A third route added the same way
is how two items end up selected at once. Replace them with one pure function
in `packages/web/src/utils/homeNav.ts`:

```ts
export type HomeNavItem = 'friends' | 'explore' | 'backspace';
export function activeHomeNavItem(pathname: string, currentChannelId: string | null): HomeNavItem | null;
```

`/explore` gives `explore`, `/backspace` gives `backspace`, no channel on any
other path gives `friends`, otherwise null. All three items read it.

**Audit.** Every other place in `packages/web/src` that tests
`pathname === '/explore'` (or `startsWith('/explore')`) to mean "a home-level
page, not a channel" must be checked, and where the meaning applies it must
cover `/backspace` too. `MainContent.tsx` (`isExplorePage`) and the space
sidebar's home-button highlight are known candidates; the implementer greps
for all of them and lists each one with its decision in the report.

**The item.** The placeholder `<div>` becomes a clickable item styled exactly
like Explore (same classes, hover, selected state), label from
`project:nav.label` ("Backspace"), icon the Backspace mark drawn as an inline
SVG `path` with `fill="currentColor"`, taken from
`assets/brand/mark-mono-light.svg`, at the same 24px box as the other two
icons. When `hubUpdateState(...) === 'updated'`, an 8px lavender dot
(`bg-primary`) sits at the right edge of the row, with an accessible label
from `project:nav.updatedDot`. The unused `spaces:sidebar.dmList.comingSoon`
key is removed from all four catalogs.

---

## 7. The page

Files under `packages/web/src/components/projectHub/`:

- `ProjectHubPage.tsx`: the page, used by the desktop route and the mobile
  screen.
- `HubCard.tsx`: the shared card shell (icon, title, body, action area).
- `WhatsNewCard.tsx`, `CommunityCard.tsx`, `ReportCard.tsx`: the cards with
  their own logic. The simple link cards are `HubCard` instances inside the
  page.
- `InstanceSection.tsx`: section 8.

**Layout, top to bottom.** Scrollable main-area page on the structural chat
surface, content column capped at the same max width Explore uses.

1. **Header.** The Backspace mark (the `/icons/logo-mark.svg` used by the space
   sidebar), the title "Backspace", one line (`project:header.tagline`,
   "Open-source chat you can host yourself."), and the running version when
   known.
2. **Card grid.** Two columns from the `md` breakpoint, one below. Order:
   What's new, Join the community, Support the project, Insights, Report a
   bug / request a feature, Host your own instance, Get the desktop app.
   Hidden cards leave no gap. Each card has its own pastel accent from the
   design system's accent set, used only for the icon tile.
3. **This instance** (section 8).
4. **Footer.** Small text links: License (AGPL-3.0), Security, Contributors,
   Source code on GitHub.

**Material.** Cards are content on the page, not floating controls, so they
are matte structural surfaces (`bg-surface-*`), following the Explore
`SpaceCard` as the nearest existing precedent, never glass. The design is
calm: no gradients, no glow, no 3D. Every outbound link opens in a new tab with
`rel="noopener noreferrer"` through whatever external-link helper the web
package already uses (the desktop app must open them in the system browser,
not a new Electron window).

**Cards.**

| Card | Visible when | Action |
|---|---|---|
| What's new | always | "Read the release notes" to `releaseNotesUrl(version)`; with no version, `releases` |
| Join the community | `PROJECT_LINKS.community !== null` | section 9 |
| Support the project | `PROJECT_LINKS.funding !== null` and instance info loaded with `supportCardEnabled === true` | "Support on Ko-fi" to `funding` |
| Insights | always | "Open insights" to `insights` |
| Report a bug / request a feature | always | two buttons: `bugReportUrl({ version, environment: describeEnvironment(navigator.userAgent, clientKind()) })` and `featureRequestUrl()` |
| Host your own instance | always | "Read the install guide" to `installGuide` |
| Get the desktop app | not `isElectron()` and not the mobile layout | opens `userSettings` on the `desktop` tab, which renders the existing `DesktopDownloadPanel` on the web |

The Support card fails closed: while instance info is loading, or if it failed,
the card is hidden, because the admin may have turned it off.

---

## 8. "This instance"

A compact section below the grid, so nobody reads the Support card as "pay
this server's admin":

- Instance name (`info.name`) and domain (`window.location.host`).
- Version and commit, and the existing `SourceCodeLink` component with
  `info.sourceCodeUrl`, `info.version`, `info.commit`: the AGPL §13 source
  offer, which points at a fork's own source when the operator set
  `BACKSPACE_SOURCE_URL`.
- While info is loading or failed: the domain alone.

---

## 9. The community card

**Privacy.** The card contacts the community instance **only when the user
clicks Join**, never on page view. Opening the hub must not reveal the user's
IP to a third instance. So the card shows static copy (title, one line about
the space), not the live space name, icon or member count.

**Inputs.** `PROJECT_LINKS.community` (`origin`, `spaceId`); the home origin
`window.location.origin`; the spaces the session holds, from `spaceStore`, each
a `TaggedSpace` whose `_instanceOrigin` is `''` for the home instance.

**States.** One pure function derives the static part:

```ts
export function communityMembership(
  target: CommunityTarget,
  homeOrigin: string,
  spaces: readonly TaggedSpace[],
): 'member' | 'not-member';
```

A space matches when `space.id === target.spaceId` and its origin (with `''`
read as `homeOrigin`) equals `target.origin`.

| State | Button | On click |
|---|---|---|
| `member` | "Open" | navigate into that space the way an Explore card for a joined space does, on desktop and mobile |
| `not-member`, idle | "Join" | load the listing, below |
| loading | "Join" disabled with a spinner | |
| failed | "Try again", with a one-line note (`project:community.unreachable` or `project:community.notListed`) | load the listing again |

**Loading the listing.** `GET ${target.origin}/api/directory/spaces`, the
public directory document (directory.md), with a timeout. The response is
remote input: it is validated before use (if `web` already has a parser for
`DirectoryDocument`, use it; otherwise a narrow one in the card's module that
checks `schema === 1`, the `instance` object and each space's fields used
here). The space is `spaces.find(s => s.id === target.spaceId)`. A network
error, a non-2xx status or an invalid document gives `unreachable`; a valid
document without the space gives `notListed`. The entry handed on is
`{ ...space, origin: target.origin, instanceName: document.instance.name,
federatedRegistrationOpen: document.instance.federatedRegistrationOpen }`: the
origin is the configured one, never the document's claim.

**Joining.**
- `target.origin !== homeOrigin`: `openModal('connectAndJoin', { entry })`,
  the existing dialog that Outer Space cards use. Connecting, the password
  step, account reuse, join requests and their errors all stay in that one
  place.
- `target.origin === homeOrigin`: the local join path that an Inner Space card
  uses on the Explore page (join for a public space, the request flow for a
  request space), called the same way Explore calls it, not re-implemented.

After a successful join the space appears in `spaceStore`, so the derived
state becomes `member` with no extra bookkeeping.

**Operational requirement.** The card finds the space through the directory
document, which lists only listed spaces. The community space must be listed
in the directory. This goes into the project-hub doc (section 12).

**CORS.** The implementer verifies that `GET /api/directory/spaces` answers a
cross-origin `fetch` from another origin (web-security.md describes a
reflected-origin CORS posture). If it does not, that is fixed in the route, not
worked around in the client.

---

## 10. Mobile

- `MobileYouScreen.tsx` gains a "Backspace" row with the same mark icon and the
  same dot rule, following the file's existing row pattern, pushing the
  screen `backspace`.
- `MobileShell.tsx`'s screen map gains `backspace`: `MobileScreenHeader` titled
  from `project:nav.label` above `ProjectHubPage`, the pattern the
  `settings-instance-*` screens use.
- The desktop card is hidden on the mobile layout (section 7).

---

## 11. Text

A new namespace **`project`** in `packages/web/src/locales/{en,de,ru,zh}/project.json`,
registered wherever the existing namespaces are registered and typed the same
way. **All four languages are complete in the same change**: the i18n check
fails the build on a missing language, and a partly translated surface should
not ship. German follows the settled vocabulary in the existing `de`
catalogs; Russian and Chinese match the register their existing catalogs use.

Keys (English values are the source; the implementer may adjust wording but
not add persuasion copy, praise, em dashes or buzzwords):

- `nav.label` "Backspace", `nav.updatedDot` "Backspace was updated"
- `header.title` "Backspace", `header.tagline` "Open-source chat you can host yourself.", `header.version` "Version {{version}}"
- `whatsNew.title` "What's new", `whatsNew.updated` "Updated to {{version}}", `whatsNew.current` "You're on {{version}}", `whatsNew.noVersion` "Release notes for every version", `whatsNew.action` "Read the release notes"
- `community.title` "Join the Backspace community", `community.body` "Talk to the people who build Backspace, ask questions and share feedback.", `community.join` "Join", `community.open` "Open", `community.retry` "Try again", `community.unreachable` "The community instance could not be reached.", `community.notListed` "The community space is not available right now."
- `support.title` "Support the project", `support.body` "Backspace is built in the open and funded by the people who use it.", `support.action` "Support on Ko-fi"
- `insights.title` "Insights", `insights.body` "Public numbers on downloads, instances and activity.", `insights.action` "Open insights"
- `report.title` "Report a bug or request a feature", `report.body` "Your version and browser are filled in for you.", `report.bug` "Report a bug", `report.feature` "Request a feature"
- `host.title` "Host your own instance", `host.body` "Run Backspace on your own server and invite who you want.", `host.action` "Read the install guide"
- `desktop.title` "Get the desktop app", `desktop.body` "Push to talk, global keybinds and activity status.", `desktop.action` "Download"
- `instance.title` "This instance", `instance.version` "Version {{version}}", `instance.commit` "Commit {{commit}}"
- `footer.license` "License (AGPL-3.0)", `footer.security` "Report a security issue", `footer.contributors` "Contributors", `footer.source` "Source code on GitHub"

The admin setting's two strings go in the existing `admin` namespace next to
the other `GeneralPanel` strings: a label "Show the Support card" and a
description "Shows a card on the Backspace page that links to the project's
Ko-fi page. Turning it off hides only that card."

---

## 12. Documentation

- `docs/systems/project-hub.md` (new, short): what the page is, where the
  links live (point at `projectLinks.ts`, do not copy URLs), the seen-version
  rule table, the community card's states, the click-only privacy rule, and
  the two operational steps for the maintainer: set `funding`; create the
  community instance and space, **list the space in the directory**, set
  `community`.
- `CLAUDE.md`: one row for `project-hub.md` in the subsystem table.
- `docs/systems/database.md`: the column.
- `docs/systems/api.md`: `supportCardEnabled` on `GET /api/instance/info` and
  on the admin settings read and write.
- `docs/systems/admin.md`: the setting, one paragraph.

---

## 13. Testing

Each implementer tests their own work; the controller runs the full check at
the end.

- **Unit:** `releaseNotesUrl`, `bugReportUrl`, `featureRequestUrl`, the
  constant's well-formedness test, `describeEnvironment` over a table of real
  UA strings (Chrome, Edge, Opera, Firefox, Safari on macOS and iOS, Chrome on
  Android, the Electron UA), `hubUpdateState` over every row of section 4's
  table, `projectHubStore` with a throwing `localStorage`,
  `activeHomeNavItem`, `communityMembership`, the directory document parser
  with valid, malformed and missing-space inputs.
- **Server:** the migration adds the column with 1 on an existing database;
  `GET /api/instance/info` carries the field; the admin PATCH round-trips it
  and rejects a non-boolean.
- **Components** (@testing-library/react): the sidebar item selects correctly
  on `/explore`, `/backspace` and the friends view with exactly one item
  selected; the dot shows only on `updated`; the page hides the Support card
  when `funding` is null, when `supportCardEnabled` is false and while info is
  loading; hides the community card when `community` is null; hides the
  desktop card under Electron; the community card walks idle, loading,
  unreachable, notListed and member, and opens `connectAndJoin` with the
  configured origin for a remote target.
- **Whole tree:** `pnpm typecheck` (which runs the i18n check), `pnpm lint`,
  the web and server test suites with exit code 0, `pnpm dev` starts both
  server and frontend without errors.
- **Visual:** a design workbench page under `packages/web/src/dev/`
  (the existing convention for component workbenches) renders the page with
  both constants filled with test values and every card state, so it can be
  screenshotted at desktop and phone widths before the maintainer sees it.

---

## 14. What only the maintainer can do later

1. Create the Ko-fi page and put its URL in `PROJECT_LINKS.funding`.
2. Create the community instance and space, list the space in the directory,
   and put `origin` and `spaceId` in `PROJECT_LINKS.community`.
