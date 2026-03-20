import { useState, useCallback, useEffect, type RefObject } from 'react';

export type DragType = 'channel' | 'category' | 'voiceUser';

export interface DragState {
  type: DragType;
  dragId: string;
  sourceId?: string; // only for voiceUser — originating channelId
}

export interface DropTarget {
  targetId: string;
  position: 'before' | 'after';
  targetType: 'channel' | 'category';
}

interface UseDragManagerOpts {
  scrollContainerRef: RefObject<HTMLElement | null>;
  canManage: boolean;
  canMoveMembers: boolean;
  onChannelDrop: (dragId: string, target: DropTarget) => void;
  onCategoryDrop: (dragId: string, target: DropTarget) => void;
  onVoiceUserDrop: (userId: string, fromChannelId: string, toChannelId: string) => void;
}

export function useDragManager(opts: UseDragManagerOpts) {
  const { scrollContainerRef, canManage, canMoveMembers, onChannelDrop, onCategoryDrop, onVoiceUserDrop } = opts;

  const [activeDrag, setActiveDrag] = useState<DragState | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [voiceHoverChannelId, setVoiceHoverChannelId] = useState<string | null>(null);

  const clearState = useCallback(() => {
    setActiveDrag(null);
    setDropTarget(null);
    setVoiceHoverChannelId(null);
  }, []);

  // Handler factories added in subsequent stages...

  // Suppress unused variable warnings for incremental build
  void scrollContainerRef;
  void canManage;
  void canMoveMembers;
  void onChannelDrop;
  void onCategoryDrop;
  void onVoiceUserDrop;
  void clearState;

  return {
    activeDrag,
    dropTarget,
  };
}
