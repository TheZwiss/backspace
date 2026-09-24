// Dev-only workbench for the Explore page's two sections. Nothing in the app
// imports this file; `dev-explore.html` is its only entry. It exists so the
// Inner Space / Outer Space layout can be looked at and screenshotted in each
// of its designed states without a populated instance, a peer, or a hub.
//
// `?scene=both|inner-one|inner-two|inner-empty|outer-unreachable|outer-empty`
// `?scene=inner-none-answered` is the Inner list's failure: no instance in
// the fan-out answered, so the section has a rose notice and nothing else.
// `?scene=outer-load-more-retry` is the state a refused continuation leaves:
// the feed already on screen, the notice about the page that did not arrive,
// and Show more still under it, because that button is the only way to ask
// again.
// picks the state of the two stores; `both` is the default. `inner-one` and
// `inner-two` cut the Inner list down to one and two unjoined cards, the
// counts at which a card grid has empty tracks to spare. The page's own
// network calls are replaced: the store actions become no-ops and the one
// unauthenticated call the page makes itself (`GET /api/instance/info`, the
// directory gate) is answered locally so the harness needs no server.
//
// `?scene=connect-password|connect-closed|connect-fallback|connect-closed-fallback`
// opens the connect-and-join modal over the `both` page: the password phase
// for a request space, the same for an instance closed to new accounts, and
// the fallback phase for each of the two, reached the way a user reaches it
// (the harness submits a password and the stubbed connect answers
// `needs-remote-password`, with `credential-refused` on the open instance
// and `registration-closed` on the closed one).
//
// `?width=400` constrains the workbench to that many CSS pixels, for phone
// widths a headless browser window cannot go down to (Chrome's floor is
// 500). The viewport attribute still follows the window, which at these
// sizes is the mobile shell either way.
//
// `?scene=home-sidebar` puts the home view's left column next to the page
// with the router already at `/explore`, so the sidebar's Explore entry can
// be seen in its selected state and the Home entry in its unselected one.
//
// `?scene=connections` seeds the federation registry with one expired and
// one unreachable connection over the `both` page, so the chips row under
// the Inner Space subtitle can be seen collapsed. The `connections-*` scenes
// after it open the expired chip into its reconnect panel and drive that
// panel into one designed state each, always the way a user reaches it (the
// harness clicks Reconnect, types into the field and submits it; only the
// store action behind it is stubbed):
//   connections-focused      the panel as it opens, the field holding focus
//   connections-idle         the same panel with the focus given up
//   connections-submitting   a submit that never settles
//   connections-wrong        a submit the store refuses as a wrong password
//   connections-peer-down    a submit the store refuses as unreachable
//   connections-other-password  a submit the instance answers with an
//                            account of its own, moving to the second phase
//   connections-recovered    a submit that succeeds; the chip is gone
// `connections-open` is kept as an alias of `connections-focused`.
//
// `?scene=connections-panel` renders the Connections settings panel instead
// of the page, with the expired row open on the same reauth form, because
// the two surfaces share it.
//
// `?scene=hint-member|hint-admin|hint-not-listed|hint-browse-member|hint-browse-admin|hint-all`
// shows the instance discovery hint that sits under the chips row. The hint
// states every fact that applies, so most of these scenes are stacks rather
// than single rows, and `hint-all` is all three at once, the case to check
// `?width=400` on: space discovery off as a member sees it, the same as
// an admin sees it with the switch, the quiet listing row an admin gets once
// discovery is on, and the two browse rows, where the admin has turned "Show
// global spaces in Explore" off and Outer Space is therefore absent from the
// page below. Pair them with `?width=400` to see the text wrap and the action
// move below it.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, FederationRegistryEntry, InstanceInfoResponse, InstanceStreamingLimits, User } from '@backspace/shared';
import { ExplorePage } from '../components/chat/ExplorePage';
import { ChannelSidebar } from '../components/layout/ChannelSidebar';
import { ConnectAndJoinModal } from '../components/modals/ConnectAndJoinModal';
import { ConnectedInstances } from '../components/modals/ConnectedInstances';
import { HttpError } from '../api/client';
import { useExploreStore, type TaggedExploreSpace } from '../stores/exploreStore';
import { useDirectoryStore } from '../stores/directoryStore';
import { useInstanceStore, RemoteLoginRequiredError, type ConnectedInstance } from '../stores/instanceStore';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'both'
  | 'inner-one'
  | 'inner-two'
  | 'inner-empty'
  | 'inner-none-answered'
  | 'outer-unreachable'
  | 'outer-empty'
  | 'outer-load-more-retry'
  | 'connect-password'
  | 'connect-closed'
  | 'connect-fallback'
  | 'connect-closed-fallback'
  | 'home-sidebar'
  | 'connections'
  | 'connections-open'
  | 'connections-focused'
  | 'connections-idle'
  | 'connections-submitting'
  | 'connections-wrong'
  | 'connections-peer-down'
  | 'connections-other-password'
  | 'connections-recovered'
  | 'connections-panel'
  | 'hint-member'
  | 'hint-admin'
  | 'hint-not-listed'
  | 'hint-browse-member'
  | 'hint-browse-admin'
  | 'hint-all';

