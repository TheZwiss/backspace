// Dev-only workbench for the surfaces that say why a user is waiting on
// peering. Nothing in the app imports this file; `dev-peering-reasons.html` is
// its only entry. It exists so each trigger reason can be looked at and
// screenshotted in the admin's approval queue, in the user's Connections
// panel and in the toasts a connection raises, without a server, a second
// instance or an admin who has turned auto-accept off.
//
// `?scene=` picks one surface; the app's own dev-only `?lang=` picks the
// language (en, de, ru, zh):
//
//   admin         Instance settings, Federation: the approval queue with an
//                 outbound request waiting on a friend add and two
//                 connections (one with a long username), an outbound request
//                 for a long host, and an inbound request for comparison.
//   connections   Connections: the pending list and the recent outcomes, each
//                 with a connection, a friend add and a long host. An approved
//                 friend add offers Retry; an approved connection does not.
//   toasts        The two toasts a connection or explicit login raises when
//                 peering is refused or still being set up.
//
// Every surface is the real component. The approval-queue and peer requests
// are answered locally, the stores are seeded, and their actions that would
// reach a server are no-ops.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type {
  ApprovalRequest,
  InstanceAdminSettings,
  PeeringNotification,
  PeeringSubscription,
  User,
} from '@backspace/shared';
import { FederationPanel } from '../components/modals/instanceSettingsPanels/FederationPanel';
import { ConnectedInstances } from '../components/modals/ConnectedInstances';
import { ToastContainer } from '../components/ui/ToastContainer';
import { useAuthStore } from '../stores/authStore';
import { useFederationStore } from '../stores/federationStore';
import { useInstanceStore } from '../stores/instanceStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import i18n, { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'admin' | 'connections' | 'toasts';

const SCENES: ReadonlySet<string> = new Set<Scene>(['admin', 'connections', 'toasts']);

function readScene(search: string): Scene {
  const value = new URLSearchParams(search).get('scene');
  return value !== null && SCENES.has(value) ? (value as Scene) : 'admin';
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 8, 27, 12, 0);
const ORBIT = 'https://orbit.example';
const VAULT = 'https://vault.example';
const LONG_HOST = 'https://backspace.community-instance-with-a-long-name.example.org';

const APPROVAL_REQUESTS: ApprovalRequest[] = [
  {
    id: 'req-orbit',
    direction: 'outbound',
    origin: ORBIT,
    instanceName: null,
    requestedAt: NOW - 25 * 60_000,
    expiresAt: NOW + 30 * 86_400_000,
    subscribers: [
      { userId: 'u-erin', username: 'erin', triggerReason: 'friend_add', triggerTarget: 'bob@orbit.example' },
      { userId: 'u-frank', username: 'frank', triggerReason: 'instance_connect', triggerTarget: ORBIT },
      {
        userId: 'u-max',
        username: 'maximilian_schwarzenberger',
        triggerReason: 'instance_connect',
        triggerTarget: ORBIT,
      },
    ],
  },
  {
    id: 'req-long',
    direction: 'outbound',
    origin: LONG_HOST,
    instanceName: null,
    requestedAt: NOW - 3 * 3_600_000,
    expiresAt: NOW + 30 * 86_400_000,
    subscribers: [
      { userId: 'u-erin', username: 'erin', triggerReason: 'instance_connect', triggerTarget: LONG_HOST },
    ],
  },
  {
    id: 'req-inbound',
    direction: 'inbound',
    origin: VAULT,
    instanceName: 'Vault',
    requestedAt: NOW - 2 * 86_400_000,
    expiresAt: NOW + 28 * 86_400_000,
  },
];

const SUBSCRIPTIONS: PeeringSubscription[] = [
  {
    id: 'sub-orbit',
    requestId: 'req-orbit',
    peerOrigin: ORBIT,
    peerInstanceName: 'Orbit',
    triggerReason: 'instance_connect',
    triggerTarget: ORBIT,
    createdAt: NOW - 25 * 60_000,
  },
  {
    id: 'sub-vault',
    requestId: 'req-vault',
    peerOrigin: VAULT,
    peerInstanceName: null,
    triggerReason: 'friend_add',
    triggerTarget: 'bob@vault.example',
    createdAt: NOW - 40 * 60_000,
  },
  {
    id: 'sub-long',
    requestId: 'req-long',
    peerOrigin: LONG_HOST,
    peerInstanceName: 'The Community Instance With A Long Name',
    triggerReason: 'instance_connect',
    triggerTarget: LONG_HOST,
    createdAt: NOW - 3 * 3_600_000,
  },
];

