import type { ReactNode } from 'react';
import './FriendsGlass.css';

export interface FriendsTab {
  id: string;
  label: string;
  active: boolean;
  /** A count worth showing on the tab, or undefined for none. */
  badge?: number;
  onSelect: () => void;
}

interface FriendsHeaderProps {
  /** The page title, already translated. */
  title: string;
  tabs: readonly FriendsTab[];
  /** The add-friend action: its label, whether it is the active tab, and the handler. */
  addLabel: string;
  addActive: boolean;
  onAdd: () => void;
  /** Controls that sit at the far right (the member-list toggle). */
  trailing?: ReactNode;
}

/**
 * The friends page's controls, floating on glass over the home backdrop:
 * the title, the tab strip, the add-friend action and the trailing controls.
 * Owned by the UI soul pass (scene bible section 13). Every string arrives
 * translated; this component owns none.
 *
 * Four pills in one row, none touching: the title with its icon, the tabs as
 * one segmented pill with the active tab lifted, the add-friend action in the
 * online green, and the trailing control in a small round pill at the far
 * right. Every pill sits on `.glass-bubble`; the look lives in FriendsGlass.css.
 */
export function FriendsHeader({ title, tabs, addLabel, addActive, onAdd, trailing }: FriendsHeaderProps) {
  return (
    <div className="friends-header h-14 px-4 flex items-center flex-shrink-0 relative z-10">
      <div className="friends-header__title glass-bubble">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
        </svg>
        <span>{title}</span>
      </div>
      <div className="friends-header__tabs glass-bubble">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={tab.onSelect}
            aria-pressed={tab.active}
            className={`friends-header__tab${tab.active ? ' is-active' : ''}`}
          >
            {tab.label}
            {tab.badge !== undefined && tab.badge > 0 && (
              <span className="ml-2 px-1.5 py-0.5 bg-accent-rose text-white text-[10px] rounded-full leading-none">{tab.badge}</span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        aria-pressed={addActive}
        className={`friends-header__add glass-bubble${addActive ? ' is-active' : ''}`}
      >
        {addLabel}
      </button>
      {trailing !== undefined && trailing !== null && (
        <div className="friends-header__trailing glass-bubble">{trailing}</div>
      )}
    </div>
  );
}

/**
 * The region the friends page's content scrolls in, over the home backdrop.
 * It paints nothing: a bubble is only as large as what it holds, so the glass
 * sits on the rows themselves (`.friends-row`) and on each tab's count
 * (`.friends-count`), both styled in FriendsGlass.css, and an empty state's
 * Nori and line sit directly on the sky. The caller's block keeps its own
 * scroll; this is the flex column it fills.
 */
export function FriendsPanel({ children }: { children: ReactNode }) {
  return <div className="friends-panel flex-1 min-h-0 flex flex-col relative z-10">{children}</div>;
}
