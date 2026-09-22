// Dev-only workbench for the Explore page's two sections. Nothing in the app
// imports this file; `dev-explore.html` is its only entry. It exists so the
// Inner Space / Outer Space layout can be looked at and screenshotted in each
// of its designed states without a populated instance, a peer, or a hub.
//
// `?scene=both|inner-empty|outer-unreachable|outer-empty` picks the state of
// the two stores; `both` is the default. The page's own network calls are
// replaced: the store actions become no-ops and the one unauthenticated call
// the page makes itself (`GET /api/instance/info`, the directory gate) is
// answered locally so the harness needs no server.
//
// `?scene=connect-password|connect-closed|connect-fallback` opens the
// connect-and-join modal over the `both` page: the password phase for a
// request space, the same for an instance closed to new accounts, and the
// fallback phase, reached the way a user reaches it (the harness submits a
// password and the stubbed connect answers `needs-remote-password`).
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, InstanceInfoResponse, User } from '@backspace/shared';
import { ExplorePage } from '../components/chat/ExplorePage';
import { ConnectAndJoinModal } from '../components/modals/ConnectAndJoinModal';
import { useExploreStore, type TaggedExploreSpace } from '../stores/exploreStore';
import { useDirectoryStore } from '../stores/directoryStore';
import { useInstanceStore } from '../stores/instanceStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'both'
  | 'inner-empty'
  | 'outer-unreachable'
  | 'outer-empty'
  | 'connect-password'
  | 'connect-closed'
  | 'connect-fallback';

const SCENES: ReadonlySet<string> = new Set<Scene>([
  'both',
  'inner-empty',
  'outer-unreachable',
  'outer-empty',
  'connect-password',
  'connect-closed',
  'connect-fallback',
]);

function isScene(value: string | null): value is Scene {
  return value !== null && SCENES.has(value);
}

function readScene(search: string): Scene {
  const value = new URLSearchParams(search).get('scene');
  return isScene(value) ? value : 'both';
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
  directoryEnabled: true,
};

/** Answers the directory gate locally; every other request goes through untouched. */
function installInstanceInfo(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.endsWith('/api/instance/info')) {
      return Promise.resolve(
        new Response(JSON.stringify(INSTANCE_INFO), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    }
    return realFetch(input, init);
  };
}

function seedStores(scene: Scene): void {
  useExploreStore.setState({
    spaces: scene === 'inner-empty' ? [] : INNER_SPACES,
    myRequests: [],
    isLoading: false,
    discoveryEnabled: true,
    error: null,
    fetchSpaces: async () => {},
    fetchMyRequests: async () => {},
  });

  const outer = scene === 'outer-unreachable'
    ? { entries: [], status: 'unreachable' as const, hasMore: false }
    : scene === 'outer-empty'
      ? { entries: [], status: 'ok' as const, hasMore: false }
      : { entries: OUTER_ENTRIES, status: 'ok' as const, hasMore: true };

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
  const entry = scene === 'connect-closed' ? OUTER_ENTRIES[2] : OUTER_ENTRIES[1];
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
    connectAndJoin: async () => ({ kind: 'needs-remote-password', remoteUsername: 'jannis' }),
    loginAndJoin: async () => ({ kind: 'requested' }),
  });
  useUIStore.setState({ activeModal: 'connectAndJoin', modalData: { entry } });
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Reaches the fallback phase the way a user does: types a password into the
 * step and submits it, which the stubbed connect answers with
 * `needs-remote-password`. React owns the input, so the value goes through
 * the native setter and an input event rather than a plain assignment.
 */
async function driveToFallback(): Promise<void> {
  let input: HTMLInputElement | null = null;
  for (let i = 0; i < 300 && !input; i++) {
    await nextFrame();
    input = document.querySelector<HTMLInputElement>('input[type="password"]');
  }
  if (!input) throw new Error('the password step did not render');
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('no native value setter');
  setValue.call(input, 'hunter2');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextFrame();
  input.form?.requestSubmit();
}

function Workbench() {
  return (
    <div style={{ height: 'calc(100 * var(--app-vh))', display: 'flex' }}>
      <ExplorePage />
      <ConnectAndJoinModal />
    </div>
  );
}

async function start(): Promise<void> {
  const scene = readScene(window.location.search);
  installInstanceInfo();
  initializeInterfaceScale();
  await initI18n();
  seedStores(scene);
  seedConnectScene(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(
    <MemoryRouter>
      <Workbench />
    </MemoryRouter>,
  );
  if (scene === 'connect-fallback') await driveToFallback();
}

void start();
