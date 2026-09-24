// Dev-only workbench for the Backspace page (`/backspace`) and its two entry
// points. Nothing in the app imports this file; `dev-project-hub.html` is its
// only entry. It exists so every card state can be looked at and
// screenshotted at desktop and phone width without a server, a Ko-fi page or
// a community instance.
//
// `?state=<name>&width=desktop|phone` renders one state in one frame:
//   desktop  a 1200px window: the home sidebar (312px, the rail's 72px left
//            as padding, as AppLayout hosts it) next to the page with its top
//            bar, the router at `/backspace`.
//   phone    a 390px phone: `MobileBackspaceScreen`, the component
//            MobileShell's `backspace` screen renders (header and page), with
//            `uiStore.isMobile` on.
// The frame is pinned to its width and its `data-viewport` to its kind, so a
// window that cannot go down to 390 (headless Chrome's floor is 500) still
// renders the phone layout; screenshot the left 390px.
//
// With no `width`, the page is an overview: a link per state and both frames
// of the chosen state side by side in iframes.
//
// States (the `STATES` table below says the same thing on screen):
//   current                 default. Version already seen, Support on,
//                           community idle (Join).
//   updated                 the stored seen version is older, so What's new
//                           says "Updated to". Opening the page marks it
//                           seen, which is why the sidebar dot next to it is
//                           already gone.
//   shipping                the real PROJECT_LINKS: funding is set, community
//                           is null, so the community card is hidden.
//   support-off             funding set, the admin turned the card off.
//   info-failed             GET /api/instance/info fails: no version, no
//                           Support card, the domain alone under This
//                           instance.
//   community-loading       Join clicked, the listing never answers.
//   community-unreachable   Join clicked, the listing answers 503.
//   community-not-listed    Join clicked, a valid document without the space.
//   community-pending       a pending join request for the space.
//   community-member        the space is among the user's spaces: Open.
//   community-request-form  the space is on the home instance and joined by
//                           request: Join opens the inline request form.
//   entry-updated           the entry points before the page is opened: the
//                           sidebar item (desktop) or the You screen row and
//                           You tab (phone) with the update dot.
//
// Every card is the real component. What is replaced is the edge: the fetch
// of the instance info and of the community instance's directory document is
// answered locally, the store actions that would reach a server are no-ops,
// and the seen version is written to localStorage before the page mounts.
// Where a state needs a click (the community listing states), the harness
// clicks Join the way a user would.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryDocument, InstanceInfoResponse, User } from '@backspace/shared';
import { ProjectHubPage } from '../components/projectHub/ProjectHubPage';
import { ChannelSidebar } from '../components/layout/ChannelSidebar';
import { MobileYouScreen } from '../components/layout/MobileYouScreen';
import { MobileBottomNav } from '../components/layout/MobileBottomNav';
import { MobileBackspaceScreen } from '../components/layout/MobileShell';
import { useAuthStore } from '../stores/authStore';
import { useExploreStore, type TaggedJoinRequest } from '../stores/exploreStore';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { PROJECT_LINKS, type CommunityTarget, type ProjectLinks } from '../utils/projectLinks';
import { browserHubStorage, writeHubSeenVersion } from '../utils/hubSeenVersion';
import i18n, { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

const STATES = {
  current: 'Version already seen, Support on, community idle (Join).',
  updated: 'Seen version is older: What\'s new says "Updated to". The page marks it seen, so the sidebar dot is gone.',
  shipping: 'The real PROJECT_LINKS: funding set, community null, community card hidden.',
  'support-off': 'Funding set, the admin turned the Support card off.',
  'info-failed': 'Instance info request fails: no version, no Support card, domain only.',
  'community-loading': 'Join clicked, the listing never answers.',
  'community-unreachable': 'Join clicked, the listing answers 503.',
  'community-not-listed': 'Join clicked, a valid document without the space.',
  'community-pending': 'A pending join request for the space.',
  'community-member': 'The space is among the user\'s spaces: Open.',
  'community-request-form': 'Space on the home instance, joined by request: Join opens the inline form.',
  'entry-updated': 'Before the page is opened: sidebar item, You row and You tab with the update dot.',
} as const satisfies Record<string, string>;

type HubState = keyof typeof STATES;
type FrameWidth = 'desktop' | 'phone';

/** CSS pixels of each frame: a small desktop window and a phone. */
const FRAME_PX: Record<FrameWidth, number> = { desktop: 1200, phone: 390 };
/** Height of each frame in the overview; a single frame takes the window's height. */
const FRAME_HEIGHT_PX: Record<FrameWidth, number> = { desktop: 820, phone: 844 };

function isHubState(value: string | null): value is HubState {
  return value !== null && Object.prototype.hasOwnProperty.call(STATES, value);
}

function readState(search: string): HubState {
  const value = new URLSearchParams(search).get('state');
  return isHubState(value) ? value : 'current';
}

/** The frame to render, or null for the overview. */
function readWidth(search: string): FrameWidth | null {
  const value = new URLSearchParams(search).get('width');
  return value === 'desktop' || value === 'phone' ? value : null;
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const VERSION = '1.5.1';
const PREVIOUS_VERSION = '1.5.0';

const COMMUNITY_ORIGIN = 'https://community.example.org';
const COMMUNITY_SPACE_ID = 'example';

/** Test values for the two optional links, so every card state can be shown. */
const FILLED_LINKS: ProjectLinks = {
  ...PROJECT_LINKS,
  funding: 'https://ko-fi.com/example',
  community: { origin: COMMUNITY_ORIGIN, spaceId: COMMUNITY_SPACE_ID },
};

/**
 * The links for a state. The request-form state points the community at the
 * page's own origin, because the inline request form is the home-instance
 * path; a remote target hands off to the connect-and-join dialog instead.
 */
function linksFor(state: HubState): ProjectLinks {
  if (state === 'shipping') return PROJECT_LINKS;
  if (state === 'community-request-form') {
    return { ...FILLED_LINKS, community: { origin: window.location.origin, spaceId: COMMUNITY_SPACE_ID } };
  }
  return FILLED_LINKS;
}

const INSTANCE_INFO: InstanceInfoResponse = {
  name: 'Workbench',
  version: VERSION,
  registrationOpen: true,
  federatedRegistrationOpen: true,
  instanceId: 'workbench',
  sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
  commit: null,
  directoryConfigured: true,
  directoryAvailable: true,
  directoryEnabled: true,
  supportCardEnabled: true,
};

/** The signed-in user; the seen version is stored under this id. */
const HOME_USER: User = {
  id: 'workbench-user',
  username: 'jannis',
  displayName: 'Jannis',
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: 'lavender',
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: 1,
  homeInstance: 'home.example',
  homeUserId: null,
  replicatedInstances: [],
};

/** The community instance's directory document, with or without the space. */
function directoryDocument(target: CommunityTarget, withSpace: boolean): DirectoryDocument {
  return {
    schema: 1,
    origin: target.origin,
    instance: { name: 'Backspace Community', federatedRegistrationOpen: true, version: VERSION },
    spaces: withSpace
      ? [{
        id: target.spaceId,
        name: 'Backspace',
        description: 'The project space.',
        icon: null,
        banner: null,
        avatarColor: 'mint',
        visibility: 'request',
        memberCount: 42,
        createdAt: 1,
      }]
      : [],
  };
}

const COMMUNITY_SPACE: TaggedSpace = {
  id: COMMUNITY_SPACE_ID,
  name: 'Backspace',
  icon: null,
  banner: null,
  avatarColor: 'mint',
  ownerId: 'maintainer',
  inviteCode: null,
  visibility: 'request',
  directoryListed: true,
  description: 'The project space.',
  createdAt: 1,
  _instanceOrigin: COMMUNITY_ORIGIN,
};

const PENDING_REQUEST: TaggedJoinRequest = {
  id: 'workbench-request',
  spaceId: COMMUNITY_SPACE_ID,
  userId: HOME_USER.id,
  message: null,
  status: 'pending',
  decidedBy: null,
  createdAt: 1,
  decidedAt: null,
  _instanceOrigin: COMMUNITY_ORIGIN,
};

// ─── Network stubs ──────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Answers the two requests the page makes. The instance info fails only in
 * `info-failed`, as a proxy with no server behind it would. The directory
 * document answers per community state; in `community-loading` it never
 * answers and ignores the card's abort signal, so the spinner stays on screen
 * to be looked at instead of turning into "unreachable" after ten seconds.
 * Every other request goes through untouched.
 */
function installFetch(state: HubState, links: ProjectLinks): void {
  const realFetch = window.fetch.bind(window);
  const target = links.community;
  const listingUrl = target === null ? null : `${target.origin}/api/directory/spaces`;

  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/instance/info')) {
      if (state === 'info-failed') {
        return Promise.resolve(jsonResponse({ error: 'Bad Gateway', statusCode: 502 }, 502));
      }
      const info = state === 'support-off' ? { ...INSTANCE_INFO, supportCardEnabled: false } : INSTANCE_INFO;
      return Promise.resolve(jsonResponse(info));
    }
    if (target !== null && url === listingUrl) {
      if (state === 'community-loading') return new Promise<Response>(() => {});
      if (state === 'community-unreachable') {
        return Promise.resolve(jsonResponse({ error: 'Service Unavailable', statusCode: 503 }, 503));
      }
      return Promise.resolve(jsonResponse(directoryDocument(target, state !== 'community-not-listed')));
    }
    return realFetch(input, init);
  };
}