const NOTIFICATIONS: PeeringNotification[] = [
  {
    id: 'n-orbit',
    kind: 'approved',
    peerOrigin: ORBIT,
    triggerReason: 'instance_connect',
    triggerTarget: ORBIT,
    createdAt: NOW - 5 * 60_000,
    readAt: null,
  },
  {
    id: 'n-vault',
    kind: 'approved',
    peerOrigin: VAULT,
    triggerReason: 'friend_add',
    triggerTarget: 'bob@vault.example',
    createdAt: NOW - 15 * 60_000,
    readAt: null,
  },
  {
    id: 'n-long',
    kind: 'denied',
    peerOrigin: LONG_HOST,
    triggerReason: 'instance_connect',
    triggerTarget: LONG_HOST,
    createdAt: NOW - 86_400_000,
    readAt: null,
  },
];

const ADMIN_SETTINGS: InstanceAdminSettings = {
  instanceName: 'Workbench',
  registrationOpen: true,
  federatedRegistrationOpen: true,
  discoveryEnabled: true,
  gifEnabled: false,
  maxUploadSizeMb: 100,
  federationRelayEnabled: true,
  federationRelayTtlDays: 30,
  defaultAutoRotateIntervalDays: 90,
  autoAcceptPeering: false,
  directoryEnabled: false,
  directoryBrowseEnabled: true,
  directoryLastPingAt: null,
  directoryLastError: null,
  directoryListedSpaceCount: 0,
  supportCardEnabled: true,
};

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
  isAdmin: true,
  createdAt: 1,
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

// ─── Seeding ────────────────────────────────────────────────────────────────

/**
 * The Federation panel loads its queue and peer list over HTTP on mount, and
 * the harness has no server. Those requests are answered here; anything else
 * goes through.
 */
function stubFederationRequests(): void {
  const answers: Array<[string, unknown]> = [
    ['/federation/approval-requests', { requests: APPROVAL_REQUESTS }],
    ['/federation/reset-events', { events: [] }],
    ['/federation/peers', { peers: [] }],
  ];
  const passThrough = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const answer = answers.find(([path]) => url.includes(path));
    if (answer) {
      return Promise.resolve(new Response(JSON.stringify(answer[1]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return passThrough(input, init);
  };
}

function seedStores(scene: Scene): void {
  useAuthStore.setState({ user: HOME_USER });
  useSettingsStore.setState({
    instanceSettings: ADMIN_SETTINGS,
    updateInstanceSettings: async () => {},
  });
  useInstanceStore.setState({ instances: [], registry: new Map() });
  useFederationStore.setState({
    peeringSubscriptions: SUBSCRIPTIONS,
    peeringNotifications: NOTIFICATIONS,
    refetchPeeringSubscriptions: async () => {},
    refetchPeeringNotifications: async () => {},
    cancelPeeringSubscription: async () => {},
    markPeeringNotificationRead: async () => {},
    markAllPeeringNotificationsRead: async () => {},
  });
  if (scene === 'toasts') {
    useUIStore.setState({
      toasts: [
        {
          id: 'toast-refused',
          type: 'warning',
          message: i18n.t('federation:connections.peering.unavailable', { name: 'Orbit' }),
        },
        {
          id: 'toast-pending',
          type: 'info',
          message: i18n.t('federation:connections.peering.inProgress', {
            name: 'The Community Instance With A Long Name',
          }),
        },
      ],
    });
  }
}

/** The same frame the settings modals give a panel: a centred column, 640px at most. */
function Workbench({ scene }: { scene: Scene }) {
  if (scene === 'toasts') {
    return (
      <div className="min-h-screen">
        <ToastContainer />
      </div>
    );
  }
  return (
    <div className="min-h-screen py-6">
      <div className="px-6 max-w-[640px] mx-auto">
        <MemoryRouter>
          {scene === 'admin' ? <FederationPanel /> : <ConnectedInstances />}
        </MemoryRouter>
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const scene = readScene(window.location.search);
  initializeInterfaceScale();
  // Reads `?lang=` itself in dev and sets the document language with it.
  await initI18n();
  stubFederationRequests();
  seedStores(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
}

void start();
