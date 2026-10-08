// Dev-only workbench for the DM header call button. Nothing in the app
// imports this file; `dev-dm-call.html` is its only entry.
//
// `?state=<name>` renders one state:
//   phone states    `MobileChatScreen` for a seeded DM in a 390px frame, with
//                   `data-viewport` pinned to mobile. Headless Chrome cannot
//                   go below 500px, so screenshot the left 390px.
//   desktop-*       `MainContent` for the same DM in a 1000px frame, to show
//                   the desktop header next to the mobile one.
// With no `state`, the page links every state.
//
// Every component is the real one. The edge is replaced: `loadMessages`
// is a no-op and the conversation is seeded into the chat store, and the voice
// store holds the call slots each state needs.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DmChannel, MessageWithUser, User } from '@backspace/shared';
import { MobileChatScreen } from '../components/layout/MobileChatScreen';
import { MainContent } from '../components/layout/MainContent';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { useVoiceStore } from '../stores/voiceStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

const STATES = {
  idle: '1:1 DM, nothing ringing: the call button starts a call.',
  ringing: 'Calling Alice from this DM: the button cancels.',
  incoming: 'Alice is calling in: starting another call is refused.',
  'in-call': 'In a call with Alice: the button opens the call screen.',
  busy: 'In a call with someone else: starting another call is refused.',
  deleted: 'The partner deleted their account: no call button.',
  group: 'Group DM, idle: call button next to the group info button.',
  'group-ringing': 'Group DM, ringing.',
  'long-name': '1:1 DM with a very long display name, idle.',
  'long-name-ringing': '1:1 DM with a very long display name, ringing.',
  'desktop-idle': 'Desktop DM header, idle.',
  'desktop-ringing': 'Desktop DM header, ringing (banner with Cancel).',
} as const;
type CallState = keyof typeof STATES;

const PHONE_PX = 390;
const DESKTOP_PX = 1000;

function readState(search: string): CallState | null {
  const value = new URLSearchParams(search).get('state');
  return value !== null && value in STATES ? (value as CallState) : null;
}

function person(id: string, username: string, displayName: string | null, avatarColor: string): User {
  return {
    id,
    username,
    displayName,
    avatar: null,
    banner: null,
    accentColor: null,
    avatarColor,
    bio: null,
    status: 'online',
    customStatus: null,
    isAdmin: false,
    createdAt: 1,
    homeInstance: null,
    homeUserId: null,
    replicatedInstances: [],
  } as User;
}

const ME = person('me', 'jannis', 'Jannis', 'lavender');
const ALICE = person('alice', 'alice', 'Alice', 'rose');
const BOB = person('bob', 'bob', 'Bob', 'mint');
const LONG = person('long', 'maximiliane', 'Maximiliane von Hohenzollern-Sigmaringen', 'peach');

function dmWith(id: string, members: User[], ownerId: string | null): DmChannel {
  return {
    id,
    federatedId: id,
    ownerId,
    ownerHomeUserId: null,
    ownerHomeInstance: null,
    createdAt: 1,
    members: [ME, ...members],
    lastMessage: null,
    name: null,
    icon: null,
    metadataUpdatedAt: 1,
  };
}

const BASE = new Date(2026, 8, 29, 17, 27).getTime();

function conversation(channelId: string, partner: User): MessageWithUser[] {
  const lines: Array<[User, string]> = [
    [partner, 'hey, got a minute?'],
    [ME, 'sure, calling you'],
    [partner, 'ok'],
  ];
  return lines.map(([author, content], n) => ({
    id: `${channelId}-${n}`,
    channelId,
    userId: author.id,
    replyToId: null,
    replyTo: null,
    content,
    editedAt: null,
    createdAt: BASE + n * 60_000,
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  }));
}

/** The DM a state shows, and which call slots are taken. */
function scenario(state: CallState): { dm: DmChannel; partner: User } {
  if (state === 'group' || state === 'group-ringing') {
    return { dm: dmWith('dm-group', [ALICE, BOB], ME.id), partner: ALICE };
  }
  if (state === 'long-name' || state === 'long-name-ringing') {
    return { dm: dmWith('dm-long', [LONG], null), partner: LONG };
  }
  if (state === 'deleted') {
    return { dm: dmWith('dm-alice', [{ ...ALICE, isDeleted: true }], null), partner: ALICE };
  }
  return { dm: dmWith('dm-alice', [ALICE], null), partner: ALICE };
}

function seedStores(state: CallState, dm: DmChannel, partner: User): void {
  const mobile = !state.startsWith('desktop');
  useAuthStore.setState({ user: ME });
  useSpaceStore.setState({
    dmChannels: [dm],
    channels: [],
    spaces: [],
    currentSpaceId: null,
    channelOriginMap: new Map([[dm.id, '']]),
  });
  useChatStore.setState({
    currentChannelId: dm.id,
    messages: new Map([[dm.id, conversation(dm.id, partner)]]),
    hasMore: new Map([[dm.id, false]]),
    loadMessages: async () => true,
  });
  useUIStore.setState({ isMobile: mobile, showDms: true, mobileStack: [] });
  const ringing = state === 'ringing' || state === 'group-ringing' || state === 'long-name-ringing' || state === 'desktop-ringing';
  useVoiceStore.setState({
    outgoingCall: ringing ? { dmChannelId: dm.id, withCamera: false } : null,
    incomingCall: state === 'incoming'
      ? { dmChannelId: dm.id, federatedCallId: null, callOrigin: null, callerId: ALICE.id, callerName: 'Alice', livekit: null }
      : null,
    activeDmCall: state === 'in-call' ? { dmChannelId: dm.id, federatedCallId: null, callOrigin: null, livekit: null }
      : state === 'busy' ? { dmChannelId: 'dm-other', federatedCallId: null, callOrigin: null, livekit: null } : null,
  });
}

function pinViewport(kind: 'mobile' | 'desktop'): void {
  const pin = () => { document.documentElement.dataset.viewport = kind; };
  window.addEventListener('resize', pin);
  pin();
}

function Index() {
  return (
    <div className="min-h-screen bg-surface-base p-6 flex flex-col gap-2">
      {(Object.keys(STATES) as CallState[]).map((name) => (
        <a key={name} href={`?state=${name}`} className="text-sm text-txt-secondary hover:text-txt-primary">
          <span className="font-semibold text-txt-primary">{name}</span>: {STATES[name]}
        </a>
      ))}
    </div>
  );
}

async function start(): Promise<void> {
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  const state = readState(window.location.search);
  if (state === null) {
    createRoot(host).render(<Index />);
    return;
  }
  const desktop = state.startsWith('desktop');
  pinViewport(desktop ? 'desktop' : 'mobile');
  await initI18n();
  const { dm, partner } = scenario(state);
  seedStores(state, dm, partner);
  createRoot(host).render(
    <MemoryRouter initialEntries={[`/channels/@me/${dm.id}`]}>
      <div style={{ width: desktop ? DESKTOP_PX : PHONE_PX, height: 'calc(100 * var(--app-vh))' }} className="flex flex-col overflow-hidden">
        {desktop ? <MainContent /> : <MobileChatScreen params={{ channelId: dm.id, spaceId: '@me' }} />}
      </div>
    </MemoryRouter>,
  );
}

void start();
