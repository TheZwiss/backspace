// Dev-only workbench for the message list's anchoring states: where a channel
// opens, the unread divider, the load-failure overlay, and the list against a
// grown composer. Nothing in the app imports this file; `dev-message-list.html`
// is its only entry.
//
// `?state=<name>` renders the real `MessageList` and `MessageInput` in a chat
// column shaped like MainContent's (header, list, floating composer):
//   unread            opened with nineteen unread messages: the first unread
//                     row sits below the top with the divider above it.
//   unread-new-day    the first unread message is also the first of a new
//                     day: the date divider and the unread divider meet.
//   composer-grown    at the bottom with a five-line draft: the newest message
//                     sits above the composer.
//   load-failed       the newest page cannot be fetched: the failure overlay.
// `&w=<px>` sets the column width (default 760); use the phone width for the
// mobile shots.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MessageWithUser, User } from '@backspace/shared';
import { MessageList } from '../components/chat/MessageList';
import { MessageInput } from '../components/chat/MessageInput';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useSpaceStore } from '../stores/spaceStore';
import { useUIStore } from '../stores/uiStore';
import { initializeInterfaceScale, isMobileViewport } from '../platform/interfaceScale';
import { initI18n } from '../i18n';
import { ALL_PERMISSIONS, permissionsToString } from '../utils/permissions';
import '../styles/globals.css';

const STATES = {
  unread: 'Opened at the first of nineteen unread messages, divider above it.',
  'unread-new-day': 'The first unread message starts a new day.',
  'composer-grown': 'At the bottom with a five-line draft in the composer.',
  'load-failed': 'The newest page cannot be fetched.',
} as const;
type ListState = keyof typeof STATES;

const CHANNEL = 'workbench-channel';
const SPACE = 'workbench-space';

function readState(search: string): ListState {
  const value = new URLSearchParams(search).get('state');
  return value !== null && value in STATES ? (value as ListState) : 'unread';
}

function readWidth(search: string): number {
  const value = Number(new URLSearchParams(search).get('w'));
  return Number.isFinite(value) && value > 0 ? value : 760;
}

