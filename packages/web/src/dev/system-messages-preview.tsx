// Dev-only workbench for DM system message rows (`SystemMessage`) next to
// the sidebar preview line of the same content (`formatDmSidebarPreview`).
// Nothing in the app imports this file; `dev-system-messages.html` is its
// only entry. `?lang=de` (or ru, zh) renders it in that language.
//
// Every event the timeline knows is shown, with a long display name, an actor
// found only on the message (not in the roster), and three contents this
// version does not know: an unknown event, an event with a missing field, and
// text that is not JSON. Those three must read as the generic label.
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { DmChannel, DmLastMessagePreview, MessageWithUser, User } from '@backspace/shared';
import { SystemMessage } from '../components/chat/SystemMessage';
import { formatDmSidebarPreview } from '../utils/dmFormatters';
import { initI18n } from '../i18n';
import { initializeInterfaceScale } from '../platform/interfaceScale';
import '../styles/globals.css';

function user(id: string, displayName: string | null, username: string): User {
  return {
    id, username, displayName, avatar: null, banner: null, accentColor: null, avatarColor: 'lavender',
    bio: null, status: 'online', customStatus: null, isAdmin: false, createdAt: 0,
    homeUserId: null, homeInstance: null, replicatedInstances: [],
  };
}

const heidi = user('U1', 'Heidi', 'heidi');
const outsider = user('U9', null, 'marek@orbit.example');
const roster: Pick<DmChannel, 'members'> = { members: [heidi] };

interface Row {
  label: string;
  content: string;
  author: User;
}

const LONG = 'Maximiliane von Hohenzollern-Sigmaringen';

const ROWS: Row[] = [
  { label: 'member_added', author: heidi, content: JSON.stringify({ event: 'member_added', targetUserId: 'U2', targetDisplayName: 'Bob' }) },
  { label: 'member_added, long name', author: heidi, content: JSON.stringify({ event: 'member_added', targetUserId: 'U2', targetDisplayName: LONG }) },
  { label: 'member_removed (leave)', author: heidi, content: JSON.stringify({ event: 'member_removed', targetUserId: 'U2', targetDisplayName: 'Bob', reason: 'leave' }) },
  { label: 'member_removed (kick)', author: heidi, content: JSON.stringify({ event: 'member_removed', targetUserId: 'U2', targetDisplayName: 'Bob', reason: 'kick' }) },
  { label: 'owner_changed', author: heidi, content: JSON.stringify({ event: 'owner_changed', newOwnerId: 'U3', newOwnerDisplayName: 'Mira' }) },
  { label: 'name_changed', author: heidi, content: JSON.stringify({ event: 'name_changed', oldName: null, newName: 'Weekend crew' }) },
  { label: 'name_changed (cleared)', author: heidi, content: JSON.stringify({ event: 'name_changed', oldName: 'Weekend crew', newName: null }) },
  { label: 'icon_changed', author: heidi, content: JSON.stringify({ event: 'icon_changed' }) },
  { label: 'actor only on the message', author: outsider, content: JSON.stringify({ event: 'icon_changed' }) },
  { label: 'unknown event', author: heidi, content: JSON.stringify({ event: 'call_started', note: 'must not show' }) },
  { label: 'missing field', author: heidi, content: JSON.stringify({ event: 'owner_changed', newOwnerId: 'U3' }) },
  { label: 'not JSON', author: heidi, content: 'Heidi is now the group owner' },
];

function message(row: Row, index: number): MessageWithUser {
  return {
    id: `M${index}`, channelId: 'dm-1', userId: row.author.id, user: row.author, content: row.content,
    type: 'system', createdAt: 1, editedAt: null, replyToId: null, replyTo: null,
    attachments: [], embeds: [], reactions: [], mentions: [], everyoneMentioned: false, pinnedAt: null,
  } as unknown as MessageWithUser;
}

function preview(row: Row): string | null {
  const lastMessage = { type: 'system', userId: row.author.id, content: row.content, createdAt: 1 } as DmLastMessagePreview;
  return formatDmSidebarPreview({ ownerId: 'U1', members: roster.members as User[], lastMessage }, { id: 'SELF', username: 'self' });
}

function Frame() {
  return (
    <div className="p-4 flex flex-col gap-4">
      <div className="w-[760px] max-w-full rounded-lg bg-surface-chat py-3">
        {ROWS.map((row, i) => <SystemMessage key={row.label} message={message(row, i)} dm={roster} />)}
      </div>
      <div className="w-[760px] max-w-full rounded-lg bg-surface-channel p-3 text-xs">
        <div className="text-txt-tertiary mb-2">Sidebar preview of the same rows</div>
        {ROWS.map(row => (
          <div key={row.label} className="flex gap-3 py-0.5">
            <span className="w-48 shrink-0 text-txt-tertiary">{row.label}</span>
            <span className="text-txt-secondary truncate">{preview(row)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

async function start(): Promise<void> {
  const host = document.getElementById('root');
  if (!host) throw new Error('missing #root');
  initializeInterfaceScale();
  await initI18n();
  createRoot(host).render(
    <MemoryRouter>
      <Frame />
    </MemoryRouter>,
  );
}

void start();
