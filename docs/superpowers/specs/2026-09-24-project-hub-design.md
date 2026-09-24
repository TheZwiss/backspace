# Project Hub Design

**Date:** 2026-09-24
**Status:** Design, approved in conversation; spec reviewed by an agent at the maintainer's request and corrected
**Note:** §9's listing conditions (and §14's matching step) were corrected after implementation to match `directory/document.ts`; §4 and §5 were made precise at the same time.
**Scope:** The "Coming Soon" slot in the DM sidebar becomes a "Backspace" page with project information

---

## 1. What was asked, and what was decided

The maintainer asked for the placeholder "Coming Soon" item in the DM sidebar
(`packages/web/src/components/layout/ChannelSidebar.tsx:478-486`, after Friends
and Explore) to become a "Backspace" button that opens project information as
cards: one for the insights page, one for patch notes, one for funding the
project. The rest of this section records decisions taken in the brainstorming
conversation.

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
  (`UserSettings`, `ExplorePage`, `LoginPage`, `RegisterPage`,
  `MobileSettingsScreen`, the admin panels) to the shared reader in section 5.
  `ExplorePage` reads the endpoint once per mount on purpose (directory.md
  section 9), and moving the others is unrelated to this feature.
- Deep-linking `/backspace` on the mobile layout. `useMobileRouteSync` only
  syncs `/channels/*/*`, so opening that URL on a phone lands on the root tab.
  The mobile entry point is the You-screen row (section 10).

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

export interface ProjectLinks {
  repository: string;                 // https://github.com/TheZwiss/backspace
  insights: string;                   // https://backspacechat.com/insights/
  installGuide: string;               // repository + '#installation' (README heading "Installation")
  releases: string;                   // repository + '/releases'
  license: string;                    // repository + '/blob/main/LICENSE'
  security: string;                   // repository + '/blob/main/SECURITY.md'
  contributors: string;               // repository + '/graphs/contributors'
  funding: string | null;             // Ko-fi page; null until it exists
  community: CommunityTarget | null;  // null until the instance exists
}

