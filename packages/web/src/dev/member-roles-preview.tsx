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
//   no-roles  the profile card of a member without roles.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MemberWithUser, Role, User } from '@backspace/shared';
import { MemberSidebar } from '../components/layout/MemberSidebar';
import { UserProfilePopout } from '../components/ui/UserProfilePopout';
import { UserProfileModal } from '../components/modals/UserProfileModal';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type Scene = 'list' | 'card' | 'profile' | 'no-roles';
const SCENES: readonly Scene[] = ['list', 'card', 'profile', 'no-roles'];

const SPACE_ID = 'space-1';
const SPACE: TaggedSpace = {
  id: SPACE_ID, name: 'Aether Drift', icon: null, banner: null, avatarColor: 'lavender',
  ownerId: 'u-owner', inviteCode: null, visibility: 'public', directoryListed: false,
  description: '', createdAt: 1, _instanceOrigin: '',
};

function role(id: string, name: string, color: string, position: number): Role {
  return { id, spaceId: SPACE_ID, name, color, position, createdAt: 1 };
}

const MODS = role('r-mod', 'Moderators', '#c4b5fd', 4);
const DJ = role('r-dj', 'Night shift listening party organisers and friends', '#ffc9a9', 3);
const MEMBERS_ROLE = role('r-member', 'Members', '#a5f3c4', 2);
const GUESTS = role('r-guest', 'Guests', '#93c5fd', 1);

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

function member(u: User, roles: Role[]): MemberWithUser {
  return { spaceId: SPACE_ID, userId: u.id, nickname: null, joinedAt: 1, user: u, roles };
}

const MEMBER_ROWS: MemberWithUser[] = [
  member(user('u-owner', 'Jannis', 'online'), []),
  member(user('u-ada', 'Ada', 'online'), [MODS]),
  member(user('u-lena', 'Lena', 'idle'), [MEMBERS_ROLE]),
  member(user('u-kai', 'Kai', 'dnd'), [GUESTS]),
  member(MIRA, [GUESTS, DJ, MODS]),
  member(user('u-ivo', 'Ivo', 'offline'), [MEMBERS_ROLE]),
  member(TOBI, []),
];

function seed(scene: Scene): void {
  useSpaceStore.setState({
    spaces: [SPACE], currentSpaceId: SPACE_ID, loadingSpaceId: null,
    members: MEMBER_ROWS, roles: [role(SPACE_ID, '@everyone', '#b9bbbe', 0), MODS, DJ, MEMBERS_ROLE, GUESTS],
  });
  useUIStore.setState({ isMobile: false, memberListOpen: true });
  if (scene === 'profile') {
    useUIStore.setState({ activeModal: 'userProfile', modalData: { userId: MIRA.id, member: { spaceId: SPACE_ID, userId: MIRA.id } } });
  }
}

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
    </MemoryRouter>
  );
}

async function start(): Promise<void> {
  const raw = new URLSearchParams(window.location.search).get('scene');
  const scene: Scene = SCENES.find((s) => s === raw) ?? 'list';
  initializeInterfaceScale();
  await initI18n();
  stubUsersAndMutuals();
  seed(scene);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  createRoot(host).render(<Workbench scene={scene} />);
}

void start();
