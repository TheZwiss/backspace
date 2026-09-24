# Project Hub (the Backspace page)

A page at `/backspace` about the Backspace project, not about the instance the
user is on. It holds cards for what changed in this version, the community
space, funding, the public insights page, bug reports and feature requests,
self-hosting, and the desktop app, then a short "This instance" section and
footer links. On desktop it is reached from the "Backspace" item in the DM
sidebar; on mobile from the "Backspace" row on the You screen, which pushes the
`backspace` screen.

The page links out and fetches no project data when it is viewed: release
notes are the GitHub release page, so an instance nobody administers still
never contacts github.com. The one outside request it can make is the
community card's Join, which reads the community instance's directory listing
after the click (see "Community card").

Source files:
- `packages/web/src/utils/projectLinks.ts` - `PROJECT_LINKS`, every outbound project URL, and the builders `releaseNotesUrl`, `bugReportUrl`, `featureRequestUrl`; `projectLinksProblems` checks the constant in CI
- `packages/web/src/utils/describeEnvironment.ts` - the browser and OS string prefilled into bug reports (English on purpose, it goes into a GitHub issue)
- `packages/web/src/utils/hubSeenVersion.ts` - the per-user seen-version record in localStorage
- `packages/web/src/stores/projectHubStore.ts` - `useProjectHubStore` and `hubUpdateState`, the one derived view
- `packages/web/src/hooks/useHubUpdateState.ts` - the hook every dot and the What's new card read
- `packages/web/src/hooks/useHomeInstanceInfo.ts` - the shared reader of `GET /api/instance/info` (version, `supportCardEnabled`); `invalidateHomeInstanceInfo` after an admin save marks the value stale and rereads it, keeping the old value on screen until the answer replaces it (and keeping it if the reread fails)
- `packages/web/src/utils/homeNav.ts` - `activeHomeNavItem`, which of Friends, Explore and Backspace is selected
- `packages/web/src/components/projectHub/` - `ProjectHubPage`, `HubCard`, `WhatsNewCard`, `CommunityCard`, `ReportCard`, `InstanceSection`, `BackspaceMark`, `HubUpdateDot`
- `packages/web/src/components/layout/ChannelSidebar.tsx` - the sidebar item; `MobileYouScreen.tsx` - the row; `MobileShell.tsx` - `MobileBackspaceScreen`; `MobileBottomNav.tsx` - the You tab dot
- `packages/web/src/locales/*/project.json` - the `project` namespace
- `packages/web/dev-project-hub.html`, `packages/web/src/dev/project-hub-preview.tsx` - the design workbench

---

## Links

Every URL the page opens lives in `PROJECT_LINKS` in `projectLinks.ts`. Read
it there; this document does not copy them. Links always point upstream. The
instance's own source offer (a fork's `BACKSPACE_SOURCE_URL`) comes from the
instance info and is shown only in "This instance".

`funding` holds the project's Ko-fi page; `community` ships as `null`. A null
value hides its card, so no card renders a dead link. `.github/FUNDING.yml`
names the same Ko-fi page for the repository's Sponsor button.
`projectLinks.test.ts` runs `projectLinksProblems`
over the real constant: every URL must parse and be `https:`, and
`community.origin` must be a bare origin with a non-empty `spaceId`.

---

## Cards

Order in the `.card-grid`: What's new, Join the community, Support the project,
Insights, Report a bug or request a feature, Host your own instance, Get the
desktop app. A hidden card leaves no gap.

| Card | Shown when |
|---|---|
| What's new | always; the text follows the table in the next section |
| Join the community | `PROJECT_LINKS.community` is set |
| Support the project | `PROJECT_LINKS.funding` is set and instance info has loaded with `supportCardEnabled: true`. Fails closed while info is loading or failed |
| Insights, Report, Host | always |
| Get the desktop app | not inside the desktop app and not on the mobile layout |

`supportCardEnabled` is the admin switch "Show the Support card" in the General
panel (see [admin.md](admin.md)). It hides that card and nothing else.

"This instance" shows the instance name, the domain and the existing
`SourceCodeLink` (version, commit, source offer). While info is loading or
failed it shows the domain alone.

Card conventions in `HubCard.tsx`, for any card added later:
- `HUB_ACTION` holds the three action styles: `primary` for a card's own in-app call to act (at most one per card), `quiet` for everything that navigates, `waiting` for a disabled state the user waits on.
- `HubLinkAction` is the outbound link action: a plain `target="_blank" rel="noopener noreferrer"` anchor in the `quiet` style with an arrow, which the desktop app opens in the system browser.

