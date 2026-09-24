# Project Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every implementer and reviewer runs with `model: "opus"`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the DM sidebar's "Coming Soon" placeholder with a "Backspace" page of project cards (what's new, community, support, insights, report, host, desktop), an admin switch for the Support card, and a mobile entry.

**Architecture:** One server column exposed on two existing endpoints; web-side pure helpers and one shared "seen version" derived view; a page under `components/projectHub/` routed at `/backspace` and reused as a mobile screen; the community card reuses the existing connect-and-join dialog and `useSpaceJoin`.

**Tech Stack:** Fastify 4, Drizzle (SQLite), React 18, Zustand 5, Tailwind 3, i18next, Vitest + @testing-library/react.

**Spec:** `docs/superpowers/specs/2026-09-24-project-hub-design.md`. Every implementer reads the spec sections named in their task before writing code. The spec wins over this plan if they disagree; report the disagreement.

**Plan format decision:** briefs, not code, by the maintainer's instruction. Contracts between tasks (DDL, wire fields, error codes, exported names and signatures) are given verbatim below; implementers write all code and tests themselves.

## Global Constraints

- Worktree: `/Users/jbraun/backspace-public/.claude/worktrees/project-hub`, branch `feat/project-hub`. Run every command there. Never `cd` into the main checkout. Commit with `git add <explicit paths>`, never `-a`/`-A`. Do not push.
- TypeScript strict, no `any`, no TODO, no placeholder code, no new dependencies.
- Read `CLAUDE.md` and `docs/systems/design-system.md` before UI work. Cards are matte `bg-surface-*`, never glass; card lists use `.card-grid`; `md:` is forbidden in the app shell (`platform/viewportTokens.test.ts`); use `desktop:` if a breakpoint is needed.
- Every user-facing string goes through i18next. Any string added to a catalog is added to en, de, ru and zh in the same commit. A non-English value identical to English must be in `scripts/i18n-allowlist.json` or translated.
- Copy: no em dashes, no praise or persuasion words, no buzzwords.
- Outbound links: plain `<a href target="_blank" rel="noopener noreferrer">`.
- Tests: run the package suite you touched and read the **exit code**; a list of green tests with exit 1 is a failure. Web tests: `pnpm --filter @backspace/web exec vitest run <paths>`; server: `pnpm --filter @backspace/server exec vitest run <paths>`. Before reporting done, also run `pnpm typecheck` (includes the i18n check) and `pnpm lint`.
- Report at the end: files changed, tests added (names), commands run with exit codes, anything in the spec you could not follow and why.

## Review Focus

1. A user with two accounts in one browser: one account opening the page must not clear the other's dot (per-user storage key). Test in Task 2.
2. Private-mode browser where `localStorage` throws: no crash, no dot, page renders. Test in Task 2.
3. Instance info request fails: Support card hidden, What's new says `noVersion` and links to the release list, sidebar shows no dot. Tests in Tasks 2 and 5.
4. Community instance returns garbage JSON, a 500, hangs past 10s, or omits the space: card shows the right note and "Try again" works. Test in Task 4.
5. Being on `/backspace` highlights exactly one home item and the `@me` rail item; going to `/explore` or a DM moves the highlight. Test in Task 6.

---

## Contracts (verbatim, shared by all tasks)

```ts
// packages/shared/src/types.ts: additions
interface InstanceInfoResponse { /* existing fields */ supportCardEnabled: boolean; }
interface InstanceAdminSettings { /* existing fields */ supportCardEnabled: boolean; }
```

```ts
// packages/server/src/db/schema.ts, instanceSettings table
supportCardEnabled: integer('support_card_enabled', { mode: 'boolean' }).notNull().default(true),
```
Admin PATCH error for a non-boolean: `sendError(reply, 400, 'field_not_boolean', { field: 'supportCardEnabled' })`.

