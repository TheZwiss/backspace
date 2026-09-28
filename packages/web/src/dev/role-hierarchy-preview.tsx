// Dev-only workbench for the role hierarchy in space settings, seen by a
// moderator who is not the owner. Nothing in the app imports this file;
// `dev-role-hierarchy.html` is its only entry.
//
// The viewer holds Helpers (position 2). Moderators (3) rank above them,
// Members (1) below.
//
// `?scene=<name>`:
//   members        the Members panel with Junior's role editor open: kick
//                  and ban only on members ranked below the viewer, roles at
//                  or above the viewer's own greyed out.
//   role-locked    the Roles panel on Moderators: read-only, no Delete.
//   role-editable  the Roles panel on Members: editable as before.
//
// The order scenes use a larger role list (Admins 6 ... Guests 1) and a
// stubbed move call:
//   order-owner      the owner's role list: a handle on every role.
//   order-moderator  a Moderators member: Admins and Moderators locked, the
//                    Helpers handle focused so its arrows show (up disabled).
//   order-keyboard   the owner has just moved Regulars up with the arrow key;
//                    focus stays on its handle.
//   order-error      the move is refused: order put back, reason shown.
//   order-mobile     the phone layout: up and down buttons, no handles.
//   order-mobile-moderator  the phone layout for the Moderators member.
// `?lang=de` (the app's dev-only switch) renders any scene in German.
import { createRoot } from 'react-dom/client';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { MembersPanel } from '../components/modals/spaceSettingsPanels/MembersPanel';
import { RolesPanel } from '../components/modals/spaceSettingsPanels/RolesPanel';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { api, HttpError } from '../api/client';
import { PermissionBits, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'members' | 'role-locked' | 'role-editable'
  | 'order-owner' | 'order-moderator' | 'order-keyboard' | 'order-error' | 'order-mobile' | 'order-mobile-moderator';
const SCENES: readonly Scene[] = [
  'members', 'role-locked', 'role-editable',
  'order-owner', 'order-moderator', 'order-keyboard', 'order-error', 'order-mobile', 'order-mobile-moderator',
];

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender', ownerId: 'owner',
  inviteCode: null, visibility: 'public', directoryListed: false, description: null, createdAt: 1, _instanceOrigin: '',
};

const MODERATION = permissionsToString(
  PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES | PermissionBits.KICK_MEMBERS
  | PermissionBits.BAN_MEMBERS | PermissionBits.MANAGE_ROLES | PermissionBits.MUTE_MEMBERS,
);

function role(id: string, name: string, color: string, position: number, permissions: string): Role {
  return { id, spaceId: SPACE_ID, name, color, position, permissions, createdAt: 1 };
}
const EVERYONE = role(SPACE_ID, '@everyone', '#b9bbbe', 0, permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES));
const MODS = role('r-mod', 'Moderators', '#c4b5fd', 3, MODERATION);
const HELPERS = role('r-helper', 'Helpers', '#93c5fd', 2, MODERATION);
const MEMBERS_ROLE = role('r-member', 'Members', '#a5f3c4', 1, permissionsToString(PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES));

function user(id: string, displayName: string, status: User['status'] = 'online'): User {
  return {
    id, username: id, displayName, avatar: null, banner: null, accentColor: null, avatarColor: null, bio: null,
    status, customStatus: null, isAdmin: false, createdAt: 1, homeInstance: null, homeUserId: null, replicatedInstances: [],
  };
}
function member(u: User, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: u.id, nickname: null, joinedAt: 1, user: u, roles };
}

const VIEWER = user('helper', 'Hana');

function seed(): void {
  useAuthStore.setState({ user: VIEWER });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: [EVERYONE, MODS, HELPERS, MEMBERS_ROLE],
    members: [
      member(user('owner', 'Jannis'), []),
      member(user('senior', 'Ada'), [MODS]),
      member(VIEWER, [HELPERS]),
      member(user('peer', 'Kai', 'idle'), [HELPERS]),
      member(user('junior', 'Lena'), [MEMBERS_ROLE]),
      member(user('plain', 'Tobi', 'offline'), []),
    ],
    spacePermissions: new Map([[SPACE_ID, MODERATION]]),
    loadSpaceDetail: async () => undefined,
  });
}

// ─── Order scenes ───────────────────────────────────────────────────────────