---

## Seen version and the update dot

The page, the sidebar item, the mobile row and the You tab agree on one
question: has the instance updated since this user last opened the page. The
record is stored per user id (`backspace_hub_seen_version_<userId>`), so two
accounts in one browser do not clear each other's dot. A storage that throws
reads as "none" and writes nothing, so the value lives in memory for the
session. A corrupt record (not JSON, or no non-empty `seenVersion`) also reads
as "none"; that is `first-run`, so the hook's `markSeen` overwrites it with
the running version as soon as the version is known.

| `version` (instance info) | `seenVersion` | `hubUpdateState` | Dot | What's new says |
|---|---|---|---|---|
| null (loading or failed) | any | `unknown` | no | `whatsNew.noVersion`, link to the release list |
| known | null | `first-run` | no | `whatsNew.current` |
| known | equal | `current` | no | `whatsNew.current` |
| known | different | `updated` | yes | `whatsNew.updated` |

"Different", not "older": a rollback is news too, and fork versions do not
order. On `first-run` the hook records the running version at once, so new
users, and every user on the day the page shipped, see no dot until the next
update.

Opening the page takes a snapshot of the state on arrival and then records the
version as seen. The card keeps saying "Updated to" for that visit while every
dot clears at once.

The dot is the brand primary 8px dot (`w-2 h-2 bg-accent-primary`), drawn by
one component, `HubUpdateDot` (it carries its own `nav.updatedDot` label and
takes a `className` for placement), on both the desktop sidebar item and the
mobile You-screen row. The mobile You tab in the bottom nav keeps its red
aggregate dot, which also lights for pending friend requests and instance
updates.

---

## Community card

**Privacy.** The card contacts the community instance only when the user
clicks Join, never on page view, so opening the page does not reveal the
user's IP to a third instance. The copy is static for that reason: no live
space name, icon or member count. On mount the card only calls
`fetchMyRequests()`, which reaches the home instance and instances the session
is already connected to.

| State | Button | Comes from |
|---|---|---|
| member | Open, lands in the space | a space in `spaceStore` with the target's (origin, id) |
| pending | "Request sent", disabled | a pending request in `exploreStore.myRequests` with the target's (origin, id) |
| idle | Join | neither |
| loading | Join, disabled, spinner | Join clicked, the listing request is out |
| unreachable | Try again, with `community.unreachable` | network error, 10 s timeout, non-2xx, a body that is not JSON, an invalid envelope, or a malformed entry for the space |
| notListed | Try again, with `community.notListed` | a valid envelope without the space |

Join reads `GET <origin>/api/directory/spaces` and validates it with
`parseDirectoryListing`: the envelope (`schema` 1, `instance.name`,
`instance.federatedRegistrationOpen`, a `spaces` array), then only the element
whose `id` is the target space, so a malformed space the card never shows
cannot block the join. For a remote target it opens the connect-and-join
dialog with the configured origin (never the document's own claim); after the
dialog closes the card asks for its join requests again, which is how a sent
request shows as pending. For a target on the home instance it runs
`useSpaceJoin` inside the card: a public space is joined, a request space
shows the message field inline.

---

## What the maintainer has to do

`PROJECT_LINKS.funding` is set, so one step remains: create the community
instance and space, then set `PROJECT_LINKS.community` to its `origin` and
`spaceId`. The directory document carries the space only when all three hold:
- the instance has space discovery on and allows listing in the directory (`discovery_enabled` and `directory_enabled`);
- the space is public or by request and is listed (`directory_listed`), which whoever may edit the space sets with `PATCH /api/spaces/:id` (the owner or a member with `MANAGE_SPACE`, see [directory.md](directory.md));
- it is among the first 200 listed spaces by member count (`DIRECTORY_MAX_SPACES` in `directory/document.ts`).

Otherwise the card says "not available right now". See
[directory.md](directory.md) for the document.

---

## Workbench

`http://localhost:5173/dev-project-hub.html` (`pnpm --filter @backspace/web dev`)
shows every state with the real components, the two constants filled with test
values, and the instance info and directory document answered locally.
`?state=<name>&width=desktop|phone` renders one frame; with no `width` the page
shows both frames side by side and a link per state. The state names are
listed at the top of `project-hub-preview.tsx`.
