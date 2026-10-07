import type { DmChannel, DmMessageWithUser, DmLastMessagePreview, User, DmSystemEvent } from '@backspace/shared';
import { parseDmSystemEvent } from '@backspace/shared/src/dmSystemEvents';
import { parseFederatedUsername, isSelf } from './identity';
import i18n from '../i18n';
import { formatters } from '../i18n/formatters';

// ─── DM Preview Formatting ────────────────────────────────────────────────────

/**
 * A loose attachment shape that covers both the ready-payload preview
 * (uses `type` + `filename`) and the full Attachment type from shared types
 * (uses `mimetype` + `originalName`). At least one of each pair must be present.
 */
interface PreviewAttachment {
  type?: string;
  mimetype?: string;
  filename?: string;
  originalName?: string;
}

interface PreviewMessage {
  content: string | null | undefined;
  attachments?: PreviewAttachment[];
}

function resolveAttachmentType(a: PreviewAttachment): string {
  return a.type ?? a.mimetype ?? '';
}

function resolveAttachmentName(a: PreviewAttachment): string {
  return a.filename ?? a.originalName ?? '';
}

function getAttachmentIcon(mimeType: string): string {
  if (mimeType.startsWith('image/')) return '📷';
  if (mimeType.startsWith('video/')) return '🎬';
  if (mimeType.startsWith('audio/')) return '🎵';
  return '📎';
}

function getAttachmentLabel(mimeType: string, name: string): string {
  const icon = getAttachmentIcon(mimeType);
  if (mimeType.startsWith('image/')) return `${icon} ${i18n.t('dm:preview.image')}`;
  if (mimeType.startsWith('video/')) return `${icon} ${i18n.t('dm:preview.video')}`;
  if (mimeType.startsWith('audio/')) return `${icon} ${i18n.t('dm:preview.audio')}`;
  return `${icon} ${name}`;
}

/**
 * Determines a single icon representing a set of attachments.
 * If all attachments share the same category icon, returns that icon.
 * If mixed, falls back to 📎.
 */
function getUnifiedAttachmentIcon(attachments: PreviewAttachment[]): string {
  const icons = new Set(attachments.map(a => getAttachmentIcon(resolveAttachmentType(a))));
  return icons.size === 1 ? [...icons][0]! : '📎';
}

/**
 * Format a DM lastMessage's user-authored content into a sidebar preview string.
 * Returns null if there is nothing displayable.
 *
 * Handles:
 *  - Text only → returns text content
 *  - Attachment only (single) → "📷 Image", "🎬 Video", "🎵 Audio", "📎 filename.ext"
 *  - Attachment only (multiple) → "📎 N files"
 *  - Text + attachments → "text 📷" (appends unified icon)
 *
 * NOTE: This helper does NOT understand system messages — for those, use
 * `formatDmSidebarPreview` which inspects `type` and routes to a system-message
 * renderer. Calling this directly on a system message would surface raw JSON.
 */
export function formatDmPreview(lastMessage: PreviewMessage | null | undefined): string | null {
  if (!lastMessage) return null;

  const { content, attachments } = lastMessage;
  const hasText = content != null && content.length > 0;
  const hasAttachments = attachments != null && attachments.length > 0;

  if (!hasText && !hasAttachments) return null;

  if (hasText && !hasAttachments) {
    return content!;
  }

  if (!hasText && hasAttachments) {
    if (attachments!.length === 1) {
      const a = attachments![0]!;
      return getAttachmentLabel(resolveAttachmentType(a), resolveAttachmentName(a));
    }
    return i18n.t('dm:preview.files', { count: attachments!.length });
  }

  // Both text and attachments present
  const icon = getUnifiedAttachmentIcon(attachments!);
  return `${content} ${icon}`;
}

// ─── System Messages ─────────────────────────────────────────────────────────

/**
 * DM system messages, read in one place for every surface that shows them:
 * the timeline row (`SystemMessage`) and the sidebar preview
 * (`formatDmSidebarPreview`). The content is parsed with the same
 * `parseDmSystemEvent` the server writes and checks it with, so content this
 * version does not know (an unknown event, a missing field, text that is not
 * JSON) is the generic label and never shown as it is. See
 * docs/systems/dm-system.md, "System messages".
 */

/**
 * `'timeline'`: the full sentence of a timeline row. `'preview'`: the shorter
 * line of a sidebar preview.
 */