function person(id: string, username: string, displayName: string, avatarColor: string): User {
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
const MIRA = person('mira', 'mira', 'Mira', 'mint');
const OSKAR = person('oskar', 'oskar', 'Oskar', 'peach');
const TOVE = person('tove', 'tove', 'Tove', 'sky');

const LINES: Array<[User, string]> = [
  [MIRA, 'Morning. Did the nightly backup on orbit finish?'],
  [OSKAR, 'It did, 2.1 GB, restore test passed.'],
  [TOVE, 'Good. I am looking at the upload janitor next.'],
  [ME, 'The grace period question from last week?'],
  [TOVE, 'That one. A slow phone upload should not lose its file.'],
  [MIRA, 'Twelve hours felt safe to me.'],
  [OSKAR, 'Twelve hours is fine as long as the staging disk has room.'],
  [ME, 'It has 38 GB since Friday.'],
  [TOVE, 'Then twelve hours it is. I will open the PR tonight.'],
  [MIRA, 'Separate thing: the German catalog review is done.'],
  [OSKAR, 'Nice, that was the last blocker for the release notes.'],
  [ME, 'I will write the notes after lunch.'],
  [MIRA, 'Who is testing the desktop build on Windows?'],
  [TOVE, 'Me, tonight.'],
  [OSKAR, 'I can take Linux, both the AppImage and the Flatpak.'],
  [MIRA, 'Then I will do macOS tomorrow morning.'],
  [OSKAR, 'The Flatpak build finished. Installs and updates cleanly.'],
  [TOVE, 'Windows installer works, auto-update too.'],
  [MIRA, 'macOS is fine on both chips.'],
  [OSKAR, 'One small thing: the tray icon is blurry on a 1.25 scale on Linux.'],
  [TOVE, 'Known, it is in the icon issue already.'],
  [MIRA, 'Then I think we are ready to tag.'],
  [ME, 'Agreed. Tagging after the notes are merged.'],
  [OSKAR, 'The notes PR is up, two approvals needed.'],
  [TOVE, 'Approved.'],
  [MIRA, 'Approved as well.'],
];

function conversation(state: ListState): MessageWithUser[] {
  const day = 24 * 60 * 60_000;
  const base = new Date(2026, 8, 28, 9, 0).getTime();
  return LINES.map(([author, content], i) => {
    // For the new-day state, the unread part starts the next morning.
    const createdAt = state === 'unread-new-day' && i >= 18 ? base + day + (i - 18) * 3 * 60_000 : base + i * 7 * 60_000;
    return {
      id: String(5000 + i),
      channelId: CHANNEL,
      userId: author.id,
      replyToId: null,
      replyTo: null,
      content,
      editedAt: null,
      createdAt,
      user: author,
      attachments: [],
      embeds: [],
      reactions: [],
    };
  });
}

function seedStores(state: ListState): void {
  // The app sets this from the viewport in its shell; the composer reads it.
  useUIStore.setState({ isMobile: isMobileViewport() });
  useAuthStore.setState({ user: ME });
  useSpaceStore.setState({
    channelOriginMap: new Map([[CHANNEL, '']]),
    channelToSpaceMap: new Map([[CHANNEL, SPACE]]),
    channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)]]),
    dmChannels: [],
    members: [MIRA, OSKAR, TOVE, ME].map((user) => ({ spaceId: SPACE, userId: user.id, nickname: null, joinedAt: 1, user, roles: [] })),
    spaces: [],
    currentSpaceId: SPACE,
  });
  if (state === 'load-failed') {
    // Every request fails at the network, as with the instance unreachable.
    window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    useChatStore.setState({ messages: new Map(), hasMore: new Map(), readStates: new Map() });
    return;
  }
  const messages = conversation(state);
  const readUpTo = messages[state === 'unread' ? 6 : 17]!.id;
  useChatStore.setState({
    messages: new Map([[CHANNEL, messages]]),
    hasMore: new Map([[CHANNEL, false]]),
    readStates: new Map(state === 'composer-grown' ? [] : [[CHANNEL, readUpTo]]),
  });
}

const DRAFT = [
  'Release checklist for tonight:',
  '1. merge the notes PR',
  '2. tag 1.8.0 on main once CI is green',
  '3. watch the image build',
  '4. post in #announcements',
].join('\n');

/**
 * Types the draft the way a person does, after the list has settled at the
 * bottom: the composer grows line by line through its own input handler,
 * which is the path issue #361 was about.
 */
async function typeDraft(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea');
  if (!textarea) throw new Error('no composer textarea');
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('no textarea value setter');
  for (let end = 1; end <= DRAFT.length; end += 6) {
    setValue.call(textarea, DRAFT.slice(0, end));
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  }
  setValue.call(textarea, DRAFT);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

function Column({ width }: { width: number }) {
  return (
    <div className="flex h-full justify-center bg-surface-base">
      <div className="flex-1 flex flex-col bg-surface-chat min-w-0 relative" style={{ maxWidth: width, height: 'calc(100 * var(--app-vh))' }}>
        <div className="h-12 px-5 flex items-center border-b border-border-hard flex-shrink-0 z-10 bg-surface-chat">
          <span className="text-[20px] font-medium text-txt-tertiary leading-none mr-[10px]">#</span>
          <span className="font-bold text-[15px] tracking-[-0.02em] text-txt-primary">release</span>
        </div>
        <MessageList channelId={CHANNEL} />
        <MessageInput channelId={CHANNEL} channelName="release" />
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const state = readState(window.location.search);
  const width = readWidth(window.location.search);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  // The app shell never scrolls the document; the composer's autofocus would
  // otherwise scroll it on a phone-sized viewport.
  const shell = document.createElement('style');
  shell.textContent = 'html, body { height: 100%; overflow: hidden; }';
  document.head.appendChild(shell);
  await initI18n();
  seedStores(state);
  createRoot(host).render(
    <MemoryRouter>
      <Column width={width} />
    </MemoryRouter>,
  );
  if (state === 'composer-grown') await typeDraft();
}

void start();
