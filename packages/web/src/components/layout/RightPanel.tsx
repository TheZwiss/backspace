import React from 'react';
import { MemberSidebar } from './MemberSidebar';
import { ActivityPanel } from './ActivityPanel';
import { DmRosterPanel } from './DmRosterPanel';
import { PanelResizer } from './PanelResizer';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';

/**
 * The desktop right column. It owns the column itself — visibility (the
 * global member-list toggle), width and its divider, border and surface — and
 * picks the content: the member list in a space, the roster in a group DM,
 * and the activity panel elsewhere in the DM view. The content components
 * render only their contents, so the column keeps its width and position when
 * the content swaps.
 */
export function RightPanel() {
  const showDms = useUIStore((s) => s.showDms);
  const memberListOpen = useUIStore((s) => s.memberListOpen);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);
  const width = useUIStore((s) => s.panelWidths.memberList);

  if (!memberListOpen) return null;

  let content: React.ReactNode;
  let surfaceClassName: string;
  if (showDms || !currentSpaceId) {
    const dmChannel = dmChannels.find((dm) => dm.id === currentChannelId);
    if (dmChannel?.ownerId) {
      content = <DmRosterPanel />;
      surfaceClassName = 'bg-surface-members';
    } else {
      content = <ActivityPanel />;
      surfaceClassName = 'bg-surface-channel';
    }
  } else {
    content = <MemberSidebar />;
    surfaceClassName = 'bg-surface-members';
  }

  return (
    <div
      data-right-panel
      className={`relative flex-shrink-0 hidden desktop:flex border-l border-border-hard ${surfaceClassName}`}
      style={{ width }}
    >
      <PanelResizer panel="memberList" />
      <div className="flex-1 min-w-0 overflow-y-auto select-none no-scrollbar">
        {content}
      </div>
    </div>
  );
}