```ts
// packages/web/src/utils/projectLinks.ts
export interface CommunityTarget { origin: string; spaceId: string; }
export interface ProjectLinks {
  repository: string; insights: string; installGuide: string; releases: string;
  license: string; security: string; contributors: string;
  funding: string | null; community: CommunityTarget | null;
}
export const PROJECT_LINKS: ProjectLinks;
export function releaseNotesUrl(version: string | null): string;
export function bugReportUrl(fields: { version: string | null; environment: string }): string;
export function featureRequestUrl(): string;

// packages/web/src/utils/describeEnvironment.ts
export function describeEnvironment(userAgent: string, isDesktopApp: boolean): string;

// packages/web/src/utils/hubSeenVersion.ts
type HubStorage = Pick<Storage, 'getItem' | 'setItem'>;
export function hubSeenVersionKey(userId: string): string; // `backspace_hub_seen_version_${userId}`
export function readHubSeenVersion(storage: HubStorage, userId: string | null): string | null;
export function writeHubSeenVersion(storage: HubStorage, userId: string | null, version: string): void;

// packages/web/src/stores/projectHubStore.ts
export type HubUpdateState = 'unknown' | 'first-run' | 'current' | 'updated';
export function hubUpdateState(seenVersion: string | null, version: string | null): HubUpdateState;
export const useProjectHubStore: UseBoundStore<StoreApi<{
  userId: string | null;
  seenVersion: string | null;
  load: (userId: string | null) => void;
  markSeen: (version: string) => void;
}>>;

// packages/web/src/hooks/useHomeInstanceInfo.ts
export function useHomeInstanceInfo(): InstanceInfoResponse | null;
export function invalidateHomeInstanceInfo(): void;

// packages/web/src/hooks/useHubUpdateState.ts
export function useHubUpdateState(): { state: HubUpdateState; version: string | null };

// packages/web/src/utils/homeNav.ts
export type HomeNavItem = 'friends' | 'explore' | 'backspace';
export function activeHomeNavItem(pathname: string, currentChannelId: string | null): HomeNavItem | null;

// packages/web/src/components/projectHub/CommunityCard.tsx
export type CommunityStatus = 'member' | 'pending' | 'not-member';
export function communityStatus(target: CommunityTarget, homeOrigin: string,
  spaces: readonly TaggedSpace[], myRequests: readonly TaggedJoinRequest[]): CommunityStatus;
export function parseDirectoryDocument(payload: unknown): DirectoryDocument | null;
export function CommunityCard(props: { target: CommunityTarget }): JSX.Element;

// packages/web/src/components/projectHub/ProjectHubPage.tsx
export function ProjectHubPage(props: { links?: ProjectLinks; showTopBar?: boolean }): JSX.Element;
```

i18n namespace `project`, keys exactly as listed in spec section 11 (including `community.pending`). Admin keys: two new keys in `admin.json` next to the existing GeneralPanel keys; Task 1 picks their names and reports them.

---

### Task 1: Server column, endpoints and the admin switch

**Spec:** sections 3, 11 (admin strings), 12 (database.md, api.md, admin.md).

**Files:**
- Modify: `packages/server/src/db/schema.ts`, `packages/shared/src/types.ts`, `packages/server/src/routes/instance.ts`, `packages/server/src/routes/settings.ts`, `packages/web/src/components/modals/instanceSettingsPanels/GeneralPanel.tsx`, `packages/web/src/locales/{en,de,ru,zh}/admin.json`
- Create: `packages/server/drizzle/0017_*.sql` and the `drizzle/meta` updates, both via `pnpm --filter @backspace/server db:generate` (never hand-written)
- Tests: extend `packages/server/src/routes/instance.test.ts`, the settings route test file next to `settings.ts` (find it; create `settings.supportCard.test.ts` if the existing one is unsuitable), and a GeneralPanel test following `GeneralPanel.directory.test.tsx`
- Docs: `docs/systems/database.md`, `docs/systems/api.md`, `docs/systems/admin.md`

