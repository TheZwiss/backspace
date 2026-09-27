import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Reaction } from '@backspace/shared';
import { useFormatters } from '../../i18n/formatters';
import { useAuthStore } from '../../stores/authStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { getCanonicalUserView } from '../../utils/userViewLookup';
import { parseFederatedUsername } from '../../utils/identity';
import { isOwnReaction, reactionSentence, summarizeReactors } from './reactionSummary';

interface ReactionPillProps {
  emoji: string;
  /** Every reaction on the message with this emoji. */
  reactions: readonly Reaction[];
  onToggle: () => void;
}

const SHOW_DELAY_MS = 300;
/** Longest name the tooltip prints before cutting it with an ellipsis. */
const MAX_NAME_CHARS = 32;

function truncateName(name: string): string {
  const chars = Array.from(name);
  return chars.length > MAX_NAME_CHARS ? `${chars.slice(0, MAX_NAME_CHARS - 1).join('')}…` : name;
}

/**
 * One reaction under a message: the emoji and its count, toggling the
 * current user's reaction on click. Hover or keyboard focus (not the focus a
 * mouse click leaves behind) shows who reacted in a `.glass` tooltip above
 * the pill, styled like the shared `Tooltip`; the same sentence is the
 * button's accessible description, so screen readers and touch users (who
 * get no hover tooltip) still have it. Escape closes it either way.
 *
 * Reactor names come from the reaction rows the message already carries
 * (every read path and the `reaction_added` event attach the reacting user),
 * routed through the cross-instance user views so a remote user shows their
 * home instance's name rather than a stub's.
 */
export function ReactionPill({ emoji, reactions, onToggle }: ReactionPillProps) {
  const { t } = useTranslation(['chat', 'common']);
  const fmt = useFormatters();
  const currentUser = useAuthStore((s) => s.user);
  const isMobile = useUIStore((s) => s.isMobile);
  const descriptionId = useId();
  const [open, setOpen] = useState(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();
  const tooltipOpen = open && !isMobile;
  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'top',
    offset: 8,
    enabled: tooltipOpen,
  });

  useEffect(() => () => clearTimeout(showTimerRef.current), []);

  const mine = reactions.some((r) => isOwnReaction(r, currentUser));

  const nameOf = (reaction: Reaction): string => {
    const user = reaction.user
      ?? useSpaceStore.getState().members.find((m) => m.userId === reaction.userId)?.user;
    if (!user) return t('common:states.unknown');
    const view = getCanonicalUserView(user);
    return truncateName(view.displayName || parseFederatedUsername(view.username).baseName);
  };

  const summary = summarizeReactors(reactions, (r) => isOwnReaction(r, currentUser), nameOf);
  const sentence = reactionSentence(summary, t, fmt);
  const before = sentence.text.slice(0, sentence.namesStart);
  const names = sentence.text.slice(sentence.namesStart, sentence.namesStart + sentence.namesLength);
  const after = sentence.text.slice(sentence.namesStart + sentence.namesLength);

  const show = () => {
    clearTimeout(showTimerRef.current);
    showTimerRef.current = setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  };
  const hide = () => {
    clearTimeout(showTimerRef.current);
    setOpen(false);
  };

  // Escape dismisses the tooltip however it opened (WCAG 1.4.13). A hovered
  // pill does not have focus, so its own keydown never sees the key; listen
  // on the document while the tooltip shows. It stays closed until the
  // pointer or focus leaves and comes back.
  useEffect(() => {
    if (!tooltipOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      clearTimeout(showTimerRef.current);
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [tooltipOpen]);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={onToggle}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={(e) => {
          if (e.currentTarget.matches(':focus-visible')) show();
        }}
        onBlur={hide}
        aria-pressed={mine}
        aria-describedby={descriptionId}
        className={`glass-pill flex items-center gap-1 rounded-[6px] cursor-pointer transition-all duration-[120ms] ease-out focus-visible:ring-2 focus-visible:ring-accent-primary/60 ${
          mine ? 'glass-pill-mine' : ''
        }`}
        style={{ padding: '2px 8px', fontSize: '13px', lineHeight: 1 }}
      >
        <span style={{ fontSize: '14px', lineHeight: 1 }}>{emoji}</span>
        <span className={`font-semibold ${mine ? 'text-accent-mint' : 'text-txt-secondary'}`} style={{ fontSize: '12px' }}>
          {fmt.formatNumber(reactions.length)}
        </span>
      </button>
      <span id={descriptionId} className="sr-only">{sentence.text}</span>
      {tooltipOpen && createPortal(
        <div
          ref={floatingRef}
          role="tooltip"
          style={style}
          className="glass rounded-md px-2.5 py-1.5 flex items-center gap-2 max-w-[360px] pointer-events-none animate-fade-in"
        >
          <span className="text-[16px] leading-none flex-shrink-0">{emoji}</span>
          <span className="text-[13px] leading-[18px] text-txt-secondary [overflow-wrap:anywhere]">
            {before}
            <span className="font-medium text-txt-primary">{names}</span>
            {after}
          </span>
        </div>,
        portalContainer,
      )}
    </>
  );
}