export type DmSystemForm = 'timeline' | 'preview';

function resolveDisplayName(user: User | null | undefined): string {
  if (!user) return i18n.t('common:states.unknown');
  if (user.displayName) return user.displayName;
  return parseFederatedUsername(user.username ?? '').baseName || i18n.t('common:states.unknown');
}

/**
 * The user who caused a system event: the conversation's roster entry for the
 * message's author (the freshest name), else the author the message carries,
 * else null.
 */
export function dmSystemActor(
  message: { userId: string; user?: User | null },
  members: readonly User[] | null | undefined,
): User | null {
  return members?.find(m => m.id === message.userId) ?? message.user ?? null;
}

/** The display name `dmSystemText` uses for the actor. */
export function dmSystemActorName(actor: User | null | undefined): string {
  return resolveDisplayName(actor);
}

/** The glyph a timeline row shows before the text, or null for none. */
export function dmSystemIcon(event: DmSystemEvent | null): string | null {
  switch (event?.event) {
    case 'member_added': return '\u2192'; // →
    case 'member_removed': return '\u2190'; // ←
    case 'owner_changed': return '\u265B'; // ♛
    case 'name_changed': return '\u270E'; // ✎
    case 'icon_changed': return '\u{1F5BC}'; // 🖼
    default: return null;
  }
}

/** The line a system event reads as, in the selected language. */
export function dmSystemText(event: DmSystemEvent | null, actorName: string, form: DmSystemForm): string {
  const full = form === 'timeline';
  switch (event?.event) {
    case 'space_invite':
      return i18n.t('dm:system.spaceInviteNamed', { spaceName: event.snapshot.spaceName });
    case 'member_added':
      return i18n.t(full ? 'dm:system.memberAddedToGroup' : 'dm:system.memberAdded', { actor: actorName, target: event.targetDisplayName });
    case 'member_removed':
      if (event.reason === 'leave') return i18n.t('dm:system.memberLeft', { target: event.targetDisplayName });
      return i18n.t(full ? 'dm:system.memberRemovedFromGroup' : 'dm:system.memberRemoved', { actor: actorName, target: event.targetDisplayName });
    case 'owner_changed':
      return i18n.t('dm:system.ownerChanged', { newOwner: event.newOwnerDisplayName });
    case 'name_changed':
      // A null or empty name is the "cleared" state, distinct from a rename.
      if (!event.newName) return i18n.t('dm:system.nameCleared', { actor: actorName });
      return full
        ? i18n.t('dm:system.renamedTo', { actor: actorName, name: event.newName })
        : i18n.t('dm:system.renamed', { actor: actorName });
    case 'icon_changed':
      return i18n.t('dm:system.iconChanged', { actor: actorName });
    default:
      return i18n.t('dm:system.generic');
  }
}

// ─── Unified Sidebar Preview ─────────────────────────────────────────────────

type LastMessageLike = DmLastMessagePreview | DmMessageWithUser;

function isSystemMessage(m: LastMessageLike): boolean {
  return m.type === 'system';
}

/**
 * Produce the full sidebar preview line for a DM channel. Handles:
 *  - User messages → text/attachment formatting (with `Sender: ` prefix in groups
 *    when the author is not the current user)
 *  - System messages → human-readable rendering with no sender prefix (the system
 *    text already incorporates the actor where appropriate)
 *  - Empty state → null (caller decides the fallback, e.g. "N Members")
 */
export function formatDmSidebarPreview(
  dm: Pick<DmChannel, 'lastMessage' | 'ownerId' | 'members'>,
  currentUser: { id: string; username: string } | null,
): string | null {
  const lastMessage = dm.lastMessage ?? null;
  if (!lastMessage) return null;

  // The author: the roster entry, else the user a DmMessageWithUser carries
  // (e.g. a remote actor in federation bootstrap).
  const actor = dmSystemActor(
    { userId: lastMessage.userId, user: 'user' in lastMessage ? lastMessage.user : null },
    dm.members,
  );

  if (isSystemMessage(lastMessage)) {
    return dmSystemText(parseDmSystemEvent(lastMessage.content), resolveDisplayName(actor), 'preview');
  }

  const text = formatDmPreview(lastMessage);
  if (!text) return null;

  const isGroup = !!dm.ownerId;
  if (!isGroup) return text;

  // Group user messages: prefix with sender display name unless it's the current user.
  const authoredBySelf = currentUser ? isSelf({ id: lastMessage.userId, username: actor?.username ?? '', homeInstance: actor?.homeInstance ?? null }, currentUser) : false;
  if (authoredBySelf) return text;

  return i18n.t('dm:preview.withSender', { name: resolveDisplayName(actor), text });
}

