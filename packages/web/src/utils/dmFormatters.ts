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
 * Format a DM lastMessage into a sidebar preview string.
 * Returns null if there is nothing displayable.
 *
 * Handles:
 *  - Text only → returns text content
 *  - Attachment only (single) → "📷 Image", "🎬 Video", "🎵 Audio", "📎 filename.ext"
 *  - Attachment only (multiple) → "📎 N files"
 *  - Text + attachments → "text 📷" (appends unified icon)
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
