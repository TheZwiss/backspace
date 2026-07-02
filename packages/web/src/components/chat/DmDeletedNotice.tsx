/**
 * Read-only composer replacement shown in a 1-on-1 DM whose partner's account
 * was deleted. Occupies the same bottom slot as the MessageInput glass bubble.
 */
export function DmDeletedNotice() {
  return (
    <div className="px-4 pb-4 pt-1">
      <div className="glass-bubble flex items-center gap-2 px-4 py-3 rounded-[14px] text-txt-tertiary text-[14px] justify-center select-none">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="opacity-70 flex-shrink-0">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
        </svg>
        <span>This user&rsquo;s account was deleted</span>
      </div>
    </div>
  );
}
