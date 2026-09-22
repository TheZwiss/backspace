// Dev-only workbench for the directory settings. Nothing in the app imports
// this file; `dev-directory-settings.html` is its only entry. It exists so the
// admin space-discovery ladder (General panel) and the per-space listing switch
// (space settings, Discovery panel) can be looked at and screenshotted in each
// of their designed states without an admin session, a listed space, or a hub.
//
// `?scene=` picks one state; the stores are seeded and their save actions are
// no-ops, so the harness needs no server. The panels read the same store
// slices they read in the app.
//
//   admin-invite          the invite-only rung: nothing hangs under it
//   admin-local           the local rung: still nothing hangs under it
//   admin-global          the global rung, last ping shown, federated accounts open
//   admin-closed          the global rung with federated accounts closed: the amber note and its button, and a fetch error with reason
//   admin-origin          the global rung, never reported, the hub refused the instance's address
//   admin-no-directory    the local rung on an instance with no DIRECTORY_ENDPOINT: the browse row reads off, is inert, and says why
//   space-admin-off       public space, the instance has the directory off
//   space-private         private space, the instance allows the directory
//   space-listed          public space, listed
import { createRoot } from 'react-dom/client';
import type { InstanceAdminSettings, InstanceInfoResponse, InstanceStreamingLimits } from '@backspace/shared';
import { GeneralPanel } from '../components/modals/instanceSettingsPanels/GeneralPanel';
import { DiscoveryPanel } from '../components/modals/SpaceSettings';
import { useSettingsStore } from '../stores/settingsStore';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'admin-invite'
  | 'admin-local'
  | 'admin-global'
  | 'admin-closed'
  | 'admin-origin'
  | 'admin-no-directory'
  | 'space-admin-off'
  | 'space-private'
  | 'space-listed';

const SCENES: ReadonlySet<string> = new Set<Scene>([
  'admin-invite',
  'admin-local',
  'admin-global',
  'admin-closed',
  'admin-origin',
  'admin-no-directory',
  'space-admin-off',
  'space-private',
  'space-listed',
]);

function isScene(value: string | null): value is Scene {
  return value !== null && SCENES.has(value);
}

function readScene(search: string): Scene {
  const value = new URLSearchParams(search).get('scene');
  return isScene(value) ? value : 'admin-global';
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
  directoryBrowseEnabled: true,
  directoryLastPingAt: LAST_PING_AT,
  directoryLastError: null,
};

const ADMIN_SCENES: Record<Extract<Scene, `admin-${string}`>, InstanceAdminSettings> = {
  'admin-invite': { ...ADMIN_BASE, discoveryEnabled: false, directoryEnabled: false, directoryLastPingAt: null },
  'admin-local': { ...ADMIN_BASE, directoryEnabled: false, directoryLastPingAt: null },
  'admin-global': ADMIN_BASE,
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
  'admin-no-directory': { ...ADMIN_BASE, directoryEnabled: false, directoryLastPingAt: null },
};

/** Scenes standing in for an instance with DIRECTORY_ENDPOINT unset. */
const NO_ENDPOINT_SCENES: ReadonlySet<Scene> = new Set<Scene>(['admin-no-directory']);

/**
 * The General panel reads `directoryConfigured` from the public instance info,
 * and the harness has no server to answer it. Without this the browse row and
 * the global rung would always render the "answer never arrived" state and the
 * one state worth looking at, an instance with no directory to reach, could
 * not be seen at all. Only that one request is intercepted; everything else
 * goes through.
 */
function stubInstanceInfo(scene: Scene): void {
  const settings = isAdminScene(scene) ? ADMIN_SCENES[scene] : null;
  const info: InstanceInfoResponse = {
    name: 'Workbench',
    version: '1.4.0',
    registrationOpen: true,
    federatedRegistrationOpen: settings?.federatedRegistrationOpen ?? true,
    instanceId: '123e4567-e89b-12d3-a456-426614174000',
    sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
    commit: null,
    // The operator's endpoint, on its own.
    directoryConfigured: !NO_ENDPOINT_SCENES.has(scene),
    // What the server computes from it: the endpoint and the setting together.
    directoryAvailable: !NO_ENDPOINT_SCENES.has(scene) && (settings?.directoryBrowseEnabled ?? true),
    directoryEnabled: settings?.directoryEnabled ?? false,
  };
  const passThrough = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('/instance/info')) {
      return Promise.resolve(new Response(JSON.stringify(info), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return passThrough(input, init);
  };
}

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
  stubInstanceInfo(scene);
  seedStores(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
}

void start();
