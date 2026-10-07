// Dev-only workbench for how a chat names people in the channel's own
// context (#338, #332): mention badges in a DM, the mention picker in a DM,
// the self-mention highlight in a DM pinned to a remote origin, and the
// typing indicator. Nothing in the app imports this file;
// `dev-channel-user.html` is its only entry.
//
// `?state=<name>` renders the real `MessageList` and `MessageInput` for one
// seeded channel in a 760px chat column. The states (the `STATES` table below
// says the same on screen):
//   dm-mention       a 1-on-1 DM with Kai on the home instance, opened
//                    straight after a start: no space roster loaded.
//                    Messages mention Kai, in the body and in a reply preview.
//   dm-picker        the same 1-on-1 with a stale roster of another space
//                    loaded (the space opened last), `@` typed in the
//                    composer: the picker lists Kai only.
//   space-picker     a space channel with its own roster loaded, `@` typed:
//                    role colours and the owner tint, for comparison.
//   remote-self      a DM pinned to a remote origin; one message mentions me
//                    by my id on that origin and carries the highlight.
// The typing states are in a group DM ("Release crew") so they can have
// several typers:
//   typing-one       one typer, a replicated stub whose username is still
//                    `<id>@instance`, shown by its display name.
//   typing-two       two typers.
//   typing-several   three typers: the summary.
//   typing-long      two typers with very long display names, one with an
//                    emoji sequence: each name truncates in its own box, the
//                    verb stays whole.
//   typing-long-de   the same, German.
//   typing-long-zh   two long Chinese names, Chinese.
//   typing-de        two typers, German.
// Naming a person without a display name (#346):
//   names            a 1-on-1 DM with Zed, a replicated user whose row has no
//                    display name (username `zed@orbit.example`), next to its
//                    DM list entry: the list entry, the author row, a reply
//                    preview, a mention badge and the typing line all say
//                    "zed".
//   names-display    the same with Iris, a replicated user of orbit who has
//                    a display name: the globe shows in the list entry, the
//                    author row and the reply preview alike.
//   picker-long      a group DM, `@` typed: a long display name over a long
//                    id-shaped username, a stub without a display name, and
//                    a local user without one. The display name keeps its
//                    width; the username truncates first.
//   picker-long-mobile  the same in the phone sheet. Shoot it 600px wide:
//                    headless Chrome lays out no narrower than about 500px.
//
// The composer's typing entries are stamped a minute ahead so they outlive
// the screenshot; the indicator drops entries older than five seconds.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DmChannel, MemberWithUser, MessageWithUser, Role, User } from '@backspace/shared';
import { MessageList } from '../components/chat/MessageList';
import { MessageInput } from '../components/chat/MessageInput';
import { DmListItem } from '../components/layout/DmListItem';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useSpaceStore, type TaggedSpace } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { initI18n, setLanguage } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import { ALL_PERMISSIONS, permissionsToString } from '../utils/permissions';
import '../styles/globals.css';

const STATES = {
  'dm-mention': 'DM opened straight after a start, no space roster: mentions of the other member.',
  'dm-picker': 'DM with a stale roster of another space loaded, @ typed: the DM members only.',
  'space-picker': 'Space channel with its own roster, @ typed: role colours and owner tint.',
  'remote-self': 'DM pinned to a remote origin: a mention of my id there is highlighted.',
  'typing-one': 'One typer, a stub whose username is <id>@instance.',
  'typing-two': 'Two typers.',
  'typing-several': 'Three typers: the summary.',
  'typing-long': 'Two typers with very long display names: each truncates, the verb stays.',
  'typing-long-de': 'Two typers with very long display names, German.',
  'typing-long-zh': 'Two typers with long Chinese names, Chinese.',
  'typing-de': 'Two typers, German.',
  'names': 'DM with a user who has no display name: list entry, author row, reply, mention and typing agree.',
  'names-display': 'DM with a federated user who has a display name: the globe shows wherever the list entry has it.',
  'picker-long': 'Group DM, @ typed: long display names and usernames; the username truncates first.',
  'picker-long-mobile': 'The same in the phone sheet.',
} as const;
type PreviewState = keyof typeof STATES;

const FRAME_WIDTH = 760;
/** The chat column of the phone state; see `picker-long-mobile` above. */
const PHONE_WIDTH = 600;
const ORBIT = 'https://orbit.example';
const DM_ID = 'workbench-dm';
const NAMES_DM_ID = 'workbench-names-dm';
const NAMES_DISPLAY_DM_ID = 'workbench-names-display-dm';
const PICKER_GROUP_ID = 'workbench-picker-group';
const GROUP_ID = 'workbench-group';
const REMOTE_DM_ID = 'workbench-remote-dm';
const CHANNEL = 'workbench-channel';
const SPACE = 'workbench-space';
const OTHER_SPACE = 'workbench-other-space';

