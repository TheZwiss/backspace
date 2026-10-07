// Dev-only workbench for message rows in a real message list: the reply
// preview and its jump, and the reaction pills and their who-reacted
// tooltip. Nothing in the app imports this file; `dev-chat-rows.html` is its
// only entry.
//
// `?state=<name>` renders the real `MessageList` for a seeded channel in a
// 760px chat column. The states (the `STATES` table below says the same on
// screen):
//   reply-rest      the conversation at the bottom, reply previews at rest.
//   reply-hover     the newest reply preview in its hover state; its
//                   original mentions a member, shown as a plain badge.
//   reply-focus     the newest reply preview with the keyboard focus ring.
//   jump-landed     the newest reply preview clicked: the list has scrolled
//                   to the original, which carries the jump flash, frozen
//                   300 ms into its 2 s fade.
//   jump-keyboard   the same jump from the keyboard: the original holds the
//                   focus and shows the focus-visible ring.
//   present-failed  a detached window, Jump to Present clicked while the
//                   newest page cannot be loaded: the list stays, a toast says so.
//   reactions-rest  a release thread with reaction pills, no tooltip.
//   reaction-*      one pill hovered, its tooltip open: `you` (only you),
//                   `two`, `three` (three others, one of them remote),
//                   `twelve`, `long-names`, `remote` (a remote stub named
//                   through the userViews cache), `focus` (keyboard focus
//                   instead of hover), `escaped` (opened by hover, then
//                   Escape pressed with the pointer still on the pill).
//
// Hover and focus-visible cannot be produced by a headless screenshot, so the
// harness copies every `:hover` / `:focus-visible` rule in the loaded
// stylesheets to a `.wb-hover` / `.wb-focus` class and puts that class on the
// element. The styles are the component's own; only the trigger is replaced.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { MessageWithUser, Reaction, User } from '@backspace/shared';
import { MessageList } from '../components/chat/MessageList';
import { ToastContainer } from '../components/ui/ToastContainer';
import { useAuthStore } from '../stores/authStore';
import { useChatStore } from '../stores/chatStore';
import { useSpaceStore } from '../stores/spaceStore';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import { ALL_PERMISSIONS, permissionsToString } from '../utils/permissions';
import { canonicalUserKey } from '../utils/identity';
import '../styles/globals.css';

const STATES = {
  'reply-rest': 'Conversation at the bottom, reply previews at rest.',
  'reply-hover': 'The newest reply preview in its hover state.',
  'reply-focus': 'The newest reply preview with the keyboard focus ring.',
  'jump-landed': 'Reply preview clicked: scrolled to the original, flash frozen 300 ms in.',
  'jump-keyboard': 'Reply preview activated from the keyboard: the original holds the focus.',
  'present-failed': 'Jump to Present clicked while the newest page cannot load.',
  'reactions-rest': 'A release thread with reaction pills, no tooltip.',
  'reaction-you': 'Tooltip: only you reacted.',
  'reaction-two': 'Tooltip: you and one other.',
  'reaction-three': 'Tooltip: three others, one remote.',
  'reaction-twelve': 'Tooltip: twelve reactors, you among them.',
  'reaction-long-names': 'Tooltip: two very long display names.',
  'reaction-remote': 'Tooltip: a remote stub named through the userViews cache.',
  'reaction-focus': 'Tooltip opened by keyboard focus, with the focus ring.',
  'reaction-escaped': 'Tooltip opened by hover, then closed with Escape.',
} as const;
type RowState = keyof typeof STATES;

/** The pill each tooltip state opens: the message row and the emoji. */
const TOOLTIP_TARGETS: Partial<Record<RowState, { row: number; emoji: string; via: 'hover' | 'focus' }>> = {
  'reaction-you': { row: 20, emoji: '🚀', via: 'hover' },
  'reaction-two': { row: 20, emoji: '❤️', via: 'hover' },
  'reaction-three': { row: 20, emoji: '👍', via: 'hover' },
  'reaction-twelve': { row: 20, emoji: '🎉', via: 'hover' },
  'reaction-long-names': { row: 21, emoji: '🙌', via: 'hover' },
  'reaction-remote': { row: 22, emoji: '👀', via: 'hover' },
  'reaction-focus': { row: 21, emoji: '✅', via: 'focus' },
  'reaction-escaped': { row: 20, emoji: '❤️', via: 'hover' },
};

