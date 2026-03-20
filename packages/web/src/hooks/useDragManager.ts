import { useState, useCallback, useEffect, useMemo, type RefObject } from 'react';

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

export interface LayoutItem {
  id: string;
  type: 'channel' | 'category';
}

interface UseDragManagerOpts {
  scrollContainerRef: RefObject<HTMLElement | null>;
  canManage: boolean;
  canMoveMembers: boolean;
  /** Flat ordered list of all visible items in sidebar order — used to normalize
   *  'before B' into 'after A' so only a single drop indicator line renders. */
  orderedItems: LayoutItem[];
  onChannelDrop: (dragId: string, target: DropTarget) => void;
  onCategoryDrop: (dragId: string, target: DropTarget) => void;
  onVoiceUserDrop: (userId: string, fromChannelId: string, toChannelId: string) => void;
}

export function useDragManager(opts: UseDragManagerOpts) {
  const { scrollContainerRef, canManage, canMoveMembers, orderedItems, onChannelDrop, onCategoryDrop, onVoiceUserDrop } = opts;

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
    if (!canManage) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', channelId); // Firefox requires setData for drag to work
    setActiveDrag({ type: 'channel', dragId: channelId });
  }, [canManage]);

  const handleCategoryDragStart = useCallback((e: React.DragEvent, categoryId: string) => {
    if (!canManage) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', categoryId); // Firefox requires setData for drag to work
    setActiveDrag({ type: 'category', dragId: categoryId });
  }, [canManage]);

  const handleLayoutDragOver = useCallback((e: React.DragEvent, targetId: string, targetType: 'channel' | 'category') => {
    if (!activeDrag || activeDrag.type === 'voiceUser') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    let position: 'before' | 'after' = e.clientY < midY ? 'before' : 'after';

    // Normalize 'before' to previous item's 'after' so a single drop indicator
    // line renders between items, eliminating the double-line visual glitch
    let resolvedId = targetId;
    let resolvedType = targetType;
    if (position === 'before') {
      const idx = orderedItems.findIndex(item => item.id === targetId);
      if (idx > 0) {
        const prev = orderedItems[idx - 1]!;
        resolvedId = prev.id;
        resolvedType = prev.type;
        position = 'after';
      }
    }

    setDropTarget({ targetId: resolvedId, position, targetType: resolvedType });
  }, [activeDrag, orderedItems]);

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

  const containerHandlers = useMemo(() => ({
    onDrop: handleContainerDrop,
    onDragOver: handleContainerDragOver,
  }), [handleContainerDrop, handleContainerDragOver]);

  // --- Voice user drag handlers ---

  const handleVoiceUserDragStart = useCallback((e: React.DragEvent, userId: string, fromChannelId: string) => {
    e.stopPropagation(); // Prevents bubbling to ChannelItem (fixes bug 1)
    if (!canMoveMembers) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', userId); // Firefox requires setData for drag to work
    setActiveDrag({ type: 'voiceUser', dragId: userId, sourceId: fromChannelId });
  }, [canMoveMembers]);

  const handleVoiceUserDragEnd = useCallback((e: React.DragEvent) => {
    e.stopPropagation(); // Prevents bubbling to ChannelItem (fixes bug 6)
    clearState();
  }, [clearState]);

  const voiceUserHandlers = useCallback((userId: string, channelId: string) => ({
    draggable: canMoveMembers,
    isBeingDragged: activeDrag?.type === 'voiceUser' && activeDrag.dragId === userId && activeDrag.sourceId === channelId,
    onDragStart: (e: React.DragEvent) => handleVoiceUserDragStart(e, userId, channelId),
    onDragEnd: handleVoiceUserDragEnd,
  }), [canMoveMembers, activeDrag, handleVoiceUserDragStart, handleVoiceUserDragEnd]);

  const handleVoiceDropZoneDragOver = useCallback((e: React.DragEvent, channelId: string) => {
    if (activeDrag?.type !== 'voiceUser') return;
    if (activeDrag.sourceId === channelId) return; // same channel — no preventDefault (fixes bug 2)
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setVoiceHoverChannelId(channelId);
  }, [activeDrag]);

  const handleVoiceDropZoneDragEnter = useCallback((e: React.DragEvent, channelId: string) => {
    if (activeDrag?.type !== 'voiceUser') return;
    if (activeDrag.sourceId === channelId) return;
    e.preventDefault();
    setVoiceHoverChannelId(channelId);
  }, [activeDrag]);

  const handleVoiceDropZoneDragLeave = useCallback((e: React.DragEvent) => {
    if (activeDrag?.type !== 'voiceUser') return;
    // Only clear when actually leaving the container, not entering a child element
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setVoiceHoverChannelId(null);
  }, [activeDrag]);

  const handleVoiceDropZoneDrop = useCallback((e: React.DragEvent, channelId: string) => {
    // Only handle voice user drops — let channel/category drops bubble to container
    if (activeDrag?.type !== 'voiceUser') return;
    e.preventDefault();
    e.stopPropagation(); // Prevent bubbling to container's onDrop
    if (activeDrag.sourceId && activeDrag.sourceId !== channelId) {
      onVoiceUserDrop(activeDrag.dragId, activeDrag.sourceId, channelId);
    }
    clearState();
  }, [activeDrag, onVoiceUserDrop, clearState]);

  const voiceChannelDropZone = useCallback((channelId: string) => ({
    onDragOver: (e: React.DragEvent) => handleVoiceDropZoneDragOver(e, channelId),
    onDragEnter: (e: React.DragEvent) => handleVoiceDropZoneDragEnter(e, channelId),
    onDragLeave: handleVoiceDropZoneDragLeave,
    onDrop: (e: React.DragEvent) => handleVoiceDropZoneDrop(e, channelId),
    isDragOver: voiceHoverChannelId === channelId,
    isValidTarget: activeDrag?.type === 'voiceUser' && activeDrag.sourceId !== channelId,
  }), [
    handleVoiceDropZoneDragOver, handleVoiceDropZoneDragEnter,
    handleVoiceDropZoneDragLeave, handleVoiceDropZoneDrop,
    voiceHoverChannelId, activeDrag,
  ]);

  // --- Auto-scroll during drag (fixes bug 7) ---

  useEffect(() => {
    if (!activeDrag || !scrollContainerRef.current) return;
    const container = scrollContainerRef.current;
    const EDGE_PX = 40;
    let scrollSpeed = 0;
    let rafId = 0;

    const onDragOver = (e: DragEvent) => {
      const rect = container.getBoundingClientRect();
      const distFromTop = e.clientY - rect.top;
      const distFromBottom = rect.bottom - e.clientY;

      if (distFromTop < EDGE_PX) {
        scrollSpeed = -(1 + 7 * (1 - distFromTop / EDGE_PX));
      } else if (distFromBottom < EDGE_PX) {
        scrollSpeed = 1 + 7 * (1 - distFromBottom / EDGE_PX);
      } else {
        scrollSpeed = 0;
      }
    };

    const tick = () => {
      if (scrollSpeed !== 0) {
        container.scrollTop += scrollSpeed;
      }
      rafId = requestAnimationFrame(tick);
    };

    container.addEventListener('dragover', onDragOver);
    rafId = requestAnimationFrame(tick);

    return () => {
      container.removeEventListener('dragover', onDragOver);
      cancelAnimationFrame(rafId);
    };
  }, [activeDrag, scrollContainerRef]);

  return {
    activeDrag,
    dropTarget,
    channelHandlers,
    categoryHandlers,
    containerHandlers,
    voiceUserHandlers,
    voiceChannelDropZone,
  };
}
