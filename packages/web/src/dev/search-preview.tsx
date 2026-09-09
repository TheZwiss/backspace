// Dev-only workbench for the message search popover (scene bible row 10).
// Nothing in the app imports this file; `dev-search.html` is its only entry.
// The real popover opens anchored to a replica of the channel header's search
// button, in its hint state (no query typed). Searching hits the API, which
// has no channel here, so only the resting state is meaningful.
import { useRef } from 'react';
import { SearchPopover } from '../components/chat/SearchPopover';
import { mountScenePage } from './harness';

function Page() {
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', background: 'rgb(var(--bg-chat))' }}>
      <div style={{ width: 72, background: 'rgb(var(--bg-base))' }} />
      <div style={{ width: 240, background: 'rgb(var(--bg-channel))' }} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div className="h-14 px-5 flex items-center justify-between border-b border-border-hard flex-shrink-0">
          <span className="font-bold text-[15px] text-txt-primary"># general</span>
          <button
            ref={anchorRef}
            type="button"
            className="w-8 h-8 flex items-center justify-center text-txt-primary rounded-[6px] bg-interactive-hover"
            title="Search"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div style={{ flex: 1, padding: 24, display: 'flex', flexDirection: 'column', gap: 18 }}>
          {[0.6, 0.8, 0.4, 0.7].map((w, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{ width: 36, height: 36, borderRadius: 18, background: 'rgb(var(--accent-lavender) / 0.35)' }} />
              <div style={{ height: 12, width: `${w * 50}%`, borderRadius: 6, background: 'rgb(var(--text-tertiary) / 0.45)' }} />
            </div>
          ))}
        </div>
      </div>
      <SearchPopover open onClose={() => undefined} anchorRef={anchorRef} channelId="workbench" isDm={false} onJumpToMessage={() => undefined} />
    </div>
  );
}

void mountScenePage(<Page />);