function readState(search: string): PreviewState {
  const value = new URLSearchParams(search).get('state');
  return value !== null && value in STATES ? (value as PreviewState) : 'dm-mention';
}

// ─── People ─────────────────────────────────────────────────────────────────

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

const ME = person('me', 'quddy', 'Quddy', 'lavender');
const KAI = person('kai', 'kai', 'Kai', 'mint');
// A replicated stub the server named in the id shape; a display name was
// filled in later, the username was not.
const QUINN = person('quinn-stub', '1234567890123456789@friend.example', 'Quinn', 'sky');
const LONG_A = person('long-a', 'maximiliane', 'Maximiliane von Hohenzollern-Sigmaringen', 'rose');
const LONG_B = person('long-b', 'bartholomew', 'Bartholomew Featherstonehaugh 👨‍👩‍👧‍👦 family account', 'coral');
const ZH_A = person('zh-a', 'ouyang', '欧阳娜娜的超级长昵称不太适合显示在这里', 'sky');
const ZH_B = person('zh-b', 'sima', '司马相如与卓文君故事的讲述者之一号', 'peach');
const MIRA = person('mira', 'mira', 'Mira', 'peach');
const OSKAR = person('oskar', 'oskar', 'Oskar', 'amber');
const ZED = person('zed', 'zed', 'Zed', 'peach');
// The same people as the remote origin knows them: its own ids.
const ME_ON_ORBIT = { ...person('me-orbit', 'quddy@home.example', 'Quddy', 'lavender') };
const KAI_ON_ORBIT = { ...person('kai-orbit', 'kai', 'Kai', 'mint') };
// A replicated row for a user of orbit that has no display name.
const ZED_STUB: User = { ...person('zed-stub', 'zed@orbit.example', null, 'amber'), homeUserId: 'zed-home', homeInstance: 'orbit.example' };
// A replicated row for a user of orbit who has a display name.
const IRIS_STUB: User = { ...person('iris-stub', 'iris@orbit.example', 'Iris', 'sky'), homeUserId: 'iris-home', homeInstance: 'orbit.example' };
// Long names for the picker: a long display name over an id-shaped username.
const LONG_STUB: User = {
  ...person('long-stub', '987654321098765432@very-long-instance-name.example', 'Anastasia Konstantinovna Rimsky-Korsakova', 'rose'),
  homeUserId: '987654321098765432',
  homeInstance: 'very-long-instance-name.example',
};
const NIKA = person('nika', 'nika', null, 'mint');

const MODS = { id: 'role-mods', spaceId: SPACE, name: 'Mods', color: '#7dd3c0', position: 2 } as unknown as Role;

function member(spaceId: string, user: User, roles: Role[] = []): MemberWithUser {
  return { spaceId, userId: user.id, nickname: null, joinedAt: 1, user, roles };
}

// ─── Conversations ──────────────────────────────────────────────────────────

const BASE = new Date(2026, 8, 28, 18, 4).getTime();

function row(n: number, channel: { channelId: string; dmChannelId?: string }, author: User, content: string, replyTo?: MessageWithUser): MessageWithUser {
  return {
    id: String(2000 + n),
    channelId: channel.channelId,
    ...(channel.dmChannelId ? { dmChannelId: channel.dmChannelId } : {}),
    userId: author.id,
    replyToId: replyTo?.id ?? null,
    replyTo: replyTo ?? null,
    content,
    editedAt: null,
    createdAt: BASE + n * 3 * 60_000,
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  } as MessageWithUser;
}

function groupConversation(): MessageWithUser[] {
  const at = { channelId: '', dmChannelId: GROUP_ID };
  return [
    row(0, at, ME, 'Tagging the release in ten minutes.'),
    row(1, at, KAI, 'Windows build is green.'),
    row(2, at, MIRA, 'Notes are ready.'),
  ];
}

function dmConversation(): MessageWithUser[] {
  const at = { channelId: '', dmChannelId: DM_ID };
  const ask = row(0, at, ME, 'Hey <@kai>, did the server come back after the restart?');
  return [
    ask,
    row(1, at, KAI, 'It did. The backup ran at four, nothing lost.'),
    row(2, at, ME, 'Great. <@kai> can you send me the log when you get a minute?'),
    row(3, at, KAI, 'Sending it now.', ask),
  ];
}

function remoteConversation(): MessageWithUser[] {
  const at = { channelId: '', dmChannelId: REMOTE_DM_ID };
  return [
    row(0, at, KAI_ON_ORBIT, 'The orbit box is on the new version now.'),
    row(1, at, KAI_ON_ORBIT, '<@me-orbit> the invite link you asked for is in the pinned message.'),
    row(2, at, ME_ON_ORBIT, 'Got it, thanks.'),
  ];
}

