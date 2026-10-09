// Dev-only workbench for the surfaces the web-hygiene pass touches (#328,
// #329, #330). Nothing in the app imports this file; `dev-web-hygiene.html` is
// its only entry. Each `?scene=` renders the real component with seeded stores
// and, where it would reach a server, a locally answered fetch, so every
// colour-token fix, the space avatar palette, the embed action and the
// keyboard-reachable mention badge can be screenshotted without a session.
//
//   create-space        the Create Space modal: the dashed icon ring
//   space-settings      space settings on Overview, space colour teal: the
//                       header avatar next to the sidebar's icon for the same
//                       space, the dashed icon and banner rings
//   space-settings-hash the same with no stored colour: both fall back to the
//                       id hash, which must pick the same gradient
//   keybinds            the keybind rows (browser)
//   keybinds-portal     the desktop portal list (Wayland global shortcuts)
//   register-invite     registration closed: the invite-code box
//   invite-card         the space invite card in chat, space colour rose
//   rich-embed          click-to-load embeds: with and without a thumbnail
//   mention             resolved and unresolved mentions in message text, the
//                       resolved one focused from the keyboard (`&focus=none`
//                       leaves it unfocused)
//   user-settings       user settings opened by a deep link to Appearance, as
//                       an admin (all three nav groups)
//   emoji-picker        the emoji picker fed by the lazily loaded data chunk,
//                       next to a bio line with shortcodes
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Embed, InstanceInfoResponse, MemberWithUser, SpaceInviteSystemPayload, User } from '@backspace/shared';
import { CreateSpaceModal } from '../components/modals/CreateSpace';
import { UserSettingsModal } from '../components/modals/UserSettings';
import { useAuthStore } from '../stores/authStore';
import { SpaceSettingsModal } from '../components/modals/SpaceSettings';
import { KeybindsPanel } from '../components/modals/settingsPanels/KeybindsPanel';
import { RegisterPage } from '../components/auth/RegisterPage';
import { SpaceInviteCard } from '../components/chat/SpaceInviteCard';
import { RichEmbed } from '../components/chat/embeds/RichEmbed';
import { MentionBadge } from '../components/chat/MentionBadge';
import { EmojiPicker } from '../components/chat/EmojiPicker';
import { loadEmojiShortcodeNames, replaceEmojiShortcodes } from '../utils/emojiShortcodes';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useKeybindStore } from '../stores/keybindStore';
import { getSpaceGradient } from '../utils/gradients';
import { ALL_PERMISSIONS, permissionsToString } from '../utils/permissions';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

const SCENES = [
  'create-space',
  'space-settings',
  'space-settings-hash',
  'keybinds',
  'keybinds-portal',
  'register-invite',
  'invite-card',
  'rich-embed',
  'mention',
  'user-settings',
  'emoji-picker',
] as const;
type Scene = (typeof SCENES)[number];

function readScene(): Scene {
  const raw = new URLSearchParams(window.location.search).get('scene');
  return SCENES.find((s) => s === raw) ?? 'space-settings';
}

const SPACE: TaggedSpace = {
  id: 'workbench-space-7',
  name: 'Tidepool',
  icon: null,
  banner: null,
  avatarColor: 'teal',
  ownerTitle: null, ownerId: 'workbench-user',
  inviteCode: null,
  visibility: 'public',
  directoryListed: false,
  description: 'Rock pools, field notes and the odd crab.',
  createdAt: 1,
  _instanceOrigin: '',
};

const ME: User = {
  id: 'workbench-user',
  username: 'mira',
  displayName: 'Mira',
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

const KAI: User = { ...ME, id: 'u-kai', username: 'kai', displayName: 'Kai Okonkwo', avatarColor: 'sky', isAdmin: false };

function answer(pathPart: string, body: unknown): void {
  const passThrough = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(pathPart)) {
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    }
    return passThrough(input, init);
  };
}

function seedSpace(space: TaggedSpace): void {
  useSpaceStore.setState({
    spaces: [space],
    currentSpaceId: space.id,
    spacePermissions: new Map([[space.id, permissionsToString(ALL_PERMISSIONS)]]),
  });
  useUIStore.setState({ activeModal: 'spaceSettings', modalData: {} });
}

function SidebarIconSample({ space }: { space: TaggedSpace }) {
  const grad = getSpaceGradient(space.id, space.name, space.avatarColor);
  return (
    <div className="fixed left-4 top-4 z-[10000] flex items-center gap-3 rounded-lg bg-surface-channel px-3 py-2 text-xs text-txt-tertiary">
      <div
        className="flex h-12 w-12 items-center justify-center rounded-2xl text-lg font-bold text-white"
        style={{ background: grad.gradient }}
      >
        {space.name.charAt(0)}
      </div>
      sidebar icon
    </div>
  );
}

const EMBEDS: Embed[] = [
  {
    url: 'https://open.spotify.com/track/1',
    type: 'rich',
    provider: 'spotify',
    title: 'Low Tide (Field Recording, Part II)',
    description: 'Hydrophone, Brittany coast, November. 14 minutes of shingle and gulls.',
    image: '/icons/icon-192.png',
    embedUrl: 'https://open.spotify.com/embed/track/1',
    width: null,
    height: 152,
    siteName: 'Spotify',
    color: null,
  } as unknown as Embed,
  {
    url: 'https://soundcloud.com/x/y',
    type: 'rich',
    provider: 'soundcloud',
    title: 'Night set',
    description: null,
    image: null,
    embedUrl: 'https://w.soundcloud.com/player/?url=x',
    width: null,
    height: null,
    siteName: 'SoundCloud',
    color: null,
  } as unknown as Embed,
];

