// Dev-only workbench for how a space member's roles show outside space
// settings: the member list, the profile card and the full profile. Nothing in
// the app imports this file; `dev-member-roles.html` is its only entry.
//
// `?scene=<name>`:
//   list      the member list with online and offline members holding roles.
//   card      the list with the profile card open on an offline member who
//             holds several roles, one with a long name, and whose home is
//             another instance.
//   profile   the full profile of the same member, as mobile opens it (ids
//             only, the user read from the space).
//   no-roles  the profile card of a member without roles; the viewer, a
//             moderator, may edit them, so the card offers Edit Roles.
//
// The viewer is Ada, a moderator (Moderators, MANAGE_ROLES), except in
// editor-owner. The member role editor scenes (MemberRolesModal):
//   editor-owner  the owner editing Mira: nothing locked.
//   editor-mod    Ada editing Lena: roles at or above Ada locked, a role
//                 with bits Ada lacks locked for giving, unheld toggles locked.
//   editor-above  the same with Admins selected: read-only, with the note.
//   editor-dirty  a checkbox and a toggle changed: the save pill.
//   editor-error  the save refused by the server: the error in the pill.
//   editor-long   a long member name and a long role name.
// `?lang=de` (the app's dev-only switch) renders any scene in German.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { MemberSidebar } from '../components/layout/MemberSidebar';
import { UserProfilePopout } from '../components/ui/UserProfilePopout';
import { UserProfileModal } from '../components/modals/UserProfileModal';
import { MemberRolesModal } from '../components/modals/MemberRolesModal';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';
import { api, HttpError } from '../api/client';
import { ALL_PERMISSIONS, PermissionBits, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene =
  | 'list' | 'card' | 'profile' | 'no-roles'
  | 'editor-owner' | 'editor-mod' | 'editor-above' | 'editor-dirty' | 'editor-error' | 'editor-long';
const SCENES: readonly Scene[] = [
  'list', 'card', 'profile', 'no-roles',
  'editor-owner', 'editor-mod', 'editor-above', 'editor-dirty', 'editor-error', 'editor-long',
];

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', ownerTitle: null, inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: '',
};

function role(id: string, name: string, color: string, position: number, permissions: bigint): Role {
  return { id, spaceId: SPACE_ID, name, color, position, permissions: permissionsToString(permissions), createdAt: 1 };
}

const B = PermissionBits;
const EVERYONE_BITS = B.VIEW_CHANNEL | B.SEND_MESSAGES | B.READ_MESSAGE_HISTORY | B.ADD_REACTIONS | B.CONNECT | B.SPEAK;
const EVERYONE = role(SPACE_ID, '@everyone', '#b9bbbe', 0, EVERYONE_BITS);
const ADMINS = role('r-admin', 'Admins', '#fda4af', 5, B.ADMINISTRATOR);
const MODS = role('r-mod', 'Moderators', '#c4b5fd', 4, B.MANAGE_ROLES | B.KICK_MEMBERS | B.MANAGE_MESSAGES | B.MUTE_MEMBERS);
const DJ = role('r-dj', 'Night shift listening party organisers and friends', '#ffc9a9', 3, B.MOVE_MEMBERS | B.STREAM);
const MEMBERS_ROLE = role('r-member', 'Members', '#a5f3c4', 2, B.ATTACH_FILES | B.CREATE_INVITE);
const GUESTS = role('r-guest', 'Guests', '#93c5fd', 1, 0n);
const ROLES = [EVERYONE, ADMINS, MODS, DJ, MEMBERS_ROLE, GUESTS];

function user(id: string, displayName: string, status: User['status'], extra: Partial<User> = {}): User {
  return {
    id, username: displayName.toLowerCase(), displayName, avatar: null, banner: null, accentColor: null,
    avatarColor: null, bio: null, status, customStatus: null, isAdmin: false, createdAt: 1_690_000_000_000,
    homeInstance: null, homeUserId: null, replicatedInstances: [], ...extra,
  };
}

const MIRA = user('u-mira', 'Mira', 'offline', {
  username: 'mira@orbit.ddns.net', homeInstance: 'orbit.ddns.net', homeUserId: 'orbit-mira',
  bio: 'Runs the Thursday listening nights. Ask me about field recordings.',
});
const TOBI = user('u-tobi', 'Tobi', 'offline');
const ADA = user('u-ada', 'Ada', 'online');
const OWNER = user('u-owner', 'Jannis', 'online');
const LENA = user('u-lena', 'Lena', 'idle');
const MAX = user('u-max', 'Maximiliane Theodora von Wolkenstein-Hohenberg', 'online');

function member(u: User, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: u.id, nickname: null, joinedAt: 1, user: u, roles };
}

