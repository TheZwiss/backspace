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
//
// The held-bits scenes (permissions.md, "Held-bits rule") show what the
// Helpers member may switch. Helpers hold view, send, kick, ban, manage roles
// and mute; the owner has given Members Create Invite and Attach Files.
//   held-role        the Roles panel on Members: toggles for bits the viewer
//                    does not hold are locked, with the note; Copy blocked.
//   held-everyone    the same on @everyone.
//   held-owner       the owner on Members: nothing locked.
//   held-mobile      held-role at phone width.
//   held-overrides   channel overrides: Members opened with Manage Messages
//                    allowed by the owner (locked, remove locked), @everyone
//                    opened with only held bits (removable).
//   members-held     the Members panel with Tobi's role editor open: roles
//                    above the viewer and Members (which carries bits the
//                    viewer lacks) locked, each reason under the list.
//   overrides-higher channel overrides on Moderators (above the viewer) and
//                    on Ada (ranked above the viewer): read-only, opened.
//   voice-refusal    a voice moderation action refused by the server over
//                    the WebSocket (`error` with code role_hierarchy): the
//                    toast the socket handler raises, through the same
//                    describeErrorCode call.
// `?lang=de` (the app's dev-only switch) renders any scene in German.
import { createRoot } from 'react-dom/client';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { MembersPanel } from '../components/modals/spaceSettingsPanels/MembersPanel';
import { RolesPanel } from '../components/modals/spaceSettingsPanels/RolesPanel';
import { PermissionsEditor, type Override } from '../components/ui/PermissionsEditor';
import type { PermissionDef } from '../components/ui/OverrideEntry';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { api, HttpError } from '../api/client';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { describeErrorCode } from '../i18n/errors';
import { ToastContainer } from '../components/ui/ToastContainer';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'members' | 'role-locked' | 'role-editable'
  | 'order-owner' | 'order-moderator' | 'order-keyboard' | 'order-error' | 'order-mobile' | 'order-mobile-moderator'
  | 'held-role' | 'held-everyone' | 'held-owner' | 'held-mobile' | 'held-overrides'
  | 'members-held' | 'overrides-higher' | 'voice-refusal';
const SCENES: readonly Scene[] = [
  'members', 'role-locked', 'role-editable',
  'order-owner', 'order-moderator', 'order-keyboard', 'order-error', 'order-mobile', 'order-mobile-moderator',
  'held-role', 'held-everyone', 'held-owner', 'held-mobile', 'held-overrides',
  'members-held', 'overrides-higher', 'voice-refusal',
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

// ─── Held-bits scenes ───────────────────────────────────────────────────────

const H_MEMBERS = role('r-member', 'Members', '#a5f3c4', 1, permissionsToString(
  PermissionBits.VIEW_CHANNEL | PermissionBits.SEND_MESSAGES | PermissionBits.CREATE_INVITE | PermissionBits.ATTACH_FILES,
));

const TEXT_PERMS: PermissionDef[] = [
  { key: 'VIEW_CHANNEL', bit: PermissionBits.VIEW_CHANNEL },
  { key: 'SEND_MESSAGES', bit: PermissionBits.SEND_MESSAGES },
  { key: 'MANAGE_MESSAGES', bit: PermissionBits.MANAGE_MESSAGES },
  { key: 'ATTACH_FILES', bit: PermissionBits.ATTACH_FILES },
  { key: 'READ_MESSAGE_HISTORY', bit: PermissionBits.READ_MESSAGE_HISTORY },
  { key: 'ADD_REACTIONS', bit: PermissionBits.ADD_REACTIONS },
];

const HELD_OVERRIDES: Override[] = [
  { targetType: 'role', targetId: SPACE_ID, allow: '0', deny: permissionsToString(PermissionBits.SEND_MESSAGES) },
  { targetType: 'role', targetId: 'r-member', allow: permissionsToString(PermissionBits.MANAGE_MESSAGES | PermissionBits.SEND_MESSAGES), deny: '0' },
];

function seedHeld(scene: Scene): void {
  seed();
  const owner = scene === 'held-owner';
  if (owner) useAuthStore.setState({ user: user('owner', 'Jannis') });
  useUIStore.setState({ isMobile: scene === 'held-mobile' });
  useSpaceStore.setState({
    roles: [EVERYONE, MODS, HELPERS, H_MEMBERS],
    spacePermissions: new Map([[SPACE_ID, owner ? permissionsToString(ALL_PERMISSIONS) : MODERATION]]),
  });
}

const HIGHER_OVERRIDES: Override[] = [
  { targetType: 'role', targetId: 'r-mod', allow: '0', deny: permissionsToString(PermissionBits.ATTACH_FILES) },
  { targetType: 'role', targetId: 'r-member', allow: '0', deny: permissionsToString(PermissionBits.ADD_REACTIONS) },
  { targetType: 'member', targetId: 'senior', allow: permissionsToString(PermissionBits.SEND_MESSAGES), deny: '0' },
];

function OverridesBench({ overrides }: { overrides: Override[] }) {
  return (
    <PermissionsEditor
      entityId="channel-1"
      spaceId={SPACE_ID}
      permDefs={TEXT_PERMS}
      unhideNote=""
      overrides={overrides}
      putOverride={async () => ({ success: true })}
      deleteOverride={async () => ({ success: true })}
      onSaved={() => undefined}
    />
  );
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
      <div className={scene.startsWith('order-mobile') || scene === 'held-mobile' ? 'px-4 w-[390px]' : 'px-6 max-w-[640px] mx-auto'}>
        {scene === 'voice-refusal' ? <ToastContainer />
          : scene === 'members' ? <MembersPanel spaceId={SPACE_ID} />
          : scene === 'held-overrides' ? <OverridesBench overrides={HELD_OVERRIDES} />
            : scene === 'overrides-higher' ? <OverridesBench overrides={HIGHER_OVERRIDES} />
            : scene === 'members-held' ? <MembersPanel spaceId={SPACE_ID} />
            : <RolesPanel spaceId={SPACE_ID} />}
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
  else if (scene.startsWith('held-') || scene === 'members-held' || scene === 'overrides-higher') seedHeld(scene);
  else seed();
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
  if (scene === 'voice-refusal') {
    useUIStore.getState().addToast(describeErrorCode('role_hierarchy', 'You can only do that to members and roles ranked below your highest role.'), 'warning', 0);
  }
  if (scene === 'members') await clickText('Lena', '.text-sm.font-medium');
  if (scene === 'role-locked') await clickText('Moderators', 'button');
  if (scene === 'role-editable') await clickText('Members', 'button');
  if (scene === 'held-role' || scene === 'held-owner' || scene === 'held-mobile') await clickText('Members', 'button');
  if (scene === 'held-everyone') await clickText('@everyone', 'button');
  if (scene === 'members-held') await clickText('Tobi', '.text-sm.font-medium');
  if (scene === 'overrides-higher') {
    await clickText('Moderators', 'button[aria-expanded]');
    await clickText('Ada', 'button[aria-expanded]');
  }
  if (scene === 'held-overrides') {
    await clickText('Members', 'button[aria-expanded]');
    await clickText('@everyone', 'button[aria-expanded]');
  }
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