function member(user: User): MemberWithUser {
  return { spaceId: SPACE.id, userId: user.id, nickname: null, joinedAt: 1, user, roles: [] };
}

function Frame({ children, width = 720 }: { children: React.ReactNode; width?: number }) {
  return <div className="p-6" style={{ width }}>{children}</div>;
}

function Workbench({ scene }: { scene: Scene }) {
  switch (scene) {
    case 'create-space':
      return <CreateSpaceModal />;
    case 'space-settings':
    case 'space-settings-hash':
      return (
        <>
          <SidebarIconSample space={useSpaceStore.getState().spaces[0]!} />
          <SpaceSettingsModal />
        </>
      );
    case 'keybinds':
    case 'keybinds-portal':
      return (
        <div className="glass-modal m-6 w-[640px] rounded-xl p-6">
          <KeybindsPanel />
        </div>
      );
    case 'register-invite':
      return (
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
        </Routes>
      );
    case 'invite-card':
      return (
        <Frame>
          <div className="bg-surface-chat p-4">
            <SpaceInviteCard payload={INVITE} senderName="Kai" />
          </div>
        </Frame>
      );
    case 'rich-embed':
      return (
        <Frame>
          <div className="bg-surface-chat p-4">
            {EMBEDS.map((embed) => <RichEmbed key={embed.url} embed={embed} />)}
          </div>
        </Frame>
      );
    case 'user-settings':
      return <UserSettingsModal />;
    case 'emoji-picker':
      return (
        <Frame>
          <p className="mb-4 text-sm text-txt-secondary">{replaceEmojiShortcodes('Tide pools :ocean: and crabs :crab: :+1::skin-tone-4:')}</p>
          <EmojiPicker onEmojiSelect={() => {}} />
        </Frame>
      );
    case 'mention':
      return (
        <Frame>
          <div className="bg-surface-chat p-4 text-[15px] leading-[1.375rem] text-txt-message">
            <p>
              Thanks <MentionBadge userId={KAI.id} channelId="chan-1" /> for the recordings, and
              {' '}<MentionBadge userId="u-gone" channelId="chan-1" /> for the old ones.
            </p>
          </div>
        </Frame>
      );
  }
}

const INVITE: SpaceInviteSystemPayload = {
  event: 'space_invite',
  spaceId: 'remote-space-3',
  spaceInstanceOrigin: '',
  inviteCode: 'tide42',
  snapshot: {
    spaceName: 'Rosewater',
    icon: null,
    avatarColor: 'rose',
    memberCount: 12,
    description: null,
    instanceName: 'nova.ddns.net',
  },
};

async function main(): Promise<void> {
  initializeInterfaceScale();
  await Promise.all([initI18n(), loadEmojiShortcodeNames()]);
  const scene = readScene();

  if (scene === 'user-settings') {
    useAuthStore.setState({ user: ME } as never);
    useUIStore.setState({ activeModal: 'userSettings', modalData: { tab: 'appearance' } });
  }
  if (scene === 'create-space') useUIStore.setState({ activeModal: 'createSpace', modalData: {} });
  if (scene === 'space-settings') seedSpace(SPACE);
  if (scene === 'space-settings-hash') seedSpace({ ...SPACE, avatarColor: null });
  if (scene === 'keybinds') {
    useKeybindStore.setState({
      keybinds: [
        { actionId: 'toggleMute', keys: [1], displayLabel: 'Ctrl + Shift + M' },
        { actionId: 'pushToTalk', keys: [2], displayLabel: 'Mouse 4' },
      ],
    });
  }
  if (scene === 'keybinds-portal') {
    const status: KeybindPortalStatus = {
      state: 'ready',
      shortcuts: { toggleMute: 'Ctrl+Shift+M', pushToTalk: 'Mouse 4' },
    };
    window.backspace = {
      getKeybindPortalStatus: () => Promise.resolve(status),
      onKeybindPortalStatus: () => () => {},
    } as unknown as BackspaceElectronAPI;
  }
  if (scene === 'register-invite') {
    const info: InstanceInfoResponse = {
      name: 'Workbench',
      version: '1.7.0',
      registrationOpen: false,
      federatedRegistrationOpen: true,
      instanceId: 'instance-1',
      sourceCodeUrl: 'https://github.com/TheZwiss/backspace',
      commit: null,
      directoryConfigured: false,
      directoryAvailable: false,
      directoryEnabled: false,
      supportCardEnabled: false,
    };
    answer('/instance/info', info);
  }
  if (scene === 'invite-card') answer('/preview', { spaceId: INVITE.spaceId, memberCount: 12 });
  if (scene === 'mention') {
    useSpaceStore.setState({
      members: [member(KAI)],
      channelToSpaceMap: new Map([['chan-1', SPACE.id]]),
      currentSpaceId: SPACE.id,
      spaces: [SPACE],
    });
  }

  const host = document.getElementById('root');
  if (!host) throw new Error('root element missing');
  const initialPath = scene === 'register-invite' ? '/register' : '/';
  createRoot(host).render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Workbench scene={scene} />
    </MemoryRouter>,
  );

  if (scene === 'mention' && new URLSearchParams(window.location.search).get('focus') !== 'none') {
    // Tab from the page start: the first stop is the resolved badge.
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>('p button');
      target?.focus({ focusVisible: true } as FocusOptions);
    }, 300);
  }
}

void main();
