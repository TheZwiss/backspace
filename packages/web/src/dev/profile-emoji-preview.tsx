// Dev-only workbench for emoji in profile text (issue #252). Nothing in the app
// imports this file; `dev-profile-emoji.html` is its only entry. It renders
// the real profile surfaces with profile text that mixes Unicode emoji (ZWJ
// sequences, skin tones, flags) and `:shortcode:` text, so both can be looked
// at and screenshotted without a server.
//
// `?view=<view>&profile=<profile>` picks what to render; `?lang=ru|zh` (the
// development language preview) switches the UI language and with it the
// `:lang()` font stack.
//
// Views:
//   popout   the profile card (`UserProfilePopout`), anchored top left.
//   modal    the full profile (`UserProfileModal`), opened through uiStore.
//   rows     member-list rows (`ActivityCard` with the custom status, as
//            MemberSidebar renders it) and the bio sent as a chat message
//            (`MarkdownRenderer`), for comparison with chat.
//
// Profiles:
//   reporter the bio from the issue's screenshot, typed with shortcodes.
//   mixed    Unicode emoji of every hard kind plus shortcodes, inline code
//            that must stay literal, clock times that must not be touched,
//            and a bio at the 190-character server limit.
//   spaced   a bio with single newlines and a run of blank lines, for the
//            newline rule: a newline breaks the line, any number of blank
//            lines is one empty line, the same as in a chat message.
//
// The mutuals request fails without a server; both components already treat
// that as "no mutuals", which is what a stranger's profile shows.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { User } from '@backspace/shared';
import { UserProfilePopout } from '../components/ui/UserProfilePopout';
import { UserProfileModal } from '../components/modals/UserProfileModal';
import { ActivityCard } from '../components/ui/ActivityCard';
import { Avatar } from '../components/ui/Avatar';
import { MarkdownRenderer } from '../components/chat/MarkdownRenderer';
import { useAuthStore } from '../stores/authStore';
import { useUIStore } from '../stores/uiStore';
import { initI18n } from '../i18n';
import { loadDiscordEmojiAliases } from '../utils/emojiShortcodes';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

type View = 'popout' | 'modal' | 'rows';
type ProfileName = 'reporter' | 'mixed' | 'spaced';

function readView(search: string): View {
  const value = new URLSearchParams(search).get('view');
  return value === 'modal' || value === 'rows' ? value : 'popout';
}

function readProfile(search: string): ProfileName {
  const value = new URLSearchParams(search).get('profile');
  return value === 'mixed' || value === 'spaced' ? value : 'reporter';
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const BASE_USER: User = {
  id: 'profile-user',
  username: 'james',
  displayName: null,
  avatar: null,
  banner: null,
  accentColor: null,
  avatarColor: 'sky',
  bio: null,
  status: 'online',
  customStatus: null,
  isAdmin: false,
  createdAt: Date.UTC(2026, 8, 23),
  homeInstance: null,
  homeUserId: null,
  replicatedInstances: [],
};

const PROFILES: Record<ProfileName, User> = {
  reporter: {
    ...BASE_USER,
    displayName: 'James 💙✝',
    customStatus: 'praying :pray: :cross:',
    bio: '𝕮𝖍𝖗𝖎𝖘𝖙𝖚𝖘 𝖆𝖊𝖙𝖊𝖗𝖓𝖚𝖘 𝖊𝖘𝖙.:cross: :heart_on_fire:\n\n-Catholic :cross: :flag_va: :orthodox_cross:\n\n-Tejano\n\n-17',
  },
  mixed: {
    ...BASE_USER,
    id: 'profile-mixed',
    username: 'mara',
    displayName: 'Mara 👩🏽‍💻🇳🇴',
    avatarColor: 'mint',
    customStatus: 'on call :pager: until 18:00 🏳️‍🌈',
    bio: 'Ops at a tiny ISP :satellite_antenna: 👨‍👩‍👧‍👦 🏴‍☠️ 🇩🇪🇯🇵\n**Ask me about** BGP :sparkles: or the `:smile:` syntax.\nStandup 09:30:00, :+1::skin-tone-4: :flag-no: :woman-running: :heart_on_fire:',
  },
  spaced: {
    ...BASE_USER,
    id: 'profile-spaced',
    username: 'lena',
    displayName: 'Lena',
    avatarColor: 'coral',
    customStatus: 'moving flats :package:',
    bio: 'Line one\nline two, same paragraph :sparkles:\n\n\n\n\nAfter four blank lines\n\nAfter one blank line\nand a last line',
  },
};

const VIEWER: User = { ...BASE_USER, id: 'viewer', username: 'viewer', displayName: 'Viewer' };

// ─── Views ──────────────────────────────────────────────────────────────────

function Rows({ user }: { user: User }) {
  const displayName = user.displayName ?? user.username;
  return (
    <div className="flex gap-6 p-4">
      <div className="w-[240px] bg-surface-channel rounded-lg p-2">
        <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-[4px]">
          <Avatar src={null} name={displayName} size={32} status="online" user={user} />
          <div className="flex-1 min-w-0">
            <span className="text-[13.5px] leading-[1.2] font-medium truncate text-txt-primary">{displayName}</span>
            <ActivityCard activities={[]} fallbackCustomStatus={user.customStatus} />
          </div>
        </div>
      </div>
      <div className="w-[520px] bg-surface-chat rounded-lg p-4">
        <div className="text-[13px] text-txt-tertiary mb-1">{displayName}</div>
        {/* The message body's own classes, from Message.tsx. */}
        <div className="text-txt-message text-[15px] leading-[1.5] break-words whitespace-pre-wrap">
          <MarkdownRenderer content={user.bio ?? ''} />
        </div>
      </div>
    </div>
  );
}

function Workbench({ view, user }: { view: View; user: User }) {
  if (view === 'modal') return <UserProfileModal />;
  if (view === 'rows') return <Rows user={user} />;
  return (
    <UserProfilePopout
      user={user}
      onClose={() => undefined}
      anchor={{ top: 16, left: 8, right: 8, bottom: 16, width: 0, height: 0 }}
    />
  );
}

async function main(): Promise<void> {
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  // As main.tsx does: Discord's shortcode names load before the first render.
  await Promise.all([initI18n(), loadDiscordEmojiAliases()]);

  const view = readView(window.location.search);
  const user = PROFILES[readProfile(window.location.search)];
  useAuthStore.setState({ user: VIEWER });
  if (view === 'modal') {
    useUIStore.getState().openModal('userProfile', { userId: user.id, user, origin: '' });
  }

  createRoot(host).render(
    <MemoryRouter>
      <Workbench view={view} user={user} />
    </MemoryRouter>,
  );
}

void main();
