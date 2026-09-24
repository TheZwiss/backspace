import React, { useId, type JSX, type ReactNode } from 'react';

/** The design system's pastel accents (`--accent-*`, `tailwind.config.js`). */
export type HubAccent = 'lavender' | 'mint' | 'peach' | 'sky' | 'amber' | 'rose' | 'coral';

/**
 * Icon tile classes per accent. Written out in full because Tailwind only
 * generates classes it finds as literal strings in the source; a class built
 * from `accent-${accent}` would compile to nothing.
 */
const ACCENT_TILE: Record<HubAccent, string> = {
  lavender: 'bg-accent-lavender/15 text-accent-lavender',
  mint: 'bg-accent-mint/15 text-accent-mint',
  peach: 'bg-accent-peach/15 text-accent-peach',
  sky: 'bg-accent-sky/15 text-accent-sky',
  amber: 'bg-accent-amber/15 text-accent-amber',
  rose: 'bg-accent-rose/15 text-accent-rose',
  coral: 'bg-accent-coral/15 text-accent-coral',
};

/**
 * The shell every card on the Backspace page uses: an icon tile, a title, an
 * optional body and an optional action area pinned to the bottom, so cards of
 * different text lengths in one `.card-grid` row line their actions up.
 *
 * Cards are content on the page, not floating controls, so the surface is
 * matte (`bg-surface-channel`, rounded and bordered like the Explore space
 * cards), never glass. The accent colours the icon tile and nothing else.
 * Presentational only: a card that needs data fetches it itself and passes
 * the result in.
 */
export function HubCard(props: {
  accent: HubAccent; icon: ReactNode; title: string; body?: ReactNode;
  children?: ReactNode; // action area
}): JSX.Element {
  const { accent, icon, title, body, children } = props;
  const titleId = useId();

  return (
    <article
      aria-labelledby={titleId}
      className="bg-surface-channel rounded-lg border border-border-soft p-4 flex flex-col gap-3"
    >
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${ACCENT_TILE[accent]}`}
        >
          {icon}
        </div>
        <h3 id={titleId} className="text-[15px] font-bold text-txt-primary min-w-0">
          {title}
        </h3>
      </div>

      {body !== undefined && body !== null && (
        <div data-hub-card-body className="text-[13px] text-txt-secondary flex-1">
          {body}
        </div>
      )}

      {children !== undefined && children !== null && (
        <div data-hub-card-actions className="mt-auto flex flex-wrap items-center gap-2">
          {children}
        </div>
      )}
    </article>
  );
}
