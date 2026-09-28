import { MentionBadge } from './MentionBadge';
import { replaceEmojiShortcodesInMarkdownSource } from '../../utils/emojiShortcodes';
import { splitMentionTokens } from '../../utils/mentionTokens';

interface InlineMessageTextProps {
  content: string;
  /** The channel the text was written in; its mentions resolve there (see `MentionBadge`). */
  channelId: string | null;
}

/**
 * One line of message text without Markdown, as a reply preview shows it:
 * `<@userId>` tokens outside code become non-interactive mention badges (the
 * preview itself is the jump control; the scan is the one the full message
 * uses, see utils/mentionTokens.ts), `:shortcode:` text becomes emoji
 * (not inside code, and not where a colon is escaped as `\:`), and everything
 * else is plain text.
 */
export function InlineMessageText({ content, channelId }: InlineMessageTextProps) {
  return (
    <>
      {splitMentionTokens(content).map((segment, i) =>
        segment.kind === 'mention'
          ? <MentionBadge key={i} userId={segment.userId} channelId={channelId} interactive={false} />
          : replaceEmojiShortcodesInMarkdownSource(segment.text),
      )}
    </>
  );
}