// ─── Stores ─────────────────────────────────────────────────────────────────

function seedStores(state: HubState, width: FrameWidth): void {
  useAuthStore.setState({ user: HOME_USER });

  // Written before anything mounts, so `useHubUpdateState`'s load reads it.
  const seen = state === 'updated' || state === 'entry-updated' ? PREVIOUS_VERSION : VERSION;
  writeHubSeenVersion(browserHubStorage, HOME_USER.id, seen);

  useSpaceStore.setState({ spaces: state === 'community-member' ? [COMMUNITY_SPACE] : [] });

  useExploreStore.setState({
    myRequests: state === 'community-pending' ? [PENDING_REQUEST] : [],
    fetchMyRequests: async () => {},
    // The home-target join actions. They never settle, so a click on Send
    // Request shows the sending state and nothing leaves the page.
    requestJoin: () => new Promise(() => {}),
    publicJoin: () => new Promise(() => {}),
  });

  useUIStore.setState({
    // The desktop card is left out on the mobile layout; this is what says so.
    isMobile: width === 'phone',
    // The You row and the page's phone entry are reached from the You tab.
    mobileScreen: 'you',
  });
}

/**
 * `initializeInterfaceScale` sets `data-viewport` from the window width on
 * every resize. The frame decides it here instead, after that listener, so a
 * phone frame in a wide window still gets the mobile rules and the one-column
 * card grid.
 */