const O_EVERYONE = role(SPACE_ID, '@everyone', '#b9bbbe', 0, permissionsToString(PermissionBits.VIEW_CHANNEL));
const O_ADMINS = role('o-admin', 'Admins', '#fda4af', 6, permissionsToString(PermissionBits.ADMINISTRATOR));
const O_MODS = role('o-mod', 'Moderators', '#c4b5fd', 5, MODERATION);
const O_HELPERS = role('o-helper', 'Helpers', '#93c5fd', 4, MODERATION);
const O_HOSTS = role('o-host', 'Community event coordinators and weekend stream hosts', '#fbbf24', 3, MODERATION);
const O_REGULARS = role('o-regular', 'Regulars', '#a5f3c4', 2, permissionsToString(PermissionBits.VIEW_CHANNEL));
const O_GUESTS = role('o-guest', 'Guests', '#b9bbbe', 1, permissionsToString(PermissionBits.VIEW_CHANNEL));
const ORDER_ROLES = [O_ADMINS, O_MODS, O_HELPERS, O_HOSTS, O_REGULARS, O_GUESTS, O_EVERYONE];

function seedOrder(scene: Scene): void {
  const asModerator = scene === 'order-moderator' || scene === 'order-mobile-moderator';
  const viewer = asModerator ? user('mod', 'Mira') : user('owner', 'Jannis');
  useAuthStore.setState({ user: viewer });
  useUIStore.setState({ isMobile: scene === 'order-mobile' || scene === 'order-mobile-moderator' });
  useSpaceStore.setState({
    spaces: [SPACE],
    currentSpaceId: SPACE_ID,
    roles: ORDER_ROLES,
    members: [
      member(user('owner', 'Jannis'), []),
      member(user('admin', 'Ada'), [O_ADMINS]),
      member(user('mod', 'Mira'), [O_MODS]),
      member(user('helper', 'Hana'), [O_HELPERS]),
    ],
    spacePermissions: new Map([[SPACE_ID, MODERATION]]),
    loadSpaceDetail: async () => undefined,
  });
  // The move call, answered locally: refused in the error scene, applied
  // (the list already shows it) everywhere else.
  api.roles.update = async (_spaceId, roleId, data) => {
    await new Promise((r) => setTimeout(r, 150));
    if (scene === 'order-error') {
      throw new HttpError(403, 'refused', undefined, 'role_hierarchy');
    }
    const moved = ORDER_ROLES.find((r) => r.id === roleId);
    if (!moved) throw new HttpError(404, 'missing', undefined, 'role_not_in_space');
    return { ...moved, position: data.position ?? moved.position };
  };
}

function Workbench({ scene }: { scene: Scene }) {
  return (
    <div className="min-h-screen py-6 bg-surface-chat">
      <div className={scene.startsWith('order-mobile') ? 'px-4 w-[390px]' : 'px-6 max-w-[640px] mx-auto'}>
        {scene === 'members' ? <MembersPanel spaceId={SPACE_ID} /> : <RolesPanel spaceId={SPACE_ID} />}
      </div>
    </div>
  );
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

function clickText(text: string, selector: string): Promise<void> {
  return waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(selector)).find((el) => el.textContent?.trim().startsWith(text)) ?? null)
    .then((el) => el.click());
}

async function start(): Promise<void> {
  const raw = new URLSearchParams(window.location.search).get('scene');
  const scene: Scene = SCENES.find((s) => s === raw) ?? 'members';
  initializeInterfaceScale();
  await initI18n();
  if (scene.startsWith('order-')) seedOrder(scene);
  else seed();
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
  if (scene === 'members') await clickText('Lena', '.text-sm.font-medium');
  if (scene === 'role-locked') await clickText('Moderators', 'button');
  if (scene === 'role-editable') await clickText('Members', 'button');
  if (scene === 'order-moderator') {
    const handle = await waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Move Helpers"], button[aria-label="Helpers verschieben"]'));
    handle.focus();
  }
  if (scene === 'order-keyboard') {
    const handle = await waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Move Regulars"], button[aria-label="Regulars verschieben"]'));
    handle.focus();
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  }
  if (scene === 'order-error') {
    const up = await waitFor(() => document.querySelector<HTMLButtonElement>('button[aria-label="Move Guests up"], button[aria-label="Guests nach oben verschieben"]'));
    up.click();
  }
}

void start();
