import type { DmChannel, DmMessageWithUser, DmLastMessagePreview, User, SpaceInviteSystemPayload } from '@backspace/shared';
import { parseFederatedUsername, isSelf } from './identity';

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
  if (mimeType.startsWith('image/')) return '📷 Image';
  if (mimeType.startsWith('video/')) return '🎬 Video';
  if (mimeType.startsWith('audio/')) return '🎵 Audio';
  return `📎 ${name}`;
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
    return `📎 ${attachments!.length} files`;
  }

  // Both text and attachments present
  const icon = getUnifiedAttachmentIcon(attachments!);
  return `${content} ${icon}`;
}

// ─── System Message Preview Formatting ───────────────────────────────────────

interface SystemEventPayload {
  event?: unknown;
  targetUserId?: unknown;
  targetDisplayName?: unknown;
  newOwnerId?: unknown;
  newOwnerDisplayName?: unknown;
  reason?: unknown;
  // name_changed payload
  oldName?: unknown;
  newName?: unknown;
  // space_invite payload
  snapshot?: { spaceName?: unknown };
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function resolveDisplayName(user: User | null | undefined): string {
  if (!user) return 'Unknown';
  if (user.displayName) return user.displayName;
  return parseFederatedUsername(user.username ?? '').baseName || 'Unknown';
}

/**
 * Format a system DM message (member_added, member_removed, owner_changed,
 * space_invite) into a human-readable sidebar preview. Falls back to a generic
 * label for unknown event shapes so we never leak raw JSON to the sidebar.
 */
function formatSystemPreview(content: string | null, actor: User | null | undefined): string {
  let data: SystemEventPayload = {};
  if (content) {
    try { data = JSON.parse(content) as SystemEventPayload; } catch { /* malformed → generic fallback */ }
  }
  const event = asString(data.event);
  const actorName = resolveDisplayName(actor);

  switch (event) {
    case 'space_invite': {
      const spaceName = asString((data as Partial<SpaceInviteSystemPayload>).snapshot?.spaceName);
      return spaceName
        ? `📨 Sent invite to ${spaceName}`
        : '📨 Sent a space invite';
    }
    case 'member_added': {
      const target = asString(data.targetDisplayName) ?? 'someone';
      return `${actorName} added ${target}`;
    }
    case 'member_removed': {
      const target = asString(data.targetDisplayName) ?? 'someone';
      const reason = asString(data.reason);
      if (reason === 'leave') return `${target} left the group`;
      return `${actorName} removed ${target}`;
    }
    case 'owner_changed': {
      const newOwner = asString(data.newOwnerDisplayName) ?? 'A member';
      return `${newOwner} is now the group owner`;
    }
    case 'name_changed': {
      // newName === null is a meaningful "cleared" state — distinct from a
      // missing field — so we check for a non-empty string explicitly.
      return asString(data.newName)
        ? `${actorName} renamed the group`
        : `${actorName} cleared the group name`;
    }
    case 'icon_changed': {
      return `${actorName} updated the group icon`;
    }
    default:
      return 'System message';
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

  // Resolve the message author from the channel members. Falls back to the
  // user object embedded in DmMessageWithUser if the member roster doesn't
  // include them (e.g. a remote actor in federation bootstrap).
  const actor: User | null = (
    dm.members.find(m => m.id === lastMessage.userId)
    ?? ('user' in lastMessage ? lastMessage.user : null)
    ?? null
  );

  if (isSystemMessage(lastMessage)) {
    return formatSystemPreview(lastMessage.content ?? null, actor);
  }

  const text = formatDmPreview(lastMessage);
  if (!text) return null;

  const isGroup = !!dm.ownerId;
  if (!isGroup) return text;

  // Group user messages: prefix with sender display name unless it's the current user.
  const authoredBySelf = currentUser ? isSelf({ id: lastMessage.userId, username: actor?.username ?? '', homeInstance: actor?.homeInstance ?? null }, currentUser) : false;
  if (authoredBySelf) return text;

  return `${resolveDisplayName(actor)}: ${text}`;
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
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  if (date >= startOfYesterday) {
    return 'Yesterday';
  }

  if (date.getFullYear() === now.getFullYear()) {
    // This year — "Mar 31"
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // Previous year — "Dec 14, 2025"
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