function pinViewport(width: FrameWidth): void {
  const kind = width === 'phone' ? 'mobile' : 'desktop';
  const pin = () => { document.documentElement.dataset.viewport = kind; };
  window.addEventListener('resize', pin);
  pin();
}

// ─── Drivers ────────────────────────────────────────────────────────────────

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForElement<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const found = find();
    if (found) return found;
    await nextFrame();
  }
  throw new Error(what);
}

/** The community states that start with the user's click on Join. */
function needsJoinClick(state: HubState): boolean {
  return state === 'community-loading'
    || state === 'community-unreachable'
    || state === 'community-not-listed'
    || state === 'community-request-form';
}

/** Clicks the community card's Join, found by its label in the active language. */
async function clickJoin(): Promise<void> {
  const label = i18n.t('project:community.join');
  const button = await waitForElement(
    () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === label && !b.disabled,
    ),
    'the community card has no Join button',
  );
  button.click();
}

// ─── Frames ─────────────────────────────────────────────────────────────────

function DesktopFrame({ state, links }: { state: HubState; links: ProjectLinks }) {
  return (
    <div style={{ width: FRAME_PX.desktop, height: 'calc(100 * var(--app-vh))', display: 'flex' }}>
      <div className="flex w-[312px] flex-shrink-0">
        <ChannelSidebar />
      </div>
      <div className="flex-1 min-w-0 flex overflow-hidden">
        {state === 'entry-updated'
          ? <div className="flex-1 bg-surface-chat" />
          : <ProjectHubPage links={links} />}
      </div>
    </div>
  );
}

