import React from 'react';
import { MemberSidebar } from './MemberSidebar';
import { ActivityPanel } from './ActivityPanel';
import { DmRosterPanel } from './DmRosterPanel';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';

export function RightPanel() {
  const showDms = useUIStore((s) => s.showDms);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);

  // In the DM view (showDms or no current space), the right column is normally
  // the activity panel. The exception is group DMs while the user has the
  // member list toggled on — then we swap in DmRosterPanel, which itself
  // returns null if any of its preconditions are unmet.
  if (showDms || !currentSpaceId) {
    const dmChannel = dmChannels.find((dm) => dm.id === currentChannelId);
    const isGroupDm = !!dmChannel?.ownerId;
    if (isGroupDm && memberListOpen) {
      return <DmRosterPanel />;
    }
    return <ActivityPanel />;
  }

  return <MemberSidebar />;
}
