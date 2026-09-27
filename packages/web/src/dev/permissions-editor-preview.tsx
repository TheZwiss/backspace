// Dev-only workbench for the channel permissions editor. Nothing in the app
// imports this file; `dev-permissions-editor.html` is its only entry.
//
// It renders the real ChannelSettingsModal (or, with `?entity=category`, the
// real CategorySettingsModal) on its Permissions tab. The edge is
// replaced: the override routes are answered in memory by a stubbed `fetch`,
// and the space store is seeded with a space, a channel, roles and members.
//
// `?scene=<name>`:
//   many       several role overrides and one member override, collapsed.
//   expanded   the same, with the Moderators row opened.
//   removed    the same, after Remove override on Moderators (staged, the
//              save pill is up).
//   empty      no overrides at all on the channel.
//   everyone   the same as many, with the @everyone row opened.
//   picker     Moderators removed (staged), then the Add Role picker opened:
//              Moderators is offered again.
//   full       every role has an override and the Add Role picker is open.
//   members    the Add Member picker open.
//   no-match   the Add Member picker with a search that matches nobody.
//   private-removed  a private entity (@everyone denies View Channels) with
//              the @everyone row removed (staged): the unhide note is up.
//   private-cleared  the same private entity with @everyone opened and its
//              View Channels deny set back to neutral.
//   long-edit  @everyone opened and its Send Messages deny set back to
//              neutral: a long list with a pending change and no note.
import { createRoot } from 'react-dom/client';
import type { Channel, ChannelCategory, MemberWithUser, Role, User } from '@backspace/shared';
import { ChannelSettingsModal } from '../components/modals/ChannelSettingsModal';
import { CategorySettingsModal } from '../components/modals/CategorySettingsModal';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'many' | 'expanded' | 'removed' | 'empty' | 'everyone' | 'picker' | 'full' | 'members' | 'no-match' | 'private-removed' | 'private-cleared' | 'long-edit';
const SCENES: readonly Scene[] = ['many', 'expanded', 'removed', 'empty', 'everyone', 'picker', 'full', 'members', 'no-match', 'private-removed', 'private-cleared', 'long-edit'];
type Entity = 'channel' | 'category';

const SPACE_ID = 'space-1';
const CHANNEL_ID = 'channel-1';
const CATEGORY_ID = 'category-1';

const CATEGORY: ChannelCategory = { id: CATEGORY_ID, spaceId: SPACE_ID, name: 'Staff only', position: 0, isPrivate: true, createdAt: 1 };

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
  { spaceId: SPACE_ID, userId: 'u-theo', nickname: null, joinedAt: 1, user: user('u-theo', 'theo.from.orbit', 'Theodora Blackwood-Winterbourne'), roles: [] },
  { spaceId: SPACE_ID, userId: 'u-kai', nickname: null, joinedAt: 1, user: user('u-kai', 'kai', null), roles: [] },
];

interface StoredOverride { channelId: string; targetType: string; targetId: string; allow: string; deny: string }

function seededOverrides(scene: Scene): StoredOverride[] {
  if (scene === 'empty') return [];
  const o = (targetType: string, targetId: string, allow: bigint, deny: bigint): StoredOverride => ({
    channelId: CHANNEL_ID, targetType, targetId, allow: permissionsToString(allow), deny: permissionsToString(deny),
  });
  const everyRole = scene === 'full' ? [o('role', 'r-member', PermissionBits.ADD_REACTIONS, 0n)] : [];
  const hidden = scene === 'private-removed' || scene === 'private-cleared';
  const everyoneDeny = hidden ? PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES : PermissionBits.SEND_MESSAGES;
  return [
    ...everyRole,
    o('role', SPACE_ID, 0n, everyoneDeny),
    o('role', 'r-mod', PermissionBits.SEND_MESSAGES | PermissionBits.MANAGE_MESSAGES, 0n),
    o('role', 'r-dj', PermissionBits.SEND_MESSAGES, 0n),
    o('role', 'r-guest', 0n, PermissionBits.ADD_REACTIONS | PermissionBits.ATTACH_FILES),
    o('member', 'u-mira', PermissionBits.ATTACH_FILES, 0n),
  ];
}