/**
 * The phone frame: MobileShell's `backspace` screen (the component its screen
 * map entry renders, given the state's links), or for `entry-updated` the You
 * screen above the bottom nav, as the You tab shows them.
 */
function PhoneFrame({ state, links }: { state: HubState; links: ProjectLinks }) {
  const style = { width: FRAME_PX.phone, height: 'calc(100 * var(--app-vh))' };
  if (state === 'entry-updated') {
    return (
      <div style={style} className="flex flex-col bg-surface-base">
        <div className="flex-1 min-h-0 overflow-y-auto">
          <MobileYouScreen />
        </div>
        <MobileBottomNav />
      </div>
    );
  }
  return (
    <div style={style} className="flex flex-col">
      <MobileBackspaceScreen links={links} />
    </div>
  );
}

// ─── Overview ───────────────────────────────────────────────────────────────

/** Both frames of one state side by side, and a link to every state. */
function Overview({ state }: { state: HubState }) {
  const frames: FrameWidth[] = ['desktop', 'phone'];
  return (
    <div className="min-h-screen bg-surface-base p-6 flex flex-col gap-5">
      <nav className="flex flex-wrap gap-2">
        {(Object.keys(STATES) as HubState[]).map((name) => (
          <a
            key={name}
            href={`?state=${name}`}
            className={`px-3 py-1 rounded text-sm transition-colors ${
              name === state
                ? 'bg-accent-primary text-white'
                : 'bg-interactive-hover text-txt-secondary hover:text-txt-primary'
            }`}
          >
            {name}
          </a>
        ))}
      </nav>
      <p className="text-sm text-txt-secondary">
        <span className="font-semibold text-txt-primary">{state}</span>: {STATES[state]}
      </p>
      <div className="flex flex-wrap items-start gap-6">
        {frames.map((width) => (
          <figure key={width} className="flex flex-col gap-2">
            <figcaption className="text-xs text-txt-tertiary">
              <a href={`?state=${state}&width=${width}`} className="hover:text-txt-secondary">
                {width}, {FRAME_PX[width]}px
              </a>
            </figcaption>
            <iframe
              title={`${state} at ${width} width`}
              src={`?state=${state}&width=${width}`}
              width={FRAME_PX[width]}
              height={FRAME_HEIGHT_PX[width]}
              className="rounded-lg border border-border-soft bg-surface-chat"
            />
          </figure>
        ))}
      </div>
    </div>
  );
}

// ─── Start ──────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  const state = readState(window.location.search);
  const width = readWidth(window.location.search);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();

  if (width === null) {
    createRoot(host).render(<Overview state={state} />);
    return;
  }

  const links = linksFor(state);
  installFetch(state, links);
  pinViewport(width);
  await initI18n();
  seedStores(state, width);
  createRoot(host).render(
    // The page is reached at `/backspace`; the entry points are seen from the DMs home.
    <MemoryRouter initialEntries={[state === 'entry-updated' ? '/' : '/backspace']}>
      {width === 'desktop' ? <DesktopFrame state={state} links={links} /> : <PhoneFrame state={state} links={links} />}
    </MemoryRouter>,
  );
  if (needsJoinClick(state)) await clickJoin();
}

void start();