function namesConversation(dmChannelId: string, other: User): MessageWithUser[] {
  const at = { channelId: '', dmChannelId };
  const question = row(0, at, other, 'Is the orbit box on the new version yet?');
  return [
    question,
    row(1, at, ME, `Yes, since this morning. <@${other.id}> the changelog is in the pinned message.`, question),
    row(2, at, other, 'Thanks, reading it now.'),
  ];
}

function spaceConversation(): MessageWithUser[] {
  const at = { channelId: CHANNEL };
  return [
    row(0, at, MIRA, 'Release notes are drafted. <@oskar> can you check the German part?'),
    row(1, at, OSKAR, 'On it.'),
  ];
}

// ─── Stores ─────────────────────────────────────────────────────────────────

function dm(id: string, members: User[]): DmChannel {
  return { id, ownerId: null, createdAt: BASE, members, lastMessage: null } as unknown as DmChannel;
}

function groupDm(id: string, name: string, owner: User, members: User[]): DmChannel {
  return { id, name, ownerId: owner.id, createdAt: BASE, members, lastMessage: null } as unknown as DmChannel;
}

function isTypingState(state: PreviewState): boolean {
  return state.startsWith('typing');
}

function channelOf(state: PreviewState): string {
  if (state === 'remote-self') return REMOTE_DM_ID;
  if (state === 'names') return NAMES_DM_ID;
  if (state === 'names-display') return NAMES_DISPLAY_DM_ID;
  if (state === 'picker-long' || state === 'picker-long-mobile') return PICKER_GROUP_ID;
  if (state === 'space-picker') return CHANNEL;
  if (isTypingState(state)) return GROUP_ID;
  return DM_ID;
}

function languageOf(state: PreviewState): 'de' | 'zh' | null {
  if (state === 'typing-de' || state === 'typing-long-de') return 'de';
  if (state === 'typing-long-zh') return 'zh';
  return null;
}

function typersOf(state: PreviewState): User[] {
  switch (state) {
    case 'typing-one': return [QUINN];
    case 'typing-two':
    case 'typing-de': return [KAI, QUINN];
    case 'typing-several': return [KAI, QUINN, MIRA];
    case 'typing-long':
    case 'typing-long-de': return [LONG_A, LONG_B];
    case 'typing-long-zh': return [ZH_A, ZH_B];
    case 'names': return [ZED_STUB];
    case 'names-display': return [IRIS_STUB];
    default: return [];
  }
}

function seedStores(state: PreviewState): void {
  const permissions = permissionsToString(ALL_PERMISSIONS);
  const typers = typersOf(state);
  // What the remote origin's `ready` records for the signed-in user.
  useAuthStore.setState({ user: ME, myRowIds: new Map([[ORBIT, ME_ON_ORBIT.id]]) });
  useUIStore.setState({ isMobile: state === 'picker-long-mobile' });

  const staleRoster = state === 'dm-picker'
    ? [member(OTHER_SPACE, ZED), member(OTHER_SPACE, OSKAR), member(OTHER_SPACE, ME)]
    : [];
  const spaceRoster = [
    member(SPACE, MIRA, [MODS]),
    member(SPACE, OSKAR),
    member(SPACE, KAI),
    member(SPACE, ME),
  ];

  useSpaceStore.setState({
    dmChannels: [
      dm(DM_ID, [ME, KAI]),
      groupDm(GROUP_ID, 'Release crew', ME, [ME, KAI, QUINN, MIRA, LONG_A, LONG_B, ZH_A, ZH_B]),
      dm(REMOTE_DM_ID, [ME_ON_ORBIT, KAI_ON_ORBIT]),
      dm(NAMES_DM_ID, [ME, ZED_STUB]),
      dm(NAMES_DISPLAY_DM_ID, [ME, IRIS_STUB]),
      groupDm(PICKER_GROUP_ID, 'Naming things', ME, [ME, LONG_STUB, QUINN, ZED_STUB, NIKA, KAI]),
    ],
    channelOriginMap: new Map([
      [DM_ID, ''], [GROUP_ID, ''], [REMOTE_DM_ID, ORBIT], [CHANNEL, ''], [NAMES_DM_ID, ''], [NAMES_DISPLAY_DM_ID, ''], [PICKER_GROUP_ID, ''],
    ]),
    spaceChannelIndex: new Map([[CHANNEL, { spaceId: SPACE, origin: '', type: 'text' as const }]]),
    channelToSpaceMap: new Map([[CHANNEL, SPACE]]),
    channelPermissions: new Map([[CHANNEL, permissions]]),
    spaces: state === 'space-picker'
      ? [{ id: SPACE, name: 'Workbench', ownerId: OSKAR.id, _instanceOrigin: '' } as unknown as TaggedSpace]
      : [],
    members: state === 'space-picker' ? spaceRoster : staleRoster,
    currentSpaceId: state === 'space-picker' ? SPACE : null,
  });

  const channelId = channelOf(state);
  const messages = state === 'remote-self'
    ? remoteConversation()
    : state === 'space-picker'
      ? spaceConversation()
      : state === 'names'
        ? namesConversation(NAMES_DM_ID, ZED_STUB)
        : state === 'names-display'
          ? namesConversation(NAMES_DISPLAY_DM_ID, IRIS_STUB)
        : state === 'picker-long' || state === 'picker-long-mobile'
          ? []
          : isTypingState(state) ? groupConversation() : dmConversation();
  const typingUntil = Date.now() + 60_000;
  useChatStore.setState({
    messages: new Map([[channelId, messages]]),
    hasMore: new Map([[channelId, false]]),
    typingUsers: new Map([[channelId, typers.map((u) => ({
      userId: u.id,
      // The wire carries the username; the stub's is the id shape.
      username: u.username,
      timestamp: typingUntil,
    }))]]),
  });
}

