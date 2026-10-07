// Dev-only workbench for the peer rows in Instance settings, Federation. Nothing
// in the app imports this file; `dev-peer-states.html` is its only entry. It
// exists so every peer state, and every reason a peer is rejected or needs
// attention, can be looked at and screenshotted without a server or a second
// instance in that state.
//
// `?scene=` picks what is shown; the app's own dev-only `?lang=` picks the
// language (en, de, ru, zh):
//
//   list          the peer list with one row per state and reason, collapsed.
//   expanded      the same list with `?peer=<id>` expanded (default: the row
//                 parked on the remote's older peering). The harness clicks the
//                 row the way an admin would.
//   toasts        the notice a user gets when messages to a peer stop being
//                 delivered, one per reason code.
//
// The panel is the real component; its peer and queue requests are answered
// locally and the store actions that would reach a server are no-ops.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { FederationPeer, FederationPeerStatusReason, InstanceAdminSettings, User } from '@backspace/shared';
import { FederationPanel } from '../components/modals/instanceSettingsPanels/FederationPanel';
import { ToastContainer } from '../components/ui/ToastContainer';
import { useAuthStore } from '../stores/authStore';
import { useSettingsStore } from '../stores/settingsStore';
import { useUIStore } from '../stores/uiStore';
import { peerRejectedToast } from '../utils/peerRejectedToast';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'list' | 'expanded' | 'toasts';
const SCENES: ReadonlySet<string> = new Set<Scene>(['list', 'expanded', 'toasts']);

const NOW = Date.now();

function peer(
  id: string,
  host: string,
  status: FederationPeer['status'],
  statusReason: FederationPeerStatusReason | null,
  extra: Partial<FederationPeer> = {},
): FederationPeer {
  return {
    id,
    origin: `https://${host}`,
    instanceName: null,
    status,
    lastSeenAt: NOW - 20 * 60_000,
    lastFailureAt: status === 'active' ? null : NOW - 5 * 60_000,
    consecutiveFailures: 0,
    consecutiveAuthFailures: status === 'needs_attention' ? 5 : 0,
    lastSyncedAt: NOW - 20 * 60_000,
    autoRotateIntervalDays: 90,
    secretRotatedAt: null,
    rotationInProgress: false,
    createdAt: NOW - 40 * 86_400_000,
    statusReason,
    ...extra,
  };
}

const PEERS: FederationPeer[] = [
  peer('active', 'orbit.example', 'active', null, { instanceName: 'Orbit' }),
  peer('unreachable', 'nova.example', 'unreachable', null, { consecutiveFailures: 12 }),
  peer('pending', 'fresh.example', 'pending', null),
  peer('awaiting', 'gated.example', 'awaiting_approval', null),
  peer('na-auth', 'drift.example', 'needs_attention', 'auth_failures'),
  peer('na-reset', 'phoenix.example', 'needs_attention', 'peer_reset_detected'),
  peer('na-repeer', 'halfway.example', 'needs_attention', 'repeer_incomplete'),
  peer('rj-local', 'noisy.example', 'rejected', 'denied_by_local_admin'),
  peer('rj-remote', 'strict.example', 'rejected', 'denied_by_remote'),
  peer('rj-revoked', 'former.example', 'rejected', 'revoked_by_remote'),
  peer('rj-expired', 'quiet.example', 'rejected', 'expired_on_remote'),
  peer('rj-stale', 'backspace.community-instance-with-a-long-name.example.org', 'rejected', 'stale_peering_on_remote'),
  peer('rj-legacy', 'older.example', 'rejected', null),
];

const REASON_CODES: FederationPeerStatusReason[] = [
  'auth_failures', 'peer_reset_detected', 'repeer_incomplete', 'denied_by_local_admin',
  'denied_by_remote', 'revoked_by_remote', 'expired_on_remote', 'stale_peering_on_remote',
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
  autoAcceptPeering: true,
  directoryEnabled: false,
  directoryBrowseEnabled: true,
  directoryLastPingAt: null,
  directoryLastError: null,
  directoryListedSpaceCount: 0,
  supportCardEnabled: true,
};

const ADMIN: User = {
  id: 'workbench-admin',
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

/** The panel loads its lists over HTTP on mount; the harness answers them. */
function stubFederationRequests(): void {
  const answers: Array<[string, unknown]> = [
    ['/federation/approval-requests', { requests: [] }],
    ['/federation/reset-events', { events: [] }],
    ['/federation/peers', { peers: PEERS }],
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

/** Click the row of `peerId` once the panel has rendered it, as an admin would. */
function expandRow(peerId: string): void {
  const target = PEERS.find((p) => p.id === peerId);
  if (!target) return;
  const host = new URL(target.origin).host;
  const attempt = (triesLeft: number): void => {
    const row = Array.from(document.querySelectorAll<HTMLElement>('div.cursor-pointer'))
      .find((el) => el.textContent?.includes(host));
    if (row) {
      row.click();
      // Bring the opened row to the top of the window for the screenshot.
      setTimeout(() => row.scrollIntoView({ block: 'start' }), 50);
      return;
    }
    if (triesLeft > 0) setTimeout(() => attempt(triesLeft - 1), 50);
  };
  attempt(60);
}

function Workbench({ scene }: { scene: Scene }) {
  if (scene === 'toasts') {
    return <div className="min-h-screen"><ToastContainer /></div>;
  }
  return (
    <div className="min-h-screen py-6">
      <div className="px-6 max-w-[640px] mx-auto">
        <MemoryRouter>
          <FederationPanel />
        </MemoryRouter>
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const rawScene = params.get('scene');
  const scene: Scene = rawScene !== null && SCENES.has(rawScene) ? (rawScene as Scene) : 'list';
  initializeInterfaceScale();
  await initI18n();
  stubFederationRequests();
  useAuthStore.setState({ user: ADMIN });
  useSettingsStore.setState({ instanceSettings: ADMIN_SETTINGS, updateInstanceSettings: async () => {} });
  if (scene === 'toasts') {
    useUIStore.setState({
      toasts: REASON_CODES.map((reasonCode) => ({
        id: `toast-${reasonCode}`,
        type: 'warning' as const,
        message: peerRejectedToast({ peerOrigin: 'https://orbit.example', peerLabel: 'Orbit', reason: '', reasonCode }),
      })),
    });
  }
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
  if (scene === 'expanded') expandRow(params.get('peer') ?? 'rj-stale');
}

void start();
