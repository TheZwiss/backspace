import { MentionBadge } from './MentionBadge';
import { replaceEmojiShortcodesInMarkdownSource } from '../../utils/emojiShortcodes';

const MENTION_SPLIT = /(<@[a-zA-Z0-9_-]+>)/g;
const MENTION_TOKEN = /^<@([a-zA-Z0-9_-]+)>$/;

interface InlineMessageTextProps {
  content: string;
}

/**
 * One line of message text without Markdown, as a reply preview shows it:
 * `<@userId>` tokens become non-interactive mention badges (the preview
 * itself is the jump control), `:shortcode:` text becomes emoji
 * (not inside code, and not where a colon is escaped as `\:`), and everything
 * else is plain text.
 */
export function InlineMessageText({ content }: InlineMessageTextProps) {
  const parts = content.split(MENTION_SPLIT);
  return (
    <>
      {parts.map((part, i) => {
        const match = part.match(MENTION_TOKEN);
        if (match) return <MentionBadge key={i} userId={match[1]!} interactive={false} />;
        return replaceEmojiShortcodesInMarkdownSource(part);
      })}
    </>
  );
}
