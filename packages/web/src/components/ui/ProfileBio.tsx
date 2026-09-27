import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import { remarkEmojiShortcodes } from '../../utils/emojiShortcodes';

// A bio is short profile prose: paragraphs, bold, italics and links. Anything
// else it contains (headings, lists, code) is unwrapped to its text, so a bio
// never breaks the card's layout. `:shortcode:` text renders as emoji, the same
// way it does in chat messages.

const ALLOWED_ELEMENTS = ['p', 'strong', 'em', 'a', 'br'];
const REMARK_PLUGINS = [remarkEmojiShortcodes];
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