function stubOverrideRoutes(scene: Scene, entity: Entity): void {
  const base = entity === 'category' ? `/api/categories/${CATEGORY_ID}/overrides` : `/api/channels/${CHANNEL_ID}/overrides`;
  let rows = seededOverrides(scene);
  const realFetch = window.fetch.bind(window);
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = new URL(url, window.location.href).pathname;
    if (path === base && method === 'GET') return json(rows);
    if (path === base && method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Omit<StoredOverride, 'channelId'>;
      rows = rows.filter((r) => !(r.targetType === body.targetType && r.targetId === body.targetId));
      rows.push({ channelId: CHANNEL_ID, ...body });
      return json({ success: true });
    }
    const del = path.match(new RegExp(`^${base}/([^/]+)/([^/]+)$`));
    if (del && method === 'DELETE') {
      rows = rows.filter((r) => !(r.targetType === del[1] && r.targetId === del[2]));
      return json({ success: true });
    }
    return realFetch(input, init);
  };
}

function seedStores(entity: Entity): void {
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    channels: [CHANNEL],
    categories: [CATEGORY],
    roles: ROLES,
    members: MEMBERS,
    spacePermissions: new Map([[SPACE_ID, permissionsToString(ALL_PERMISSIONS)]]),
    channelPermissions: new Map([[CHANNEL_ID, permissionsToString(ALL_PERMISSIONS)]]),
  });
  useUIStore.setState(entity === 'category'
    ? { activeModal: 'categorySettings', modalData: { categoryId: CATEGORY_ID } }
    : { activeModal: 'channelSettings', modalData: { channelId: CHANNEL_ID } });
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

function rowButton(label: string): HTMLButtonElement | null {
  return Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-expanded') !== null && b.textContent?.startsWith(label)) ?? null;
}

/** Types into a React-controlled input the way a keystroke would. */
function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function drive(scene: Scene): Promise<void> {
  const tab = await waitFor(() => buttonByText('Permissions'));
  tab.click();
  if (scene === 'empty' || scene === 'many') return;
  if (scene === 'everyone') {
    (await waitFor(() => rowButton('@everyone'))).click();
    return;
  }
  if (scene === 'private-removed') {
    await waitFor(() => rowButton('@everyone'));
    (await waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Remove override for @everyone"]'))).click();
    return;
  }
  if (scene === 'private-cleared' || scene === 'long-edit') {
    const permission = scene === 'private-cleared' ? 'View Channels' : 'Send Messages';
    (await waitFor(() => rowButton('@everyone'))).click();
    const label = await waitFor(() => Array.from(document.querySelectorAll('span')).find((el) => el.textContent === permission) ?? null);
    const neutral = label.parentElement?.querySelector<HTMLButtonElement>('button[title="Neutral (inherit)"]');
    if (!neutral) throw new Error(`harness: no neutral toggle on ${permission}`);
    neutral.click();
    return;
  }
  if (scene === 'full') {
    await waitFor(() => rowButton('Members'));
    (await waitFor(() => buttonByText('Add Role'))).click();
    return;
  }
  if (scene === 'members' || scene === 'no-match') {
    await waitFor(() => rowButton('Moderators'));
    (await waitFor(() => buttonByText('Add Member'))).click();
    if (scene === 'no-match') {
      const input = await waitFor(() => document.querySelector<HTMLInputElement>('input.input-search'));
      typeInto(input, 'nobody here');
    }
    return;
  }
  const row = await waitFor(() => rowButton('Moderators'));
  row.click();
  if (scene === 'expanded') return;
  const remove = await waitFor(() => buttonByText('Remove override'));
  remove.click();
  if (scene === 'picker') (await waitFor(() => buttonByText('Add Role'))).click();
}

async function start(): Promise<void> {
  const raw = new URLSearchParams(window.location.search).get('scene');
  const scene: Scene = SCENES.find((s) => s === raw) ?? 'many';
  const entity: Entity = new URLSearchParams(window.location.search).get('entity') === 'category' ? 'category' : 'channel';
  initializeInterfaceScale();
  await initI18n();
  stubOverrideRoutes(scene, entity);
  seedStores(entity);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(entity === 'category' ? <CategorySettingsModal /> : <ChannelSettingsModal />);
  await drive(scene);
}

void start();