const MEMBER_ROWS: MemberWithUser[] = [
  member(OWNER, []),
  member(user('u-sol', 'Sol', 'online'), [ADMINS]),
  member(ADA, [MODS]),
  member(LENA, [MEMBERS_ROLE]),
  member(MAX, [DJ, MEMBERS_ROLE]),
  member(user('u-kai', 'Kai', 'dnd'), [GUESTS]),
  member(MIRA, [GUESTS, DJ, MODS]),
  member(user('u-ivo', 'Ivo', 'offline'), [MEMBERS_ROLE]),
  member(TOBI, []),
];

/** Who the member role editor is opened for in each editor scene. */
const EDITOR_TARGET: Partial<Record<Scene, User>> = {
  'editor-owner': MIRA,
  'editor-mod': LENA,
  'editor-above': LENA,
  'editor-dirty': LENA,
  'editor-error': LENA,
  'editor-long': MAX,
};

function seed(scene: Scene): void {
  const viewerIsOwner = scene === 'editor-owner';
  useAuthStore.setState({ user: viewerIsOwner ? OWNER : ADA });
  useSpaceStore.setState({
    spaces: [SPACE], currentSpaceId: SPACE_ID, loadingSpaceId: null,
    members: MEMBER_ROWS, roles: ROLES,
    spacePermissions: new Map([[SPACE_ID, permissionsToString(viewerIsOwner ? ALL_PERMISSIONS : MODS_HELD)]]),
    loadSpaceDetail: async () => undefined,
  });
  useUIStore.setState({ isMobile: false, memberListOpen: true });
  if (scene === 'profile') {
    useUIStore.setState({ activeModal: 'userProfile', modalData: { userId: MIRA.id, member: { spaceId: SPACE_ID, userId: MIRA.id } } });
  }
  const target = EDITOR_TARGET[scene];
  if (target) {
    useUIStore.setState({ activeModal: 'memberRoles', modalData: { spaceId: SPACE_ID, userId: target.id } });
  }
  // The save, answered locally: refused in the error scene, accepted elsewhere.
  api.spaces.updateMember = async (_spaceId, userId) => {
    await new Promise((r) => setTimeout(r, 100));
    if (scene === 'editor-error') throw new HttpError(403, 'refused', undefined, 'role_hierarchy');
    const row = MEMBER_ROWS.find((m) => m.userId === userId);
    if (!row) throw new HttpError(404, 'missing', undefined, 'member_not_found');
    return row;
  };
}

/** What Ada holds: her Moderators bits and @everyone's. */
const MODS_HELD = (B.MANAGE_ROLES | B.KICK_MEMBERS | B.MANAGE_MESSAGES | B.MUTE_MEMBERS) | EVERYONE_BITS;

function stubUsersAndMutuals(): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, window.location.href).pathname;
    if (path.startsWith('/api/')) {
      return new Response(JSON.stringify({ mutualFriends: [], mutualSpaces: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
}

const ANCHOR = { top: 250, left: 960, right: 1200, bottom: 290, width: 240, height: 40 };

function Workbench({ scene }: { scene: Scene }) {
  const cardUser = scene === 'no-roles' ? TOBI : MIRA;
  return (
    <MemoryRouter>
      <div className="h-screen flex bg-surface-chat">
        <div className="flex-1" />
        <MemberSidebar />
      </div>
      {(scene === 'card' || scene === 'no-roles') && (
        <UserProfilePopout
          user={cardUser}
          member={{ spaceId: SPACE_ID, userId: cardUser.id }}
          onClose={() => undefined}
          anchor={ANCHOR}
          placement="left"
        />
      )}
      <UserProfileModal />
      <MemberRolesModal />
    </MemoryRouter>
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

/** The role's name in the editor's left pane (it carries the name as its title). */
function roleNameIn(name: string): Promise<HTMLElement> {
  return waitFor(() => document.querySelector<HTMLElement>(`span[title="${name}"]`));
}

async function driveEditor(scene: Scene): Promise<void> {
  if (scene === 'editor-above') (await roleNameIn('Admins')).click();
  if (scene === 'editor-dirty' || scene === 'editor-error') {
    const guests = await roleNameIn('Guests');
    guests.parentElement?.querySelector<HTMLInputElement>('input[type="checkbox"]')?.click();
    (await roleNameIn('Members')).click();
    const toggle = await waitFor(() => document.querySelector<HTMLElement>('[role="switch"][aria-label="Manage Messages"], [role="switch"][aria-label="Nachrichten verwalten"]'));
    toggle.click();
  }
  if (scene === 'editor-error') {
    const save = await waitFor(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent === 'Save' || b.textContent === 'Speichern') ?? null);
    save.click();
  }
}

// Headless Chrome's virtual time does not run CSS transitions, so a shot
// taken after a click would show colours and toggles part way through. The
// workbench shows every state settled.
function settleTransitions(): void {
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
}

async function start(): Promise<void> {
  settleTransitions();
  const raw = new URLSearchParams(window.location.search).get('scene');
  const scene: Scene = SCENES.find((s) => s === raw) ?? 'list';
  initializeInterfaceScale();
  await initI18n();
  stubUsersAndMutuals();
  seed(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
  await driveEditor(scene);
}

void start();