// ─── Driving ────────────────────────────────────────────────────────────────

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitFor<T>(find: () => T | null | undefined, what: string): Promise<T> {
  for (let i = 0; i < 300; i++) {
    const found = find();
    if (found) return found;
    await nextFrame();
  }
  throw new Error(what);
}

/** Types into the composer the way a keyboard does, so React sees a change. */
async function typeInComposer(text: string): Promise<void> {
  const textarea = await waitFor(() => document.querySelector('textarea'), 'no composer');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('no value setter');
  textarea.focus();
  setValue.call(textarea, text);
  textarea.setSelectionRange(text.length, text.length);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

async function drive(state: PreviewState): Promise<void> {
  if (state !== 'dm-picker' && state !== 'space-picker' && state !== 'picker-long' && state !== 'picker-long-mobile') return;
  await new Promise((resolve) => setTimeout(resolve, 300));
  await typeInComposer('@');
}

// ─── Frame ──────────────────────────────────────────────────────────────────

/**
 * `initializeInterfaceScale` sets `data-viewport` from the window width on
 * every resize, and a 760px window reads as a phone. The chat column is the
 * desktop one, so pin it after that listener.
 */
function pinDesktopViewport(): void {
  const pin = () => { document.documentElement.dataset.viewport = 'desktop'; };
  window.addEventListener('resize', pin);
  pin();
}

function composerName(channelId: string): string {
  if (channelId === CHANNEL) return 'release';
  if (channelId === GROUP_ID) return '@Release crew';
  if (channelId === NAMES_DM_ID) return '@zed';
  if (channelId === NAMES_DISPLAY_DM_ID) return '@Iris';
  if (channelId === PICKER_GROUP_ID) return '@Naming things';
  return '@Kai';
}

/** The DM list column, beside the chat in the `names` state. */
const LIST_WIDTH = 240;

/** Both `names` DMs, the open one active: the list names each person as the chat does. */
function DmListColumn({ channelId }: { channelId: string }) {
  const entries = useSpaceStore.getState().dmChannels.filter((d) => d.id === NAMES_DM_ID || d.id === NAMES_DISPLAY_DM_ID);
  const noop = () => {};
  return (
    <div className="flex flex-col gap-0.5 px-2 py-3 bg-surface-channel border-r border-border-hard shrink-0" style={{ width: LIST_WIDTH }}>
      {entries.map((entry) => (
        <DmListItem key={entry.id} dm={entry} isActive={entry.id === channelId} isUnread={false} user={ME} onSelect={noop} onClose={noop} onLeave={noop} />
      ))}
    </div>
  );
}

function Frame({ channelId, withList, width }: { channelId: string; withList: boolean; width: number }) {
  return (
    <div className="flex" style={{ height: 'calc(100 * var(--app-vh))' }}>
      {withList && <DmListColumn channelId={channelId} />}
      <div className="flex flex-col bg-surface-chat relative" style={{ width }}>
        <MessageList channelId={channelId} />
        <MessageInput channelId={channelId} channelName={composerName(channelId)} />
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const state = readState(window.location.search);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  if (state !== 'picker-long-mobile') pinDesktopViewport();
  await initI18n();
  const language = languageOf(state);
  if (language) await setLanguage(language);
  seedStores(state);
  createRoot(host).render(
    <MemoryRouter>
      <Frame
        channelId={channelOf(state)}
        withList={state === 'names' || state === 'names-display'}
        width={state === 'picker-long-mobile' ? PHONE_WIDTH : FRAME_WIDTH}
      />
    </MemoryRouter>,
  );
  await drive(state);
}

void start();