const CHANNEL = 'workbench-channel';
const SPACE = 'workbench-space';
const FRAME_WIDTH = 760;

function readState(search: string): RowState {
  const value = new URLSearchParams(search).get('state');
  return value !== null && value in STATES ? (value as RowState) : 'reply-rest';
}

// ─── People ─────────────────────────────────────────────────────────────────

function person(id: string, username: string, displayName: string | null, avatarColor: string, homeInstance: string | null = null): User {
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
    homeInstance,
    homeUserId: homeInstance ? `${id}-home` : null,
    replicatedInstances: [],
  } as User;
}

const ME = person('me', 'jannis', 'Jannis', 'lavender');
const MIRA = person('mira', 'mira', 'Mira', 'mint');
const OSKAR = person('oskar', 'oskar', 'Oskar', 'peach');
const TOVE = person('tove', 'tove@orbit.example', 'Tove', 'sky', 'orbit.example');
// A remote user as the channel's origin knows them: a stub with no display
// name. Their home instance's view (seeded into userViews) has one.
const ALEKSANDR_STUB = person('aleksandr-local', 'aleksandr@nova.example', null, 'amber', 'nova.example');
const ALEKSANDR_HOME = { ...ALEKSANDR_STUB, displayName: 'Aleksandr Kuznetsov' };
const LONG_A = person('long-a', 'maximiliane', 'Maximiliane von Hohenzollern-Sigmaringen', 'rose');
const LONG_B = person('long-b', 'bartholomew', 'Bartholomew Featherstonehaugh-Whittingstall the Third', 'coral');
const CROWD = ['Ines', 'Jonas', 'Priya', 'Lukas', 'Hana', 'Emil', 'Sofia', 'Noah', 'Yuki']
  .map((name, i) => person(`crowd-${i}`, name.toLowerCase(), name, ['mint', 'peach', 'sky', 'lavender'][i % 4]!));

// ─── Conversation ───────────────────────────────────────────────────────────

const BASE = new Date(2026, 8, 27, 9, 12).getTime();

function row(n: number, author: User, content: string, replyTo?: MessageWithUser): MessageWithUser {
  return {
    id: String(1000 + n),
    channelId: CHANNEL,
    userId: author.id,
    replyToId: replyTo?.id ?? null,
    replyTo: replyTo ?? null,
    content,
    editedAt: null,
    createdAt: BASE + n * 4 * 60_000,
    user: author,
    attachments: [],
    embeds: [],
    reactions: [],
  };
}

function conversation(): MessageWithUser[] {
  const question = row(0, MIRA, 'Before we tag 1.6: <@oskar> is the migration for the reply index in, or does it wait for the next release?');
  const filler: MessageWithUser[] = [
    row(1, OSKAR, 'I think it is in, the PR merged on Thursday.'),
    row(2, TOVE, 'It is, I ran it against a copy of the orbit database last night. Took about four seconds.'),
    row(3, MIRA, 'Good. Then the only open item is the changelog.'),
    row(4, ME, 'I will write it this afternoon.'),
    row(5, OSKAR, 'Unrelated: the staging box is out of disk again.'),
    row(6, TOVE, 'That is the upload janitor. It skips files that are still referenced by a pending message.'),
    row(7, OSKAR, 'Can we lower the grace period?'),
    row(8, TOVE, 'We can, but then a slow upload on a phone gets its file swept before the message lands.'),
    row(9, MIRA, 'Leave it. I will clear the box by hand for now.'),
    row(10, OSKAR, 'Done, 38 GB free.'),
    row(11, ME, 'Thanks. Back to the release: who is testing the desktop build on Windows?'),
    row(12, TOVE, 'Me, tonight.'),
    row(13, OSKAR, 'I can take Linux.'),
    row(14, MIRA, 'Then I will do macOS tomorrow morning.'),
  ];
  const oskarReply = row(15, OSKAR, 'Sounds right to me.', filler[3]);
  const tail = [
    row(16, TOVE, 'One more thing for the notes: the German catalog got a pass from a native speaker.'),
    row(17, ME, 'Yes, it is in, and the rollback is a single down migration if we need it.', question),
  ];
  return [question, ...filler, oskarReply, ...tail];
}

