import React from 'react';
import { useUIStore } from '../../stores/uiStore';

export function MemberListToggleButton() {
  const toggleMemberList = useUIStore((s) => s.toggleMemberList);
  const memberListOpen = useUIStore((s) => s.memberListOpen);

  return (
    <button
      onClick={toggleMemberList}
      className={`w-8 h-8 flex items-center justify-center transition-colors rounded-[4px] hover:bg-discord-modifier-hover ${
        memberListOpen ? 'text-discord-text-primary' : 'text-discord-text-muted hover:text-discord-text-secondary'
      }`}
      title="Toggle Member List"
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M14 8.00598C14 10.211 12.206 12.006 10 12.006C7.795 12.006 6 10.211 6 8.00598C6 5.80098 7.794 4.00598 10 4.00598C12.206 4.00598 14 5.80098 14 8.00598ZM2 19.006C2 15.473 5.29 13.006 10 13.006C14.711 13.006 18 15.473 18 19.006V20.006H2V19.006ZM20 20.006H22V19.006C22 16.451 20.178 14.471 17.532 13.471C19.461 14.601 20 16.561 20 19.006V20.006Z" />
      </svg>
    </button>
  );
}