export const PROJECT_LINKS: ProjectLinks;
```

`funding` and `community` ship as `null`. **A null value hides its card**; no
card ever renders a dead link. Filling them in later is a one-line change each,
with no other code touched.

Builders in the same file, all pure:

- `releaseNotesUrl(version: string | null): string` returns
  `${repository}/releases/tag/v${version}` when `version` matches
  `/^\d+\.\d+\.\d+$/` exactly (release tags are `v1.5.1` form), otherwise
  `releases`. A fork's label, a `-dev` suffix, an empty string or null all get
  the release list. Always upstream: the hub is about the project; the
  instance's own source link lives in section 8.
- `bugReportUrl(fields: { version: string | null; environment: string }): string`
  returns `${repository}/issues/new?` + `URLSearchParams` of
  `template=bug_report.yml`, `version=<version>` (omitted when null) and
  `environment=<environment>`. `version` and `environment` are the ids of two
  `input` fields in `.github/ISSUE_TEMPLATE/bug_report.yml`; GitHub issue forms
  prefill `input` and `textarea` fields from query parameters named after the
  field id. Dropdowns are not prefilled.
- `featureRequestUrl(): string` returns
  `${repository}/issues/new?template=feature_request.yml`.

A unit test asserts the constant is well formed: every non-null URL parses
with `new URL`, is `https:`, and `community.origin` equals
`new URL(community.origin).origin` (no path, no trailing slash) with a
non-empty `spaceId`. The test runs against the real constant, so a malformed
value filled in later fails CI.

### Environment string

`packages/web/src/utils/describeEnvironment.ts` exports
`describeEnvironment(userAgent: string, isDesktopApp: boolean): string`, pure,
no new dependency. Callers pass `navigator.userAgent` and `isElectron()`
(`packages/web/src/platform/platform.ts`). It returns
`"<Browser> <major> on <OS>"`, for example `"Firefox 131 on macOS"`, and when
`isDesktopApp` is true `"Desktop app (Chrome <major>) on <OS>"`. Browsers
recognised: Edge (`Edg/`), Opera (`OPR/`), Firefox, Chrome, Safari (major from
`Version/`), checked in that order because Edge and Opera carry "Chrome" and
Chrome carries "Safari". OS: Windows, macOS, iOS (iPhone/iPad), Android,
ChromeOS (`CrOS`), Linux. An unknown browser yields `"Unknown browser"`; an
unknown OS drops the `" on …"` part. The string is English on purpose: it is
written into a GitHub issue, not shown in the UI.

---

## 3. Server: the Support card setting

One new column, one new field on two existing responses.

- **`instance_settings.support_card_enabled`**, `integer` boolean,
  `NOT NULL DEFAULT 1`, added to `instanceSettings` in
  `packages/server/src/db/schema.ts` as
  `supportCardEnabled: integer('support_card_enabled', { mode: 'boolean' }).notNull().default(true)`,
  plus a **generated drizzle migration**
  (`pnpm --filter @backspace/server db:generate`, which writes
  `packages/server/drizzle/0017_*.sql` and updates `drizzle/meta`). Precedent:
  `0016_whole_loki.sql` adding `directory_browse_enabled`. `migrate.ts`
  (`ensureDefaults`) is not involved: an existing row gains the column with 1
  from the column default.
- **`GET /api/instance/info`** (`routes/instance.ts`, public) gains
  `supportCardEnabled: boolean`. `InstanceInfoResponse` in
  `packages/shared/src/types.ts` gains the field with a comment saying it only
  hides a card in the web client and changes nothing the server does.
- **`GET` / `PATCH /api/settings/instance`** (`routes/settings.ts`, admin, the
  pair `GeneralPanel` uses) gain `supportCardEnabled`: the shared type
  `InstanceAdminSettings` gains the field, `rowToAdminSettings` maps it, and the
  PATCH accepts a boolean and otherwise answers
  `sendError(reply, 400, 'field_not_boolean', { field: 'supportCardEnabled' })`,
  the existing code the route uses for its other boolean fields.

---

## 4. The "seen version" state

The sidebar item, the mobile row, the mobile You tab and the page all need to
agree on whether the instance has updated since the user last opened the page.
That is one piece of shared state with one derived view.

**Storage.** `packages/web/src/utils/hubSeenVersion.ts`, following
`utils/updateAck.ts` exactly in shape: key `backspace_hub_seen_version_<userId>`
(per user id, so two accounts in one browser do not clear each other's dot;
localStorage is already per origin), `readHubSeenVersion(storage, userId)` and
`writeHubSeenVersion(storage, userId, version)`, every access in `try/catch`. A
null `userId` reads as `null` and writes nothing. A storage that throws reads
as `null` and writes nothing, so the value lives in memory for the session. A
corrupt record (not JSON, or no non-empty `seenVersion`) reads as `null`; that
is `first-run`, so the hook's `first-run` `markSeen` overwrites it with the
running version as soon as the version is known. Losing the value costs at
most one extra dot.

**Store.** `packages/web/src/stores/projectHubStore.ts`, Zustand:

```ts
interface ProjectHubState {
  /** User id the value below belongs to; null before sign-in. */
  userId: string | null;
  /** Last version this user saw on the Backspace page; null when none recorded. */
  seenVersion: string | null;
  /** Load the stored value for `userId` (no-op when it is already loaded). */
  load: (userId: string | null) => void;
  /** Record `version` as seen for the loaded user, in memory and in storage. */
  markSeen: (version: string) => void;
}
```

**Derived view.** One pure function in `projectHubStore.ts`:

```ts
export type HubUpdateState = 'unknown' | 'first-run' | 'current' | 'updated';
export function hubUpdateState(seenVersion: string | null, version: string | null): HubUpdateState;
```

| `version` (from instance info) | `seenVersion` | Result | Dot | What's new card says |
|---|---|---|---|---|
| null (not loaded, or failed) | any | `unknown` | no | `whatsNew.noVersion` |
| known | null | `first-run` | no | `whatsNew.current` |
| known | equal to `version` | `current` | no | `whatsNew.current` |
| known | different | `updated` | **yes** | `whatsNew.updated` |

**The one hook.** `packages/web/src/hooks/useHubUpdateState.ts` exports
`useHubUpdateState(): { state: HubUpdateState; version: string | null }`. It
reads the signed-in user id from `authStore`, calls `load(userId)` in an effect,
reads the version through `useHomeInstanceInfo()` (section 5), and returns
`hubUpdateState(seenVersion, version)`. **When the result is `first-run`, the
hook itself calls `markSeen(version)`** in an effect, which is idempotent, so a
new user, and every existing user on the day this ships, sees no dot, and the
first dot appears at the next update. Every surface that shows the dot or the
card text calls this hook. Nothing else compares versions for this purpose.

**Opening the page.** `ProjectHubPage` takes a snapshot of the hook's result on
its first render with a known version (a `useRef` set once), then calls
`markSeen(version)`. The What's new card renders from the snapshot, so it keeps
saying "Updated to {version}" for that visit while the sidebar and You-tab dots
clear at once.

---

## 5. Reading the home instance's info

`packages/web/src/hooks/useHomeInstanceInfo.ts` exports
`useHomeInstanceInfo(): InstanceInfoResponse | null` and
`invalidateHomeInstanceInfo(): void`, backed by a small module-level store
(Zustand, or a module cache with `useSyncExternalStore`; either, one of them).

- **Fetch rule:** whenever a subscriber mounts while there is no fresh value
  and no request in flight, one `GET /api/instance/info` starts on the home API
  client. Concurrent subscribers share it. A success is cached for the session.
  A failure leaves the value as it was (`null`, or a stale value) and nothing
  in flight, so the next subscriber mount (for example opening the page) tries
  again. On desktop the sidebar stays mounted, so after a first failure its
  dot stays off until a page mount or reload refetches; that is acceptable.
- **`invalidateHomeInstanceInfo()`** is stale-while-revalidate: it marks the
  cached value stale and rereads at once if anything is subscribed (otherwise
  the next mount rereads). The stale value stays visible until the reread
  replaces it, and stays if the reread fails, so the Support card, instance
  name and sidebar dot do not blink out. A generation counter drops an answer
  that was already in flight when the invalidation happened. `GeneralPanel`
  calls it after a successful `PATCH /api/settings/instance`, so toggling the
  Support card is reflected on the page without a reload.

The sidebar item, the mobile row, the You tab and the page read the version and
`supportCardEnabled` only through this hook (the version via
`useHubUpdateState`).

---

## 6. Sidebar item and routing

**Route.** `App.tsx` gains `/backspace`, wrapped exactly like `/explore`
(`App.tsx:91-97`, `ProtectedRoute` around `AppLayout`). `AppLayout` already
clears the current space and channel on a route with no params, so the
ChannelSidebar shows its DM branch there. `MainContent.tsx` renders
`ProjectHubPage` for `/backspace` with the same early-return pattern it uses for
`ExplorePage` (`MainContent.tsx:185-190`).

**Which home item is selected.** Today the Friends item is selected when
`!currentChannelId && location.pathname !== '/explore'` and Explore when the
path is `/explore`, written inline twice each (`ChannelSidebar.tsx:451, 456,
467, 472`). A third route added the same way is how two items end up selected
at once. Replace them with one pure function in
`packages/web/src/utils/homeNav.ts`:

```ts
export type HomeNavItem = 'friends' | 'explore' | 'backspace';
export function activeHomeNavItem(pathname: string, currentChannelId: string | null): HomeNavItem | null;
```

`/explore` gives `explore`, `/backspace` gives `backspace`, no channel on any
other path gives `friends`, otherwise null. All three items read it.

**Space rail.** The rail's `@me` item is active on `showDms`
(`SpaceSidebar.tsx:1056`), which `AppLayout` sets only for `spaceId === '@me'`,
so on `/backspace` nothing in the rail would be selected. The Backspace page is
reached from the DM sidebar, so `@me` is active there: the item reads
`showDms || activeHomeNavItem(pathname, currentChannelId) === 'backspace'`.
The rail's Explore action (`SpaceSidebar.tsx:1208`, a pathname test for
`/explore`) keeps testing `/explore` only. `MainContent.tsx:71`
(`isExplorePage`) is only used for the Explore early return and does not
change. Those are all pathname tests for `/explore` in `packages/web/src`.

**The item.** The placeholder `<div>` becomes a clickable item that navigates
to `/backspace`, styled exactly like Explore (same classes, hover, selected
state), label from `project:nav.label` ("Backspace"), icon the Backspace mark
drawn as an inline SVG `path` with `fill="currentColor"`, taken from
`assets/brand/mark-mono-light.svg`, in the same 24px box as the other two
icons. When `useHubUpdateState().state === 'updated'`, an 8px dot in the brand
primary colour sits at the right edge of the row, with an accessible label from
`project:nav.updatedDot`. The `spaces:sidebar.dmList.comingSoon` key, which
this change leaves unreferenced, is removed from all four catalogs.

---

## 7. The page

Files under `packages/web/src/components/projectHub/`:

- `ProjectHubPage.tsx`: the page, used by the desktop route and the mobile
  screen. Props: `links?: ProjectLinks` (default `PROJECT_LINKS`), passed down
  to the cards, so tests and the workbench can fill `funding` and `community`
  without touching the constant; `showTopBar?: boolean` (default true, the
  mobile screen passes false).
- `HubCard.tsx`: the shared card shell (icon tile, title, body, action area).
- `WhatsNewCard.tsx`, `CommunityCard.tsx`, `ReportCard.tsx`: the cards with
  their own logic. The simple link cards are `HubCard` instances in the page.
- `InstanceSection.tsx`: section 8.

**Frame.** On desktop the page follows `ExplorePage`'s frame: the `h-12` top
bar with the page title (`project:header.title`) and `MemberListToggleButton`,
then a scrolling body with `p-6`. No max-width cap (Explore has none). On the
mobile screen the `MobileScreenHeader` replaces the top bar (section 10), and
the screen passes `showTopBar={false}`.

**Body, top to bottom.**

1. **Header.** The Backspace mark (`/icons/logo-mark.svg`, as the space rail
   uses it), the title "Backspace" and one line (`project:header.tagline`).
   No version here: the What's new card and section 8 carry it.
2. **Card grid.** The design system's `.card-grid` class (`globals.css:330`,
   required for card lists by design-system.md), never `md:` (forbidden in the
   app shell, enforced by `platform/viewportTokens.test.ts`). Order: What's
   new, Join the community, Support the project, Insights, Report a bug /
   request a feature, Host your own instance, Get the desktop app. Hidden
   cards leave no gap. Each card has its own pastel accent from the design
   system's accent set, used only for its icon tile.
3. **This instance** (section 8).
4. **Footer.** Small text links: License (AGPL-3.0), Security, Contributors,
   Source code on GitHub.

**Material.** Cards are content on the page, not floating controls, so they
are matte structural surfaces (`bg-surface-*`), following the Explore
`SpaceCard` as the nearest precedent, never glass. Calm: no gradients, no glow,
no 3D, no rims. Every outbound link is a plain
`<a href target="_blank" rel="noopener noreferrer">`; in the desktop app the
main process's `setWindowOpenHandler` (`desktop/src/main.ts:474-489`) turns
that into `shell.openExternal`, which is how `SourceCodeLink` already works.
No helper is added.

**Cards.**

| Card | Visible when | Action |
|---|---|---|
| What's new | always | "Read the release notes" to `releaseNotesUrl(version)` |
| Join the community | `PROJECT_LINKS.community !== null` | section 9 |
| Support the project | `PROJECT_LINKS.funding !== null` and instance info loaded with `supportCardEnabled === true` | "Support on Ko-fi" to `funding` |
| Insights | always | "Open insights" to `insights` |
| Report a bug / request a feature | always | two links: `bugReportUrl({ version, environment: describeEnvironment(navigator.userAgent, isElectron()) })` and `featureRequestUrl()` |
| Host your own instance | always | "Read the install guide" to `installGuide` |
| Get the desktop app | `!isElectron()` and `!useUIStore(s => s.isMobile)` | button that calls `openModal('userSettings', { tab: 'desktop' })`, which renders the existing `DesktopDownloadPanel` on the web (`UserSettings.tsx:283-287`) |

The Support card fails closed: while instance info is loading, or if it failed,
the card is hidden, because the admin may have turned it off.

---

## 8. "This instance"

A compact section below the grid, so nobody reads the Support card as "pay
this server's admin":

- Instance name (`info.name`) and domain (`window.location.host`).
- The existing `SourceCodeLink` component with `info.sourceCodeUrl`,
  `info.version`, `info.commit`. It already renders the version and, when
  `commit` is not null, the commit, and it is the AGPL §13 source offer that
  points at a fork's own source when the operator set `BACKSPACE_SOURCE_URL`.
  Nothing else in the section repeats the version.
- While info is loading or failed: the domain alone.

---

## 9. The community card

**Privacy.** The card contacts the community instance **only when the user
clicks Join**, never on page view. Opening the hub must not reveal the user's
IP to a third instance. So the card shows static copy (title, one line), not
the live space name, icon or member count. Pending-request state comes from
`exploreStore.fetchMyRequests()`, which contacts only the home instance and
instances the session is already connected to, so calling it on mount is
allowed.

**Origins.** Every origin comparison in this section goes through
`new URL(x).origin` on both sides, with a space's `_instanceOrigin` of `''`
read as `window.location.origin` first. "Home target" means
`normalize(target.origin) === normalize(window.location.origin)`.

**Static state.** One pure function in `CommunityCard.tsx`'s module (exported
for tests):

```ts
export type CommunityStatus = 'member' | 'pending' | 'not-member';
export function communityStatus(
  target: CommunityTarget,
  homeOrigin: string,
  spaces: readonly TaggedSpace[],        // spaceStore, `_instanceOrigin` '' = home
  myRequests: readonly TaggedJoinRequest[], // exploreStore.myRequests
): CommunityStatus;
```

`member` when a space has `id === target.spaceId` and a matching origin;
otherwise `pending` when a request with `status === 'pending'` matches on
(origin, `spaceId`), using the same (origin, id) match `useSpaceJoin` uses;
otherwise `not-member`. The card calls `fetchMyRequests()` once on mount.

**Card states.**

| State | Button | On click |
|---|---|---|
| `member` | "Open" | land in the space with the `landOnSpace` pattern of `SpaceInviteCard.tsx:60-67`: `setCurrentSpace`, then `setMobileTab('spaces')` when `isMobile`, then `navigate` |
| `pending` | "Request sent", disabled | |
| `not-member`, idle | "Join" | load the listing, below |
| loading | "Join" disabled with a spinner | |
| failed | "Try again", with a one-line note: `community.unreachable` or `community.notListed` | load the listing again |

**Loading the listing.** `fetch(`${target.origin}/api/directory/spaces`)` with
`AbortSignal.timeout(10_000)`. The endpoint is public, needs no auth, answers
200 whether or not the instance has a `DIRECTORY_ENDPOINT`, and reflects the
request origin in CORS (`server/src/index.ts:76`); CSP `connect-src` allows
`https:`. The response is remote input and is validated by a narrow parser in
the card's module (web has no `DirectoryDocument` parser): `schema === 1`, an
`instance` object with a string `name` and a boolean
`federatedRegistrationOpen`, and a `spaces` array whose matching element has
the `DirectoryDocumentSpace` fields with the right types (`visibility` is
`'public'` or `'request'`). A network error, a timeout, a non-2xx status or an
invalid document gives `unreachable`; a valid document without the space gives
`notListed`.

**Joining, remote target.** Build the entry as
`{ ...space, origin: target.origin, instanceName: document.instance.name,
federatedRegistrationOpen: document.instance.federatedRegistrationOpen }` (the
configured origin, never the document's claim; the result satisfies
`isDirectoryEntry` in `utils/directory.ts:77`) and call
`openModal('connectAndJoin', { entry })`, the dialog Outer Space cards use.
Connecting, the password step, account reuse, the request message and all
their errors stay in that one place. After a request the dialog closes and the
card shows `pending` once `myRequests` holds it: the card calls
`fetchMyRequests()` again when the modal closes (it watches
`uiStore.activeModal` leaving `'connectAndJoin'`).

**Joining, home target.** `exploreStore`'s API lookup treats only `''` as home
(`exploreStore.ts:102-108`), so the card builds a `TaggedExploreSpace`
`{ ...space, _instanceOrigin: '', joined: false }` and hands it to a child
component that runs `useSpaceJoin(space)` (`hooks/useSpaceJoin.ts`), the same
state machine the Explore `SpaceCard` uses. A public space: the child calls
`join()` once on mount (continuing the user's click) and lands with
`landOnSpace` on success. A request space: the child calls
`openRequestForm()` on mount and renders the request message field and send
button inline in the card the way `SpaceCard` does, then shows "Request sent"
from `isPending`. Errors show `joinError`.

After a successful join the space appears in `spaceStore`, so `communityStatus`
becomes `member` with no extra bookkeeping.

**Operational requirement.** The directory document lists a space only when
all of these hold (`directory/document.ts`): the instance has both
`directory_enabled` and `discovery_enabled` on; the space's visibility is
`public` or `request`; the space is `directory_listed`; and it is among the
first 200 listed spaces by member count (`DIRECTORY_MAX_SPACES`). The community
space must meet all four. This goes into the project-hub doc (section 12).

---

## 10. Mobile

- `MobileYouScreen.tsx`: the `actionRows` entries gain an optional
  `badge?: boolean`, rendered as the same dot at the row's trailing edge, and a
  "Backspace" row is added with the mark icon, `badge` set when
  `useHubUpdateState().state === 'updated'`, pushing the screen `backspace`.
- `MobileShell.tsx`'s screen map gains `backspace`: `MobileScreenHeader` titled
  `project:nav.label` above `ProjectHubPage`, the pattern of the
  `settings-instance-*` screens.
- `MobileBottomNav.tsx:89`: the You tab's dot condition
  `(pendingIncoming.length > 0 || updateBadge)` also includes the hub's
  `updated` state, otherwise mobile users rarely see it.
- The desktop card is hidden on the mobile layout (section 7).

---

## 11. Text

A new namespace **`project`** in
`packages/web/src/locales/{en,de,ru,zh}/project.json`, registered in
`packages/web/src/i18n/resources.ts` and typed through `i18next.d.ts` like the
existing namespaces. **All four languages are complete in the same change**:
the i18n check fails on a missing language, and a partly translated surface
should not ship. The check also fails when a de/ru/zh value is byte-identical
to English outside `scripts/i18n-allowlist.json`: a value that is genuinely
the same in a language (brand names such as "Backspace", "Ko-fi", "GitHub",
"AGPL-3.0"; "Insights" in German if kept) is added to the allowlist,
everything else is translated. German follows the settled vocabulary in the
existing `de` catalogs; Russian and Chinese match the register their existing
catalogs use.

Keys (English values are the source; the implementer may adjust wording but
not add persuasion copy, praise, em dashes or buzzwords):

- `nav.label` "Backspace", `nav.updatedDot` "Backspace was updated"
- `header.title` "Backspace", `header.tagline` "Open-source chat you can host yourself."
- `whatsNew.title` "What's new", `whatsNew.updated` "Updated to {{version}}", `whatsNew.current` "You're on {{version}}", `whatsNew.noVersion` "Release notes for every version", `whatsNew.action` "Read the release notes"
- `community.title` "Join the Backspace community", `community.body` "Talk to the people who build Backspace, ask questions and share feedback.", `community.join` "Join", `community.open` "Open", `community.pending` "Request sent", `community.retry` "Try again", `community.unreachable` "The community instance could not be reached.", `community.notListed` "The community space is not available right now."
- `support.title` "Support the project", `support.body` "Backspace is built in the open and funded by the people who use it.", `support.action` "Support on Ko-fi"
- `insights.title` "Insights", `insights.body` "Public numbers on downloads, instances and activity.", `insights.action` "Open insights"
- `report.title` "Report a bug or request a feature", `report.body` "Your version and browser are filled in for you.", `report.bug` "Report a bug", `report.feature` "Request a feature"
- `host.title` "Host your own instance", `host.body` "Run Backspace on your own server and invite who you want.", `host.action` "Read the install guide"
- `desktop.title` "Get the desktop app", `desktop.body` "Push to talk, global keybinds and activity status.", `desktop.action` "Download"
- `instance.title` "This instance"
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
  community instance and space, make sure it meets the three listing
  conditions in section 9, set `community`.
- `CLAUDE.md`: one row for `project-hub.md` in the subsystem table.
- `docs/systems/database.md`: the column.
- `docs/systems/api.md`: `supportCardEnabled` on `GET /api/instance/info` and
  on `GET`/`PATCH /api/settings/instance`.
- `docs/systems/admin.md`: the setting, one paragraph.
- `docs/systems/localization.md`: the `project` namespace in the namespace
  table.
- `docs/systems/mobile-ui.md`: the `backspace` screen in the screen map.

---

## 13. Testing

Each implementer tests their own work; the controller runs the full check at
the end.

- **Unit:** `releaseNotesUrl`, `bugReportUrl`, `featureRequestUrl`, the
  constant's well-formedness test, `describeEnvironment` over a table of real
  UA strings (Chrome, Edge, Opera, Firefox, Safari on macOS and iOS, Chrome on
  Android, the Electron UA), `hubUpdateState` over every row of section 4's
  table, `hubSeenVersion` with a throwing and a corrupt storage and a null
  user, `projectHubStore` switching users, `activeHomeNavItem`,
  `communityStatus`, the directory document parser with valid, malformed and
  missing-space inputs.
- **Server:** a fresh database has the column with 1; `GET /api/instance/info`
  carries the field; the admin PATCH round-trips it and rejects a non-boolean
  with `field_not_boolean`; a non-admin cannot change it.
- **Components** (@testing-library/react): exactly one home item selected on
  `/explore`, `/backspace` and the friends view; the dot shows only on
  `updated`; opening the page clears the dot while the card still says
  "Updated to"; the page hides the Support card when `funding` is null, when
  `supportCardEnabled` is false and while info is loading; hides the community
  card when `community` is null; hides the desktop card under Electron and on
  mobile; the community card walks idle, loading, unreachable, notListed,
  pending and member, opens `connectAndJoin` with the configured origin for a
  remote target, and runs `useSpaceJoin` for a home target.
- **Whole tree:** `pnpm typecheck` (which runs the i18n check), `pnpm lint`,
  the web and server test suites with exit code 0 (read the exit code, not the
  list), `pnpm dev` starts both server and frontend without errors.
- **Visual:** a design workbench following the existing convention (a root
  entry `packages/web/dev-project-hub.html` like `dev-explore.html`, and its
  page under `packages/web/src/dev/`) renders the page with both constants
  filled with test values and every card state, so it can be screenshotted at
  desktop and phone widths before the maintainer sees it.

---

## 14. What only the maintainer can do later

1. Create the Ko-fi page and put its URL in `PROJECT_LINKS.funding`.
2. Create the community instance and space; on the instance turn on both
   space discovery (`discovery_enabled`) and directory listing
   (`directory_enabled`); make the space public or by request and list it
   (`directory_listed`); keep it among the first 200 listed spaces by member
   count; and put `origin` and `spaceId` in `PROJECT_LINKS.community`.
