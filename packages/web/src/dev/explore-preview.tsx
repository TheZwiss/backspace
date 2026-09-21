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
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DirectoryEntry, InstanceInfoResponse } from '@backspace/shared';
import { ExplorePage } from '../components/chat/ExplorePage';
import { useExploreStore, type TaggedExploreSpace } from '../stores/exploreStore';
import { useDirectoryStore } from '../stores/directoryStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'both' | 'inner-empty' | 'outer-unreachable' | 'outer-empty';

function readScene(search: string): Scene {
  const value = new URLSearchParams(search).get('scene');
  if (value === 'inner-empty' || value === 'outer-unreachable' || value === 'outer-empty') return value;
  return 'both';
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

function Workbench() {
  return (
    <div style={{ height: 'calc(100 * var(--app-vh))', display: 'flex' }}>
      <ExplorePage />
    </div>
  );
}

async function start(): Promise<void> {
  const scene = readScene(window.location.search);
  installInstanceInfo();
  initializeInterfaceScale();
  await initI18n();
  seedStores(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(
    <MemoryRouter>
      <Workbench />
    </MemoryRouter>,
  );
}

void start();
