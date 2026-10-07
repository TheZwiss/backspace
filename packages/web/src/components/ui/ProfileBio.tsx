import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkEmojiShortcodes } from '../../utils/remarkEmojiShortcodes';
import { useEmojiShortcodeNames } from '../../utils/emojiShortcodes';

// A bio is short profile prose: paragraphs, bold, italics, strikethrough and
// links. Anything else it contains (headings, lists, code, tables) is
// unwrapped to its text, so a bio never breaks the card's layout. It is parsed
// the way a chat message is (GFM, so a bare URL becomes a link), and
// `:shortcode:` text renders as emoji the same way it does in chat.

const ALLOWED_ELEMENTS = ['p', 'strong', 'em', 'del', 'a', 'br'];
const REMARK_PLUGINS = [remarkGfm, remarkEmojiShortcodes];
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
  ),
};

interface ProfileBioProps {
  bio: string;
}

/** The "About me" text of a profile, as the profile card and the full profile show it. */
export function ProfileBio({ bio }: ProfileBioProps) {
  useEmojiShortcodeNames();
  return (
    <div className="text-[13px] text-txt-secondary mt-1 whitespace-pre-wrap break-words leading-relaxed [&_strong]:font-semibold [&_strong]:text-txt-primary [&_em]:italic [&_a]:text-accent-primary [&_a]:underline">
      <ReactMarkdown
        allowedElements={ALLOWED_ELEMENTS}
        unwrapDisallowed
        remarkPlugins={REMARK_PLUGINS}
        components={COMPONENTS}
      >
        {bio}
      </ReactMarkdown>
    </div>
  );
}