function reactionsBy(n: number, emoji: string, people: User[]): Reaction[] {
  return people.map((p, i) => ({
    id: `r-${n}-${emoji}-${p.id}`,
    messageId: String(1000 + n),
    userId: p.id,
    emoji,
    createdAt: BASE + n * 4 * 60_000 + (i + 1) * 1_000,
    user: p,
  }));
}

function reactionConversation(): MessageWithUser[] {
  const lead = conversation().slice(12, 17);
  const release = row(20, MIRA, 'Tagged 1.6.0. The release notes are up on the project page.');
  release.reactions = [
    ...reactionsBy(20, '🎉', [OSKAR, ME, TOVE, ...CROWD]),
    ...reactionsBy(20, '❤️', [ME, OSKAR]),
    ...reactionsBy(20, '👍', [OSKAR, TOVE, ALEKSANDR_STUB]),
    ...reactionsBy(20, '🚀', [ME]),
  ];
  const windows = row(21, TOVE, 'Windows installer and the auto-update both work here.');
  windows.reactions = [
    ...reactionsBy(21, '✅', [OSKAR]),
    ...reactionsBy(21, '🙌', [LONG_A, LONG_B]),
  ];
  const linux = row(22, OSKAR, 'Linux AppImage too. The Flatpak build is still running.');
  linux.reactions = reactionsBy(22, '👀', [ALEKSANDR_STUB]);
  return [...lead, release, windows, linux];
}

// ─── Stores ─────────────────────────────────────────────────────────────────

function isReactionState(state: RowState): boolean {
  return state.startsWith('reaction');
}

function seedStores(state: RowState): void {
  useAuthStore.setState({ user: ME });
  useSpaceStore.setState({
    channelOriginMap: new Map([[CHANNEL, '']]),
    spaceChannelIndex: new Map([[CHANNEL, { spaceId: SPACE, origin: '', type: 'text' as const }]]),
    channelToSpaceMap: new Map([[CHANNEL, SPACE]]),
    channelPermissions: new Map([[CHANNEL, permissionsToString(ALL_PERMISSIONS)]]),
    dmChannels: [],
    members: [MIRA, OSKAR, TOVE, ME].map((user) => ({ spaceId: SPACE, userId: user.id, nickname: null, joinedAt: 1, user, roles: [] })),
    spaces: [],
    currentSpaceId: SPACE,
    userViews: new Map([[canonicalUserKey(ALEKSANDR_STUB), {
      user: ALEKSANDR_HOME,
      deliveredBy: 'https://nova.example',
      isHome: true,
      updatedAt: BASE,
    }]]),
  });
  useChatStore.setState({
    messages: new Map([[CHANNEL, isReactionState(state) ? reactionConversation() : conversation()]]),
    hasMore: new Map([[CHANNEL, false]]),
    // present-failed starts in a window loaded by an earlier jump.
    detachedChannels: new Map(state === 'present-failed' ? [[CHANNEL, []]] : []),
  });
}

// ─── Forced pseudo-classes ──────────────────────────────────────────────────

/** Copies every `:hover` / `:focus-visible` rule to `.wb-hover` / `.wb-focus`. */
function mirrorPseudoClassRules(): void {
  const extra: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const selector = rule.selectorText;
      if (!selector.includes(':hover') && !selector.includes(':focus-visible')) continue;
      const mirrored = selector.replace(/:hover/g, '.wb-hover').replace(/:focus-visible/g, '.wb-focus');
      extra.push(`${mirrored} { ${rule.style.cssText} }`);
    }
  }
  const style = document.createElement('style');
  style.textContent = extra.join('\n');
  document.head.appendChild(style);
}

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

function newestReplyPreview(): Promise<HTMLButtonElement> {
  return waitFor(
    () => {
      const previews = document.querySelectorAll<HTMLButtonElement>('[id^="msg-"] button.group\\/reply');
      return previews[previews.length - 1];
    },
    'no reply preview in the list',
  );
}

function reactionPill(row: number, emoji: string): Promise<HTMLButtonElement> {
  return waitFor(
    () => Array.from(document.querySelectorAll<HTMLButtonElement>(`[id="msg-${1000 + row}"] button[aria-pressed]`))
      .find((b) => b.textContent?.startsWith(emoji)),
    `no ${emoji} pill on row ${row}`,
  );
}