// ─── DM Timestamp Formatting ─────────────────────────────────────────────────

/**
 * Smart timestamp for DM sidebar items.
 * Today → time ("4:32 PM"), Yesterday → "Yesterday",
 * This year → "Mar 31", Older → "Dec 14, 2025"
 */
export function formatDmTimestamp(createdAt: number): string {
  const now = new Date();
  const date = new Date(createdAt);

  // Build "start of today" and "start of yesterday" in local time
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday.getTime() - 86400000);

  if (date >= startOfToday) {
    // Today — show time
    return formatters.formatTime(createdAt);
  }

  if (date >= startOfYesterday) {
    // "yesterday" in the selected language
    return formatters.formatRelativeDay(createdAt, now);
  }

  // This year — "Mar 31"; previous years — "Dec 14, 2025"
  return formatters.formatShortDate(createdAt, now);
}

// ─── DM Display Names ─────────────────────────────────────────────────────────

type AuthLike = { id: string; username: string; homeInstance?: string | null } | null;

/** Other-side member resolution, identical to every other DM display path. */
function otherMembersOf(dm: DmChannel, currentUser: AuthLike): User[] {
  return dm.members.filter(m => !isSelf(m, currentUser));
}

/** Member's visible name — display name if set, else the parsed base of the username. */
function memberDisplayName(m: User): string {
  return m.displayName ?? parseFederatedUsername(m.username ?? '').baseName ?? '';
}

/**
 * Visible header name for a DM channel.
 *
 *   - 1-on-1 DM → the other member's display/base name (or the localized "Direct Message")
 *   - Group with `dm.name` set → that name verbatim
 *   - Group without a name → comma-joined member names (excluding self)
 *
 * Single source of truth: prior to this, the desktop chat header
 * (`MainContent`) and the mobile chat header (`MobileChatScreen`) silently
 * dropped `dm.name`, so a renamed group still showed the joined-names
 * fallback in those two surfaces while every other site honored it.
 */
export function formatDmHeaderName(dm: DmChannel, currentUser: AuthLike): string {
  const isGroup = !!dm.ownerId;
  const others = otherMembersOf(dm, currentUser);

  if (isGroup) {
    if (dm.name && dm.name.trim().length > 0) return dm.name;
    if (others.length === 0) return i18n.t('dm:names.group');
    return others.map(memberDisplayName).join(', ');
  }

  const partner = others[0];
  if (!partner) return i18n.t('dm:names.directMessage');
  return memberDisplayName(partner) || i18n.t('dm:names.directMessage');
}

/**
 * Placeholder label for a DM message input. Callers prepend `'Message '`.
 *
 *   - 1-on-1 DM → `'@<partner>'`
 *   - Group with `dm.name` set → `'#<name>'`
 *   - Group without a name → `'the group'`
 *
 * The unnamed-group case intentionally collapses to a generic noun: the
 * joined-names form is unreadable as a one-line placeholder once a group
 * has 4+ members ("Message #Test, Nova, erin, Nova" runs off-screen
 * and obscures the actual call-to-action).
 */
export function formatDmInputLabel(dm: DmChannel, currentUser: AuthLike): string {
  const isGroup = !!dm.ownerId;

  if (isGroup) {
    if (dm.name && dm.name.trim().length > 0) return `#${dm.name}`;
    return i18n.t('dm:names.theGroup');
  }

  const partner = otherMembersOf(dm, currentUser)[0];
  if (!partner) return `@${i18n.t('dm:names.unknownHandle')}`;
  return `@${memberDisplayName(partner) || i18n.t('dm:names.unknownHandle')}`;
}

/**
 * True when `dm` is a 1-on-1 whose only other participant(s) are tombstoned.
 * Drives the read-only composer — you cannot message a deleted user.
 */
export function isDeletedPartnerDm(dm: Pick<DmChannel, 'ownerId' | 'members'>, currentUser: AuthLike): boolean {
  if (dm.ownerId) return false; // group
  const others = dm.members.filter(m => !isSelf(m, currentUser));
  if (others.length === 0) return false;
  return others.every(m => m.isDeleted === true);
}
