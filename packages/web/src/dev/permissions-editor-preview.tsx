// Dev-only workbench for the channel permissions editor. Nothing in the app
// imports this file; `dev-permissions-editor.html` is its only entry.
//
// It renders the real ChannelSettingsModal on its Permissions tab. The edge is
// replaced: the override routes are answered in memory by a stubbed `fetch`,
// and the space store is seeded with a space, a channel, roles and members.
//
// `?scene=<name>`:
//   many       several role overrides and one member override, collapsed.
//   expanded   the same, with the Moderators row opened.
//   removed    the same, after Remove override on Moderators (staged, the
//              save pill is up).
//   empty      no overrides at all on the channel.
import { createRoot } from 'react-dom/client';
import type { Channel, MemberWithUser, Role, User } from '@backspace/shared';
import { ChannelSettingsModal } from '../components/modals/ChannelSettingsModal';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'many' | 'expanded' | 'removed' | 'empty';
const SCENES: readonly Scene[] = ['many', 'expanded', 'removed', 'empty'];

const SPACE_ID = 'space-1';
const CHANNEL_ID = 'channel-1';

const SPACE: TaggedSpace = {
  id: SPACE_ID,
  name: 'Aether Drift',
  icon: null,
  banner: null,
  avatarColor: 'lavender',
  ownerId: 'u-owner',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: '',
  createdAt: 1,
  _instanceOrigin: '',
};

const CHANNEL: Channel = {
  id: CHANNEL_ID,
  spaceId: SPACE_ID,
  name: 'announcements',
  type: 'text',
  topic: null,
  position: 0,
  categoryId: null,
  createdAt: 1,
};

function role(id: string, name: string, color: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color, position, permissions: '0', createdAt: 1 };
}

const ROLES: Role[] = [
  role(SPACE_ID, '@everyone', '#b9bbbe', 0),
  role('r-mod', 'Moderators', '#c4b5fd', 4),
  role('r-dj', 'Night shift listening party organisers and friends', '#ffc9a9', 3),
  role('r-member', 'Members', '#a5f3c4', 2),
  role('r-guest', 'Guests', '#93c5fd', 1),
];

function user(id: string, username: string, displayName: string | null): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null,
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 1,
    homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}

const MEMBERS: MemberWithUser[] = [
  { spaceId: SPACE_ID, userId: 'u-owner', nickname: null, joinedAt: 1, user: user('u-owner', 'jannis', 'Jannis'), roles: [] },
  { spaceId: SPACE_ID, userId: 'u-mira', nickname: null, joinedAt: 1, user: user('u-mira', 'mira', 'Mira'), roles: [ROLES[1]!] },
];

interface StoredOverride { channelId: string; targetType: string; targetId: string; allow: string; deny: string }

function seededOverrides(scene: Scene): StoredOverride[] {
  if (scene === 'empty') return [];
  const o = (targetType: string, targetId: string, allow: bigint, deny: bigint): StoredOverride => ({
    channelId: CHANNEL_ID, targetType, targetId, allow: permissionsToString(allow), deny: permissionsToString(deny),
  });
  return [
    o('role', SPACE_ID, 0n, PermissionBits.SEND_MESSAGES),
    o('role', 'r-mod', PermissionBits.SEND_MESSAGES | PermissionBits.MANAGE_MESSAGES, 0n),
    o('role', 'r-dj', PermissionBits.SEND_MESSAGES, 0n),
    o('role', 'r-guest', 0n, PermissionBits.ADD_REACTIONS | PermissionBits.ATTACH_FILES),
    o('member', 'u-mira', PermissionBits.ATTACH_FILES, 0n),
  ];
}

function stubOverrideRoutes(scene: Scene): void {
  let rows = seededOverrides(scene);
  const realFetch = window.fetch.bind(window);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url, window.location.href).pathname;
    if (path === `/api/channels/${CHANNEL_ID}/overrides` && method === 'GET') return json(rows);
    if (path === `/api/channels/${CHANNEL_ID}/overrides` && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Omit<StoredOverride, 'channelId'>;
      rows = rows.filter((r) => !(r.targetType === body.targetType && r.targetId === body.targetId));
      rows.push({ channelId: CHANNEL_ID, ...body });
      return json({ success: true });
    }
    const del = path.match(new RegExp(`^/api/channels/${CHANNEL_ID}/overrides/([^/]+)/([^/]+)$`));
    if (del && method === 'DELETE') {
      rows = rows.filter((r) => !(r.targetType === del[1] && r.targetId === del[2]));
      return json({ success: true });
    }
    return realFetch(input, init);
  };
}

function seedStores(): void {
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    channels: [CHANNEL],
    roles: ROLES,
    members: MEMBERS,
    spacePermissions: new Map([[SPACE_ID, permissionsToString(ALL_PERMISSIONS)]]),
    channelPermissions: new Map([[CHANNEL_ID, permissionsToString(ALL_PERMISSIONS)]]),
  });
  useUIStore.setState({ activeModal: 'channelSettings', modalData: { channelId: CHANNEL_ID } });
}

function waitFor<T>(find: () => T | null, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = find();
      if (found) { resolve(found); return; }
      if (Date.now() - started > timeoutMs) { reject(new Error('harness: element never appeared')); return; }
      setTimeout(tick, 30);
    };
    tick();
  });
}

function buttonByText(text: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;
}

async function drive(scene: Scene): Promise<void> {
  const tab = await waitFor(() => buttonByText('Permissions'));
  tab.click();
  if (scene === 'empty' || scene === 'many') return;
  const row = await waitFor(() => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.startsWith('Moderators')) ?? null);
  row.click();
  if (scene === 'expanded') return;
  const remove = await waitFor(() => buttonByText('Remove override'));
  remove.click();
}

async function start(): Promise<void> {
  const raw = new URLSearchParams(window.location.search).get('scene');
  const scene: Scene = SCENES.find((s) => s === raw) ?? 'many';
  initializeInterfaceScale();
  await initI18n();
  stubOverrideRoutes(scene);
  seedStores();
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<ChannelSettingsModal />);
  await drive(scene);
}

void start();
