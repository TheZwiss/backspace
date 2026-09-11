import type { ReactNode } from 'react';

export type WelcomeHeroKind = 'channel' | 'dm' | 'group';

interface WelcomeHeroProps {
  kind: WelcomeHeroKind;
  /** The 68px hash disc, the 80px ProfileAvatar, or the AvatarStack, rendered by the caller. */
  figure: ReactNode;
  title: string;
  /** Copy lines and the optional button row, rendered by the caller in its own markup. */
  children: ReactNode;
}

/**
 * The block at the top of a conversation's history: the figure, the title, the
 * caller's copy and buttons, and the rule under it. Structure only; the first
 * decorated version was rejected (scene bible section 12) and the header is
 * the plain one again.
 *
 * This component never reads a store and never handles a click; MessageList
 * builds the figure, the title and the children per branch and passes them in.
 *
 * Its rendered height for a given kind and title is part of the message list's
 * scroll contract (docs/systems/message-list.md, "Top-of-list reservation
 * slot"): it is measured once when the last page loads and must never change
 * on its own afterwards. Nothing in flow here may move, grow or reflow.
 */
export function WelcomeHero({ kind, figure, title, children }: WelcomeHeroProps) {
  return (
    <div className="px-4 pt-8 pb-4">
      <div className={kind === 'channel' ? 'mb-4' : 'mb-2'}>{figure}</div>
      <h3 className={`text-[32px] leading-10 font-bold text-txt-primary${kind === 'group' ? ' mt-2' : ''}`}>{title}</h3>
      {children}
      <div className="mt-6 border-b border-interactive-muted" />
    </div>
  );
}
