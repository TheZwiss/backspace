// Dev-only workbench for the two directory switches. Nothing in the app
// imports this file; `dev-directory-settings.html` is its only entry. It
// exists so the admin toggle (General panel) and the per-space listing switch
// (space settings, Discovery panel) can be looked at and screenshotted in each
// of their designed states without an admin session, a listed space, or a hub.
//
// `?scene=` picks one state; the stores are seeded and their save actions are
// no-ops, so the harness needs no server. The panels read the same store
// slices they read in the app.
//
//   admin-discovery-off   discovery off: the directory toggle is disabled with its reason
//   admin-on              directory on, last ping shown, registration open
//   admin-closed          directory on, federated registration closed (amber), a fetch error with reason
//   admin-origin          never reported, the hub refused the instance's address
//   space-admin-off       public space, the instance has the directory off
//   space-private         private space, the instance allows the directory
//   space-listed          public space, listed
import { createRoot } from 'react-dom/client';
import type { InstanceAdminSettings, InstanceStreamingLimits } from '@backspace/shared';
import { GeneralPanel } from '../components/modals/instanceSettingsPanels/GeneralPanel';
import { DiscoveryPanel } from '../components/modals/SpaceSettings';
import { useSettingsStore } from '../stores/settingsStore';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'admin-discovery-off'
  | 'admin-on'
  | 'admin-closed'
  | 'admin-origin'
  | 'space-admin-off'
  | 'space-private'
  | 'space-listed';

const SCENES: ReadonlySet<string> = new Set<Scene>([
  'admin-discovery-off',
  'admin-on',
  'admin-closed',
  'admin-origin',
  'space-admin-off',
  'space-private',
  'space-listed',
]);

function isScene(value: string | null): value is Scene {
  return value !== null && SCENES.has(value);
}

function readScene(search: string): Scene {
  const value = new URLSearchParams(search).get('scene');
  return isScene(value) ? value : 'admin-on';
}

const LAST_PING_AT = Date.UTC(2026, 8, 21, 14, 19);

const ADMIN_BASE: InstanceAdminSettings = {
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
  directoryEnabled: true,
  directoryLastPingAt: LAST_PING_AT,
  directoryLastError: null,
};

const ADMIN_SCENES: Record<Extract<Scene, `admin-${string}`>, InstanceAdminSettings> = {
  'admin-discovery-off': { ...ADMIN_BASE, discoveryEnabled: false, directoryEnabled: false, directoryLastPingAt: null },
  'admin-on': ADMIN_BASE,
  'admin-closed': {
    ...ADMIN_BASE,
    federatedRegistrationOpen: false,
    directoryLastError: { at: LAST_PING_AT + 86_400_000, status: 'fetch', reason: 'unreachable' },
  },
  'admin-origin': {
    ...ADMIN_BASE,
    directoryLastPingAt: null,
    directoryLastError: { at: LAST_PING_AT, status: 'origin' },
  },
};

const LIMITS: InstanceStreamingLimits = {
  maxBitrateKbps: 20000,
  minBitrateKbps: 500,
  bitrateStepKbps: 500,
  allowedResolutions: [540, 720, 1080],
  allowedFramerates: [30, 45, 60],
  maxResolution: 1080,
  maxFramerate: 60,
  discoveryEnabled: true,
  directoryEnabled: true,
  bitrateMatrixOverrides: null,
  allowCustomBitrate: true,
};

const SPACE: TaggedSpace = {
  id: 'workbench-space',
  name: 'Aether Drift',
  icon: null,
  banner: null,
  avatarColor: 'lavender',
  ownerId: 'workbench-user',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: 'Design chatter, prototypes and the occasional argument about blur radii.',
  createdAt: 1,
  _instanceOrigin: '',
};

const SPACE_SCENES: Record<Extract<Scene, `space-${string}`>, { space: TaggedSpace; directoryEnabled: boolean }> = {
  'space-admin-off': { space: SPACE, directoryEnabled: false },
  'space-private': { space: { ...SPACE, visibility: 'private' }, directoryEnabled: true },
  'space-listed': { space: { ...SPACE, directoryListed: true }, directoryEnabled: true },
};

function isAdminScene(scene: Scene): scene is Extract<Scene, `admin-${string}`> {
  return scene.startsWith('admin-');
}

function seedStores(scene: Scene): void {
  if (isAdminScene(scene)) {
    useSettingsStore.setState({
      instanceSettings: ADMIN_SCENES[scene],
      streamingLimits: { ...LIMITS, directoryEnabled: ADMIN_SCENES[scene].directoryEnabled },
      updateInstanceSettings: async () => {},
    });
    return;
  }
  const { space, directoryEnabled } = SPACE_SCENES[scene];
  useSpaceStore.setState({ spaces: [space] });
  useSettingsStore.setState({ streamingLimits: { ...LIMITS, directoryEnabled } });
}

/** The same frame the settings modals give a panel: a centred column, 640px at most. */
function Workbench({ scene }: { scene: Scene }) {
  return (
    <div className="min-h-screen py-6">
      <div className="px-6 max-w-[640px] mx-auto">
        {isAdminScene(scene) ? <GeneralPanel /> : <DiscoveryPanel spaceId={SPACE.id} />}
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const scene = readScene(window.location.search);
  initializeInterfaceScale();
  await initI18n();
  seedStores(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
}

void start();
