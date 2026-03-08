import React from 'react';
import { MemberSidebar } from './MemberSidebar';
import { ActivityPanel } from './ActivityPanel';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';

export function RightPanel() {
  const showDms = useUIStore((s) => s.showDms);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);

  if (showDms || !currentSpaceId) {
    return <ActivityPanel />;
  }

  return <MemberSidebar />;
}
