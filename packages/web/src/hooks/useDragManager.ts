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

  // --- Channel/Category drag handlers ---

  const handleChannelDragStart = useCallback((e: React.DragEvent, channelId: string) => {
    if (!canManage || activeDrag !== null) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', channelId); // Firefox requires setData for drag to work
    setActiveDrag({ type: 'channel', dragId: channelId });
  }, [canManage, activeDrag]);

  const handleCategoryDragStart = useCallback((e: React.DragEvent, categoryId: string) => {
    if (!canManage || activeDrag !== null) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', categoryId); // Firefox requires setData for drag to work
    setActiveDrag({ type: 'category', dragId: categoryId });
  }, [canManage, activeDrag]);

  const handleLayoutDragOver = useCallback((e: React.DragEvent, targetId: string, targetType: 'channel' | 'category') => {
    if (!activeDrag || activeDrag.type === 'voiceUser') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';
    setDropTarget({ targetId, position, targetType });
  }, [activeDrag]);

  const handleDragEnd = useCallback(() => {
    clearState();
  }, [clearState]);

  const channelHandlers = useCallback((channelId: string) => ({
    draggable: canManage,
    onDragStart: (e: React.DragEvent) => handleChannelDragStart(e, channelId),
    onDragOver: (e: React.DragEvent) => handleLayoutDragOver(e, channelId, 'channel'),
    onDragEnd: handleDragEnd,
  }), [canManage, handleChannelDragStart, handleLayoutDragOver, handleDragEnd]);

  const categoryHandlers = useCallback((categoryId: string) => ({
    draggable: canManage,
    onDragStart: (e: React.DragEvent) => handleCategoryDragStart(e, categoryId),
    onDragOver: (e: React.DragEvent) => handleLayoutDragOver(e, categoryId, 'category'),
    onDragEnd: handleDragEnd,
  }), [canManage, handleCategoryDragStart, handleLayoutDragOver, handleDragEnd]);

  // --- Container handlers (scrollable sidebar div) ---

  const handleContainerDragOver = useCallback((e: React.DragEvent) => {
    if (activeDrag && (activeDrag.type === 'channel' || activeDrag.type === 'category')) {
      e.preventDefault();
    }
  }, [activeDrag]);

  const handleContainerDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (!activeDrag || !dropTarget) {
      clearState();
      return;
    }
    // Self-drop no-op (fixes bug 5)
    if (activeDrag.dragId === dropTarget.targetId) {
      clearState();
      return;
    }
    if (activeDrag.type === 'channel') {
      onChannelDrop(activeDrag.dragId, dropTarget);
    } else if (activeDrag.type === 'category') {
      onCategoryDrop(activeDrag.dragId, dropTarget);
    }
    clearState();
  }, [activeDrag, dropTarget, onChannelDrop, onCategoryDrop, clearState]);

  const containerHandlers = {
    onDrop: handleContainerDrop,
    onDragOver: handleContainerDragOver,
  };

  // Suppress unused variable warnings for incremental build
  void scrollContainerRef;
  void canMoveMembers;
  void onVoiceUserDrop;

  return {
    activeDrag,
    dropTarget,
    channelHandlers,
    categoryHandlers,
    containerHandlers,
  };
}