const SCENES: ReadonlySet<string> = new Set<Scene>([
  'both',
  'inner-one',
  'inner-two',
  'inner-empty',
  'inner-none-answered',
  'outer-unreachable',
  'outer-empty',
  'outer-load-more-retry',
  'connect-password',
  'connect-closed',
  'connect-fallback',
  'connect-closed-fallback',
  'home-sidebar',
  'connections',
  'connections-open',
  'connections-focused',
  'connections-idle',
  'connections-submitting',
  'connections-wrong',
  'connections-peer-down',
  'connections-other-password',
  'connections-recovered',
  'connections-panel',
  'hint-member',
  'hint-admin',
  'hint-not-listed',
  'hint-browse-member',
  'hint-browse-admin',
  'hint-all',
]);

function isScene(value: string | null): value is Scene {
  return value !== null && SCENES.has(value);
}

function readScene(search: string): Scene {
  const value = new URLSearchParams(search).get('scene');
  return isScene(value) ? value : 'both';
}

/** A positive integer width in CSS pixels, or null for the window's own. */
function readWidth(search: string): number | null {
  const value = Number(new URLSearchParams(search).get('width'));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Three unjoined spaces and one joined, one of them from a connected peer, as the Inner list ranks them. */
const INNER_SPACES: TaggedExploreSpace[] = [
  {
    id: 'inner-1',
    name: 'Aether Drift',
    icon: null,
    banner: null,
    avatarColor: 'lavender',
    description: 'Design chatter, prototypes and the occasional argument about blur radii.',
    visibility: 'public',
    memberCount: 128,
    createdAt: 1,
    joined: false,
    _instanceOrigin: '',
  },
  {
    id: 'inner-2',
    name: 'Kobold Truppe',
    icon: null,
    banner: null,
    avatarColor: 'amber',
    description: 'Tabletop nights, campaign notes and dice that are definitely not loaded.',
    visibility: 'request',
    memberCount: 37,
    createdAt: 2,
    joined: false,
    _instanceOrigin: 'https://nova.example',
  },
  {
    id: 'inner-3',
    name: 'Orbit Ops',
    icon: null,
    banner: null,
    avatarColor: 'sky',
    description: null,
    visibility: 'public',
    memberCount: 9,
    createdAt: 3,
    joined: false,
    _instanceOrigin: '',
  },
  {
    id: 'inner-4',
    name: 'Home Lab',
    icon: null,
    banner: null,
    avatarColor: 'mint',
    description: 'Racks, cables and the fan noise that comes with them.',
    visibility: 'public',
    memberCount: 54,
    createdAt: 4,
    joined: true,
    _instanceOrigin: '',
  },
];

/** Four directory entries from three instances, one of them closed to new accounts, one by request. */
const OUTER_ENTRIES: DirectoryEntry[] = [
  {
    id: 'outer-1',
    name: 'Retro Computing',
    icon: null,
    banner: null,
    avatarColor: 'coral',
    description: 'Amigas, Acorns and everything with a beige case.',
    visibility: 'public',
    memberCount: 412,
    createdAt: 5,
    origin: 'https://retro.example',
    instanceName: 'Retro',
    federatedRegistrationOpen: true,
  },
  {
    id: 'outer-2',
    name: 'Bird Watchers',
    icon: null,
    banner: null,
    avatarColor: 'teal',
    description: 'Sightings, lenses and the dawn chorus.',
    visibility: 'request',
    memberCount: 88,
    createdAt: 6,
    origin: 'https://fauna.example',
    instanceName: 'Fauna',
    federatedRegistrationOpen: true,
  },
  {
    id: 'outer-3',
    name: 'Zwiss Alpine Club',
    icon: null,
    banner: null,
    avatarColor: 'rose',
    description: 'Routes, huts and weather windows.',
    visibility: 'public',
    memberCount: 23,
    createdAt: 7,
    origin: 'https://zwiss.example',
    instanceName: 'Zwiss',
    federatedRegistrationOpen: false,
  },
  {
    id: 'outer-4',
    name: 'Sourdough',
    icon: null,
    banner: null,
    avatarColor: 'amber',
    description: null,
    visibility: 'public',
    memberCount: 301,
    createdAt: 8,
    origin: 'https://retro.example',
    instanceName: 'Retro',
    federatedRegistrationOpen: true,
  },
];

const INSTANCE_INFO: InstanceInfoResponse = {
  name: 'Workbench',
  version: '0.0.0-dev',
  registrationOpen: true,
  federatedRegistrationOpen: true,
  instanceId: 'workbench',
  sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
  commit: null,
  directoryConfigured: true,
  directoryAvailable: true,
  directoryEnabled: true,
};

/**
 * The public instance info for a scene. The browse scenes are the only ones
 * that turn `directoryAvailable` off, which is what takes Outer Space off the
 * page and puts the browse row in the hint; the endpoint stays configured,
 * because with none there is no setting worth naming and the hint says
 * nothing.
 */
function instanceInfoFor(scene: Scene): InstanceInfoResponse {
  if (scene === 'hint-browse-member' || scene === 'hint-browse-admin' || scene === 'hint-all') {
    return { ...INSTANCE_INFO, directoryAvailable: false };
  }
  return INSTANCE_INFO;
}

/** Answers the directory gate locally; every other request goes through untouched. */
function installInstanceInfo(scene: Scene): void {
  const info = instanceInfoFor(scene);
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/instance/info')) {
      return Promise.resolve(
        new Response(JSON.stringify(info), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return realFetch(input, init);
  };
}

/**
 * The Inner list for a scene: every fixture, the first one or two unjoined
 * ones with the joined one still under them (the maintainer's case), or none.
 */
function innerSpacesFor(scene: Scene): TaggedExploreSpace[] {
  const unjoined = INNER_SPACES.filter((space) => !space.joined);
  const joined = INNER_SPACES.filter((space) => space.joined);
  if (scene === 'inner-empty') return [];
  if (scene === 'inner-one') return [...unjoined.slice(0, 1), ...joined];
  if (scene === 'inner-two') return [...unjoined.slice(0, 2), ...joined];
  return INNER_SPACES;
}

/** A stream-limits document the hint scenes vary the two discovery flags on. */
const DEFAULT_HINT_LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: false,
  directoryConfigured: true,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

type HintScene =
  | 'hint-member'
  | 'hint-admin'
  | 'hint-not-listed'
  | 'hint-browse-member'
  | 'hint-browse-admin'
  | 'hint-all';

const HINT_SCENES: ReadonlySet<string> = new Set<HintScene>([
  'hint-member',
  'hint-admin',
  'hint-not-listed',
  'hint-browse-member',
  'hint-browse-admin',
  'hint-all',
]);

function isHintScene(scene: Scene): scene is HintScene {
  return HINT_SCENES.has(scene);
}

/**
 * The instance settings behind each hint scene; only the two discovery flags
 * differ. The browse scenes run with both of them on, so the row on screen is
 * the incoming axis alone: the other two rows are settled and out of the way.
 */
const HINT_LIMITS: Record<HintScene, InstanceStreamingLimits> = {
  'hint-member': { ...DEFAULT_HINT_LIMITS, discoveryEnabled: false, directoryEnabled: false },
  'hint-admin': { ...DEFAULT_HINT_LIMITS, discoveryEnabled: false, directoryEnabled: false },
  'hint-not-listed': { ...DEFAULT_HINT_LIMITS, discoveryEnabled: true, directoryEnabled: false },
  'hint-browse-member': { ...DEFAULT_HINT_LIMITS, discoveryEnabled: true, directoryEnabled: true },
  'hint-browse-admin': { ...DEFAULT_HINT_LIMITS, discoveryEnabled: true, directoryEnabled: true },
  // Everything off at once: the three-row stack, which is the case most
  // likely to crowd at phone width and the one to check `?width=400` on.
  'hint-all': { ...DEFAULT_HINT_LIMITS, discoveryEnabled: false, directoryEnabled: false },
};

function seedStores(scene: Scene): void {
  // The hint scenes are the only ones that turn space discovery off, and the
  // flags they run on are the ones in their own settings row.
  const discoveryOff = isHintScene(scene) && !HINT_LIMITS[scene].discoveryEnabled;

  useExploreStore.setState({
    spaces: discoveryOff || scene === 'inner-none-answered' ? [] : innerSpacesFor(scene),
    myRequests: [],
    isLoading: false,
    discoveryEnabled: !discoveryOff,
    // The page renders the words for this; the store holds the state only.
    error: scene === 'inner-none-answered' ? { kind: 'none_answered' } : null,
    fetchSpaces: async () => {},
    fetchMyRequests: async () => {},
  });

  // What the instance discovery hint reads. Outside the hint scenes this is
  // the resting state of a fresh session: no admin, and settings that have
  // not arrived, which is the hint's silent row.
  useSettingsStore.setState({
    isAdmin: scene === 'hint-admin' || scene === 'hint-not-listed' || scene === 'hint-browse-admin' || scene === 'hint-all',
    streamingLimits: isHintScene(scene) ? HINT_LIMITS[scene] : null,
    updateInstanceSettings: async () => {},
  });

  const outer = scene === 'outer-unreachable'
    ? { entries: [], status: 'unreachable' as const, hasMore: false, loadMoreError: null }
    : scene === 'outer-empty'
      ? { entries: [], status: 'ok' as const, hasMore: false, loadMoreError: null }
      : scene === 'outer-load-more-retry'
        // A continuation that failed leaves the status on `ok`: the feed on
        // screen is still the feed, and Show more has to stay reachable.
        ? { entries: OUTER_ENTRIES, status: 'ok' as const, hasMore: true, loadMoreError: 'unreachable' as const }
        : { entries: OUTER_ENTRIES, status: 'ok' as const, hasMore: true, loadMoreError: null };

  useDirectoryStore.setState({
    ...outer,
    query: '',
    offset: 0,
    fetch: async () => {},
    loadMore: async () => {},
  });
}

/** The signed-in user the modal names as the home of the password it asks for. */
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

/** Opens the modal for `entry` with the probe and the connect actions answered locally. */
function seedConnectScene(scene: Scene): void {
  if (!scene.startsWith('connect-')) return;
  const closed = scene === 'connect-closed' || scene === 'connect-closed-fallback';
  const entry = closed ? OUTER_ENTRIES[2] : OUTER_ENTRIES[1];
  if (!entry) throw new Error('the connect scenes need the fixture entries');
  useAuthStore.setState({ user: HOME_USER });
  useInstanceStore.setState({
    instances: [],
    probeInstance: async (url: string) => ({
      ...INSTANCE_INFO,
      name: entry.instanceName,
      federatedRegistrationOpen: entry.federatedRegistrationOpen,
      origin: `https://${url}`,
    }),
  });
  useDirectoryStore.setState({
    connectAndJoin: async () => ({
      kind: 'needs-remote-password',
      remoteUsername: 'jannis@home.example',
      reason: closed ? 'registration-closed' : 'credential-refused',
    }),
    loginAndJoin: async () => ({ kind: 'requested' }),
  });
  useUIStore.setState({ activeModal: 'connectAndJoin', modalData: { entry } });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/** Polls `find` once per frame until it answers, so a driver never races a render. */
async function waitForElement<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const found = find();
    if (found) return found;
    await nextFrame();
  }
  throw new Error(what);
}

/**
 * React owns every input here, so a value goes in through the native setter
 * and an input event rather than a plain assignment, which React would not
 * see.
 */
function typeInto(input: HTMLInputElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('no native value setter');
  setValue.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** The one password field on screen, once it is there. */
function passwordField(): Promise<HTMLInputElement> {
  return waitForElement(
    () => document.querySelector<HTMLInputElement>('input[type="password"]'),
    'the password field did not render',
  );
}

/**
 * Reaches the fallback phase the way a user does: types a password into the
 * step and submits it, which the stubbed connect answers with
 * `needs-remote-password`.
 */
async function driveToFallback(): Promise<void> {
  const input = await passwordField();
  typeInto(input, 'hunter2');
  await nextFrame();
  input.form?.requestSubmit();
}

function registryEntry(origin: string, label: string, status: FederationRegistryEntry['status']): FederationRegistryEntry {
  return {
    origin,
    label,
    username: 'jannis@home.example',
    remoteUserId: 'remote-user',
    status,
    addedAt: 1,
    lastConnectedAt: 2,
    disconnectedAt: null,
    errorMessage: null,
  };
}

function liveInstance(origin: string, label: string, status: ConnectedInstance['status']): ConnectedInstance {
  return {
    origin,
    label,
    token: 'workbench-token',
    user: HOME_USER,
    username: 'jannis@home.example',
    status,
    api: {} as ConnectedInstance['api'],
  };
}

/**
 * Three connections in the registry: one healthy, one whose session expired
 * (its live instance is the tokenless error placeholder autoConnectAll
 * leaves), one unreachable (its live instance disconnected with a token).
 * The store actions the chips call are answered locally and never settle a
 * status, so the row stays on screen to be looked at.
 */
function isConnectionsScene(scene: Scene): boolean {
  return scene === 'connections' || scene.startsWith('connections-');
}

/** The expired instance every `connections-*` scene reconnects. */
const EXPIRED_ORIGIN = 'https://zwiss.example';

/**
 * What the scene's `reauthenticateInstance` does with the submitted
 * password. Everything else about the store stays the same, so the only
 * difference between the panel's states is the answer it is waiting on.
 */
function reauthFor(scene: Scene): (origin: string, password: string) => Promise<void> {
  switch (scene) {
    case 'connections-submitting':
      return () => new Promise<void>(() => {});
    case 'connections-wrong':
      return () => Promise.reject(
        new HttpError(401, 'invalid_credentials', { error: 'invalid_credentials', code: 'invalid_credentials', statusCode: 401 }, 'invalid_credentials'),
      );
    case 'connections-other-password':
      return () => Promise.reject(new RemoteLoginRequiredError('jannis@home.example', 'credential-refused'));
    case 'connections-peer-down':
      return () => Promise.reject(
        new HttpError(503, 'peer_unreachable', { error: 'peer_unreachable', code: 'peer_unreachable', statusCode: 503 }, 'peer_unreachable'),
      );
    case 'connections-recovered':
      return async (origin: string) => {
        const registry = new Map(useInstanceStore.getState().registry);
        registry.set(origin, registryEntry(origin, 'Zwiss', 'connected'));
        useInstanceStore.setState({
          registry,
          instances: useInstanceStore.getState().instances.map((i) =>
            i.origin === origin ? liveInstance(i.origin, i.label, 'connected') : i,
          ),
        });
      };
    default:
      return async () => {};
  }
}

function seedConnectionsScene(scene: Scene): void {
  if (!isConnectionsScene(scene)) return;
  useAuthStore.setState({ user: HOME_USER });
  useInstanceStore.setState({
    instances: [
      liveInstance('https://nova.example', 'Nova', 'connected'),
      liveInstance(EXPIRED_ORIGIN, 'Zwiss', 'error'),
      liveInstance('https://orbit.example', 'Orbit', 'disconnected'),
    ],
    registry: new Map([
      ['https://nova.example', registryEntry('https://nova.example', 'Nova', 'connected')],
      [EXPIRED_ORIGIN, registryEntry(EXPIRED_ORIGIN, 'Zwiss', 'auth_expired')],
      ['https://orbit.example', registryEntry('https://orbit.example', '', 'unreachable')],
    ]),
    reconnectInstance: async () => {},
    reauthenticateInstance: reauthFor(scene),
  });
}

/** Clicks the one button on screen whose whole label is `text`. */
async function clickButton(text: string, what: string): Promise<void> {
  const button = await waitForElement(
    () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text),
    what,
  );
  button.click();
}

/**
 * Drives one `connections-*` scene into its state, always through the
 * surface: the chip's Reconnect action opens the panel, the field takes a
 * password, and the form is submitted. Which state that lands in is the
 * stubbed `reauthenticateInstance`'s business, not the driver's.
 */
async function driveConnectionsScene(scene: Scene): Promise<void> {
  if (scene === 'connections' || !isConnectionsScene(scene)) return;

  if (scene === 'connections-panel') {
    // The row's actions live behind its own disclosure, so the row opens first.
    const row = await waitForElement(
      () => Array.from(document.querySelectorAll<HTMLElement>('span')).find((e) => e.textContent === 'Zwiss'),
      'the expired registry row did not render',
    );
    row.click();
    await clickButton('Re-authenticate', 'the expired row has no re-authenticate action');
    return;
  }

  await clickButton('Reconnect', 'the expired chip did not render');
  const field = await passwordField();

  if (scene === 'connections-idle') {
    field.blur();
    return;
  }
  if (scene === 'connections-open' || scene === 'connections-focused') return;

  typeInto(field, 'hunter2');
  await nextFrame();
  field.form?.requestSubmit();
  // Three frames: the submit, the store's answer, the render that shows it.
  await nextFrame();
  await nextFrame();
  await nextFrame();
}

/** The home sidebar needs a signed-in user for its user area; the stores' defaults give it the `!space` branch. */
function seedHomeSidebarScene(scene: Scene): void {
  if (scene !== 'home-sidebar') return;
  useAuthStore.setState({ user: HOME_USER });
}

function Workbench({ scene, width }: { scene: Scene; width: number | null }) {
  return (
    <div style={{ height: 'calc(100 * var(--app-vh))', display: 'flex', width: width ?? undefined }}>
      {scene === 'home-sidebar' && (
        // AppLayout's host for the two sidebars: 312px wide, the channel column's
        // own `desktop:pl-[72px]` leaving room for the space strip, absent here.
        <div className="flex w-[312px] flex-shrink-0">
          <ChannelSidebar />
        </div>
      )}
      {/* The shells host the page width-constrained (MainContent's column, the
          mobile stack's absolute screen); a bare row-flex host would let the
          page take its min-content width at phone sizes. */}
      <div className="flex-1 min-w-0 flex overflow-hidden">
        {scene === 'connections-panel' ? (
          // The settings modal's content column, at the width it gives a panel.
          <div className="flex-1 min-w-0 overflow-y-auto bg-surface-chat p-6">
            <div className="max-w-[740px]">
              <ConnectedInstances />
            </div>
          </div>
        ) : (
          <ExplorePage />
        )}
      </div>
      <ConnectAndJoinModal />
    </div>
  );
}

async function start(): Promise<void> {
  const scene = readScene(window.location.search);
  const width = readWidth(window.location.search);
  installInstanceInfo(scene);
  initializeInterfaceScale();
  await initI18n();
  seedStores(scene);
  seedConnectScene(scene);
  seedConnectionsScene(scene);
  seedHomeSidebarScene(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(
    <MemoryRouter initialEntries={[scene === 'home-sidebar' ? '/explore' : '/']}>
      <Workbench scene={scene} width={width} />
    </MemoryRouter>,
  );
  if (scene === 'connect-fallback' || scene === 'connect-closed-fallback') await driveToFallback();
  await driveConnectionsScene(scene);
}

void start();