- [ ] Read `0016_whole_loki.sql` and how `directory_browse_enabled` / `directoryBrowseEnabled` flows through schema, `rowToAdminSettings`, the PATCH validation, `InstanceAdminSettings` and `GeneralPanel`. Mirror that flow exactly for `supportCardEnabled`.
- [ ] Write failing server tests: info carries `supportCardEnabled: true` on a fresh DB; admin GET carries it; admin PATCH `false` persists and info then reports `false`; PATCH `"no"` gets 400 `field_not_boolean`; a non-admin PATCH is refused as the route already refuses non-admins. Run, confirm they fail for the right reason.
- [ ] Add the column, generate the migration, extend the types, the info route, the mapper and the PATCH. Run the tests to green.
- [ ] GeneralPanel: a switch in the same style as the neighbouring toggles, with label and description from spec section 11 (en, de, ru, zh). Test: the switch reflects the loaded value and a toggle is sent in the PATCH body.
- [ ] Update the three docs (column; field on both endpoints; one admin.md paragraph saying it hides only the card and that the card also stays hidden until the project's Ko-fi link exists).
- [ ] Run server and web suites for touched files, `pnpm typecheck`, `pnpm lint`. Commit: `feat(admin): setting to hide the Support card`.

### Task 2: Web foundations (links, environment, seen version, instance info, home nav)

**Spec:** sections 2, 4, 5, 6 (the `activeHomeNavItem` function only).

**Consumes:** `InstanceInfoResponse.supportCardEnabled` from Task 1.
**Produces:** everything in the Contracts block under `utils/projectLinks.ts`, `utils/describeEnvironment.ts`, `utils/hubSeenVersion.ts`, `stores/projectHubStore.ts`, `hooks/useHomeInstanceInfo.ts`, `hooks/useHubUpdateState.ts`, `utils/homeNav.ts`.

**Files:** create those seven files and a colocated `*.test.ts(x)` for each; modify `GeneralPanel.tsx` to call `invalidateHomeInstanceInfo()` after a successful save.

- [ ] Read `utils/updateAck.ts` (+ its test) and follow its shape and comment style for `hubSeenVersion.ts`. Read how `ExplorePage` / `UserSettings` call `GET /api/instance/info` on the home API client and use the same client call.
- [ ] `PROJECT_LINKS` values exactly as the spec's comments; `funding: null`, `community: null`. Tests: builder outputs (`1.5.1` → tag URL; `1.5.1-dev`, `custom`, `''`, `null` → releases; bug URL decodes back to `template=bug_report.yml`, the version and environment, and omits version when null; feature URL) and the well-formedness test over the real constant (spec section 2), written so it also validates non-null `funding`/`community` shapes via a small exported validator the test calls on sample values.
- [ ] `describeEnvironment`: table test over real UA strings for Chrome/Windows, Edge/Windows, Opera/Windows, Firefox/Linux, Firefox/macOS, Safari/macOS, Safari/iOS, Chrome/Android, Chrome/ChromeOS, the Electron desktop UA with `isDesktopApp: true`, an unknown UA.
- [ ] `hubSeenVersion`: null user, throwing `getItem`/`setItem`, corrupt value, two users do not share a value.
- [ ] `projectHubStore` + `hubUpdateState`: every row of the spec section 4 table; `load` for user A then user B swaps `seenVersion`; `markSeen` writes storage for the loaded user only and is a no-op with no user.
- [ ] `useHomeInstanceInfo`: two concurrent subscribers → one request; success cached (unmount + remount → no second request); failure → null, next mount retries; `invalidateHomeInstanceInfo` refetches while subscribed. Export a test-only reset if module state needs it, named `__resetHomeInstanceInfoForTests`.
- [ ] `useHubUpdateState`: first-run calls `markSeen` once and yields no dot; stored older version yields `updated`; failed info yields `unknown`.
- [ ] `activeHomeNavItem`: `/explore`, `/backspace`, `/channels/@me` with and without channel, a space channel path.
- [ ] GeneralPanel test: after a successful save `invalidateHomeInstanceInfo` is called; not after a failed one.
- [ ] Run tests, typecheck, lint. Commit: `feat(web): project hub foundations`.

### Task 3: The `project` translation namespace

**Spec:** section 11; `docs/systems/localization.md` for registration and the check.

**Files:** create `packages/web/src/locales/{en,de,ru,zh}/project.json`; modify `packages/web/src/i18n/resources.ts`, `packages/web/src/i18next.d.ts` (or wherever namespaces are typed), `scripts/i18n-allowlist.json` if needed, `docs/systems/localization.md` (namespace table).

- [ ] Read how an existing small namespace (e.g. `telemetry`) is registered, typed and lazy-loaded; copy that exactly.
- [ ] Write the four catalogs with every key in spec section 11. German: match terms already used in `de/*.json` (grep before choosing a word). Russian and Chinese: match their catalogs' register (check `ru/common.json`, `zh/common.json` for how "you" and imperatives are phrased).
- [ ] Allowlist only values that are genuinely the same across languages (brand names, "Ko-fi", "GitHub", "AGPL-3.0"); translate everything else.
- [ ] Run `node scripts/check-i18n.mjs` (or the script `pnpm typecheck` calls; find it) with exit 0, `pnpm typecheck`, `pnpm lint`. Commit: `feat(i18n): project namespace`.

### Task 4: The community card

**Spec:** section 9 in full; sections 2 and 7 for the card shell look.

**Consumes:** `CommunityTarget` (Task 2), `project` keys (Task 3).
**Produces:** `CommunityCard`, `communityStatus`, `parseDirectoryDocument` (Contracts), and `HubCard` below, which Task 5 uses for every other card.

**Files:** create `packages/web/src/components/projectHub/HubCard.tsx`, `CommunityCard.tsx`, `CommunityCard.test.tsx`, `HubCard.test.tsx` if HubCard has logic.

`HubCard` contract (Task 5 depends on it verbatim):
```ts
export type HubAccent = 'lavender' | 'mint' | 'peach' | 'sky' | 'amber' | 'rose' | 'coral';
export function HubCard(props: {
  accent: HubAccent; icon: ReactNode; title: string; body?: ReactNode;
  children?: ReactNode; // action area
}): JSX.Element;
```
Accent maps to the design system's pastel tokens (read `tailwind.config` and design-system.md for the token names), used only on the icon tile. Matte surface, rounded like Explore's `SpaceCard`.

- [ ] Read `ExplorePage.tsx`, `SpaceCard.tsx`, `hooks/useSpaceJoin.ts`, `modals/ConnectAndJoinModal.tsx`, `utils/directory.ts` (`isDirectoryEntry`), `SpaceInviteCard.tsx:60-67` (`landOnSpace`), `exploreStore.ts` (`myRequests`, `fetchMyRequests`, `TaggedJoinRequest`, origin handling at 102-108), `spaceStore.ts` (`TaggedSpace`).
- [ ] Failing tests first for `parseDirectoryDocument` (valid; wrong schema; missing instance; bad visibility; non-object) and `communityStatus` (member via home `''` origin; member via remote origin with trailing-slash/case variants normalised by `new URL().origin`; pending; not-member; a same-id space on a different origin is not a match).
- [ ] Component tests with mocked `fetch` and stores: idle shows Join; click → loading; 500 → unreachable note + Try again; invalid JSON → unreachable; timeout (fake timers or an aborted signal) → unreachable; valid doc without space → notListed; valid remote doc → `openModal('connectAndJoin', { entry })` with `entry.origin === target.origin` even when the document claims another origin; modal closing triggers `fetchMyRequests` again; pending shows disabled "Request sent"; member shows Open and landing calls `setCurrentSpace` then `navigate` (and `setMobileTab('spaces')` when `isMobile`); home target public space → `publicJoin` called via `useSpaceJoin`; home target request space → inline request form, send → pending; no `fetch` happens on mount (privacy rule).
- [ ] Implement until green. Run tests, typecheck, lint. Commit: `feat(web): community card for the project hub`.

### Task 5: The page and the route

**Spec:** sections 6 (route only), 7, 8.

**Consumes:** Tasks 2, 3, 4.
**Produces:** `ProjectHubPage` (Contracts), route `/backspace`.

**Files:** create `components/projectHub/ProjectHubPage.tsx`, `WhatsNewCard.tsx`, `ReportCard.tsx`, `InstanceSection.tsx`, `ProjectHubPage.test.tsx`; modify `packages/web/src/App.tsx`, `packages/web/src/components/layout/MainContent.tsx`.

- [ ] Read `ExplorePage.tsx` for the frame (top bar, `MemberListToggleButton`, `p-6`, `.card-grid`) and `MainContent.tsx:185-190` for the early return; `SourceCodeLink` for section 8.
- [ ] Icons: inline SVG, 24px, `currentColor`, one per card, simple outline style matching the sidebar icons. Accents: What's new lavender, community mint, support peach, insights sky, report amber, host coral, desktop rose.
- [ ] Failing tests: snapshot of `useHubUpdateState` on mount then `markSeen` (card keeps "Updated to 1.5.1" after the store clears the dot); Support card hidden when `links.funding` null / `supportCardEnabled` false / info loading / info failed, shown with both set; community card absent when `links.community` null; desktop card hidden under `isElectron()` and when `isMobile`, and its button opens `userSettings` with `{ tab: 'desktop' }`; What's new link is `releaseNotesUrl(version)`, and with failed info shows `noVersion` and links to releases; Report links carry the prefilled params; instance section shows name + domain + `SourceCodeLink`, domain alone when info failed; `showTopBar={false}` omits the bar; every `target="_blank"` link has `rel="noopener noreferrer"`.
- [ ] Implement until green. Add the route and the MainContent branch; confirm `/explore` still renders Explore.
- [ ] Run tests, typecheck, lint. Commit: `feat(web): project hub page`.

### Task 6: Sidebar item, selection and the rail

**Spec:** section 6.

**Consumes:** `activeHomeNavItem`, `useHubUpdateState` (Task 2), `project` keys (Task 3), route (Task 5).

**Files:** modify `packages/web/src/components/layout/ChannelSidebar.tsx`, `packages/web/src/components/layout/SpaceSidebar.tsx`, `packages/web/src/locales/{en,de,ru,zh}/spaces.json` (remove `sidebar.dmList.comingSoon`); test file for the sidebar items (find an existing ChannelSidebar/SpaceSidebar test to extend, or create `ChannelSidebar.homeNav.test.tsx`).

- [ ] Replace the four inline selection expressions (lines ~451-472) with `activeHomeNavItem`. Replace the placeholder item with the Backspace item (mark path from `assets/brand/mark-mono-light.svg`, `fill="currentColor"`, 24px box), navigating to `/backspace`, with the dot and its `aria-label` from `project:nav.updatedDot` on `updated`.
- [ ] Rail `@me` active on `showDms || activeHomeNavItem(...) === 'backspace'`; the rail's Explore action untouched.
- [ ] Tests: exactly one of the three items has the selected class on `/explore`, `/backspace`, `/channels/@me`; `@me` rail item active on `/backspace`, not on `/explore`; dot present only for `updated`; clicking the item navigates to `/backspace`.
- [ ] Grep the tree to confirm `comingSoon` is referenced nowhere. Run tests, typecheck, lint. Commit: `feat(web): Backspace item in the DM sidebar`.

### Task 7: Mobile entry

**Spec:** section 10.

**Files:** modify `MobileYouScreen.tsx`, `MobileShell.tsx`, `MobileBottomNav.tsx`; tests next to them (extend existing ones where present).

- [ ] `actionRows` gains optional `badge?: boolean` rendered as a trailing dot; add the Backspace row (mark icon at the rows' `w-5 h-5`) pushing `backspace`, badge from `useHubUpdateState().state === 'updated'`.
- [ ] `MobileShell` screen map: `backspace` → `MobileScreenHeader` titled `project:nav.label` over `<ProjectHubPage showTopBar={false} />`, pattern of `settings-instance-*`.
- [ ] `MobileBottomNav` You-tab dot also on `updated`.
- [ ] Tests: row renders and pushes `backspace`; badge only on `updated`; screen renders the page without its top bar; You-tab dot on `updated` alone.
- [ ] Run tests, typecheck, lint. Commit: `feat(mobile): Backspace screen`.

### Task 8: Workbench and docs

**Spec:** sections 12, 13 (Visual).

**Files:** create `packages/web/dev-project-hub.html`, `packages/web/src/dev/<name>.tsx` following `dev-explore.html` and its dev page exactly (read them and any Vite config that lists dev entries); create `docs/systems/project-hub.md`; modify `CLAUDE.md` (subsystem table row), `docs/systems/mobile-ui.md` (screen map).

- [ ] Workbench renders `ProjectHubPage` with `links` filled (`funding: 'https://ko-fi.com/example'`, `community: { origin: 'https://community.example.org', spaceId: 'example' }`) and store/fetch stubs so every card state can be selected: hub `updated` vs `current`; Support on/off; community idle, loading, unreachable, notListed, pending, member; info failed. A width toggle or two frames (desktop ~1200px, phone 390px). Follow the dev pages' convention for copy (exempt from the literal-string rule).
- [ ] `project-hub.md`: what the page is; links live in `projectLinks.ts` (no URLs copied); the seen-version table; community states and the click-only privacy rule; the three listing conditions; the maintainer's two setup steps. Plain, short, no em dashes.
- [ ] Start the workbench with the dev server and confirm it loads without console errors. Run typecheck, lint. Commit: `docs: project hub`.

---

## Final verification (controller)

- [ ] `pnpm typecheck`, `pnpm lint`, full web and server suites, exit codes read.
- [ ] `pnpm dev`: server and frontend start clean; sign in, open `/backspace`, walk the cards.
- [ ] Screenshot the workbench at desktop and phone widths in the main states and look at them before showing the maintainer.
- [ ] Whole-branch review by a fresh Opus reviewer.