/** Opens a pill's tooltip the way a pointer or the keyboard would. */
async function openTooltip(target: { row: number; emoji: string; via: 'hover' | 'focus' }): Promise<void> {
  const pill = await reactionPill(target.row, target.emoji);
  mirrorPseudoClassRules();
  // The tooltip fades in over 150 ms; a headless screenshot can land inside
  // that, so show its settled state.
  const settle = document.createElement('style');
  settle.textContent = '[role="tooltip"].animate-fade-in { animation: none !important; }';
  document.head.appendChild(settle);
  if (target.via === 'focus') {
    pill.classList.add('wb-focus');
    pill.focus();
    return;
  }
  pill.classList.add('wb-hover');
  // React's onMouseEnter is built from mouseover with the pointer's previous target.
  pill.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
}

async function drive(state: RowState): Promise<void> {
  if (state === 'reply-rest' || state === 'reactions-rest') return;
  // Let the list's initial snap to the bottom run first, as it has long
  // before a person points at anything.
  await new Promise((resolve) => setTimeout(resolve, 300));
  const tooltipTarget = TOOLTIP_TARGETS[state];
  if (tooltipTarget) {
    await openTooltip(tooltipTarget);
    if (state === 'reaction-escaped') {
      await waitFor(() => document.querySelector('[role="tooltip"]'), 'the tooltip did not open');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }
    return;
  }
  if (state === 'present-failed') {
    // The newest page cannot be fetched: every request fails at the network.
    window.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const jumpToPresent = await waitFor(
      () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Jump to Present'),
      'no Jump to Present button',
    );
    const toastSettle = document.createElement('style');
    toastSettle.textContent = '* { animation: none !important; }';
    document.head.appendChild(toastSettle);
    jumpToPresent.click();
    return;
  }
  const preview = await newestReplyPreview();
  if (state === 'reply-hover') {
    mirrorPseudoClassRules();
    preview.classList.add('wb-hover');
    return;
  }
  if (state === 'reply-focus') {
    mirrorPseudoClassRules();
    preview.classList.add('wb-focus');
    return;
  }
  // jump-landed: a headless screenshot does not advance a smooth scroll, so
  // land it instantly (same target, no animation), and freeze the flash early
  // in its fade so the screenshot shows it.
  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function scrollIntoViewInstantly(this: Element, arg?: boolean | ScrollIntoViewOptions) {
    nativeScrollIntoView.call(this, typeof arg === 'object' ? { ...arg, behavior: 'instant' } : arg);
  };
  const freeze = document.createElement('style');
  freeze.textContent = '.message-jump-highlight { animation-delay: -300ms !important; animation-play-state: paused !important; }';
  document.head.appendChild(freeze);
  preview.click();
  if (state === 'jump-landed') {
    // A synthetic click has no pointer behind it, so Chrome treats the focus
    // the jump moves as keyboard focus and draws the ring. A real mouse click
    // leaves the row focused without :focus-visible; show that.
    const pointerFocus = document.createElement('style');
    pointerFocus.textContent = '[id^="msg-"]:focus-visible { --tw-ring-shadow: 0 0 #0000 !important; box-shadow: none !important; }';
    document.head.appendChild(pointerFocus);
  }
  if (state === 'jump-keyboard') {
    // The row the jump focused shows the ring a keyboard user gets.
    const focused = await waitFor(
      () => (document.activeElement?.id.startsWith('msg-') ? document.activeElement : null),
      'the jump did not move the focus to the original',
    );
    mirrorPseudoClassRules();
    focused.classList.add('wb-focus');
  }
}

// ─── Frame ──────────────────────────────────────────────────────────────────

function Frame() {
  return (
    <div
      className="flex flex-col bg-surface-chat"
      style={{ width: FRAME_WIDTH, height: 'calc(100 * var(--app-vh))', ['--composer-clearance' as string]: '20px' }}
    >
      <MessageList channelId={CHANNEL} />
      <ToastContainer />
    </div>
  );
}

async function start(): Promise<void> {
  const state = readState(window.location.search);
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  await initI18n();
  seedStores(state);
  createRoot(host).render(
    <MemoryRouter>
      <Frame />
    </MemoryRouter>,
  );
  await drive(state);
}

void start();
