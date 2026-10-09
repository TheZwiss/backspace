import { MassMentionBadge } from './MassMentionBadge';
import { MentionBadge } from './MentionBadge';
import { replaceEmojiShortcodesInMarkdownSource, useEmojiShortcodeNames } from '../../utils/emojiShortcodes';
import { splitMentionTokens } from '../../utils/mentionTokens';

const MASS_MENTION_SPLIT = /(```[\s\S]*?```|`[^`]+`|<@&[a-zA-Z0-9_-]+>|(?<![\w@])@(?:everyone|here)(?![\w-]))/g;

interface InlineMessageTextProps {
  content: string;
  /** The channel the text was written in; its mentions resolve there (see `MentionBadge`). */
  channelId: string | null;
}

function renderTextSegment(text: string, baseKey: number, channelId: string | null) {
  const parts = text.split(MASS_MENTION_SPLIT);
  return parts.map((part, j) => {
    if (part === '@everyone' || part === '@here') {
      return <MassMentionBadge channelId={channelId} key={`${baseKey}-${j}`} token={part.slice(1)} />;
    }
    const role = part.match(/^<@(&[a-zA-Z0-9_-]+)>$/);
    if (role) {
      return <MassMentionBadge channelId={channelId} key={`${baseKey}-${j}`} token={role[1]!} />;
    }
    return replaceEmojiShortcodesInMarkdownSource(part);
  });
}

/**
 * One line of message text without Markdown, as a reply preview shows it:
 * User and mass-mention tokens outside code become non-interactive badges (the
 * preview itself is the jump control; the scan is the one the full message
 * uses, see utils/mentionTokens.ts), `:shortcode:` text becomes emoji
 * (not inside code, and not where a colon is escaped as `\:`), and everything
 * else is plain text.
 */
export function InlineMessageText({ content, channelId }: InlineMessageTextProps) {
  useEmojiShortcodeNames();
  return (
    <>
      {splitMentionTokens(content).map((segment, i) =>
        segment.kind === 'mention'
          ? <MentionBadge key={i} userId={segment.userId} channelId={channelId} interactive={false} />
          : renderTextSegment(segment.text, i, channelId),
      )}
    </>
  );
}
