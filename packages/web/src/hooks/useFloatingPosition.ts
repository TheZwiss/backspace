import { type RefObject, type CSSProperties, useState, useLayoutEffect, useCallback } from 'react';
import { layoutPixels, layoutRect } from '../platform/interfaceScale';

export type Placement = 'top' | 'bottom' | 'left' | 'right';
/** Cross-axis alignment: centred on the anchor, or flush with its leading edge. */
export type Alignment = 'center' | 'start';

/** The subset of DOMRect placement needs — lets callers pass a stored rect. */
export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/** A zero-size anchor at a viewport point, for callers with no anchor element. */
export function pointAnchor(x: number, y: number): AnchorRect {
  return { top: y, left: x, right: x, bottom: y, width: 0, height: 0 };
}

interface UseFloatingPositionOptions {
  placement: Placement;
  offset?: number;
  enabled?: boolean;
}

interface UseFloatingPositionResult {
  style: CSSProperties;
  actualPlacement: Placement;
}

const VIEWPORT_PADDING = 8;

const oppositePlacement: Record<Placement, Placement> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
};

/**
 * Places a floating surface next to an anchor: preferred side first, flipping to
 * the opposite side when it would overflow, then clamping into the viewport.
 *
 * Exported because not every floating surface has a live anchor element. The
 * profile popout, for instance, is opened from a store and keeps only the
 * anchor's rect — the row it came from may have re-rendered or scrolled away by
 * the time the card mounts.
 */
export function computeFloatingPosition(
  anchorRect: AnchorRect,
  floatingWidth: number,
  floatingHeight: number,
  placement: Placement,
  offset: number,
  align: Alignment = 'center',
): { top: number; left: number; actualPlacement: Placement } {
  anchorRect = layoutRect(anchorRect);
  floatingWidth = layoutPixels(floatingWidth);
  floatingHeight = layoutPixels(floatingHeight);
  const vw = layoutPixels(window.innerWidth);
  const vh = layoutPixels(window.innerHeight);

  let top = 0;
  let left = 0;
  let actual = placement;

  // Compute initial position on primary axis
  const crossLeft = align === 'start'
    ? anchorRect.left
    : anchorRect.left + anchorRect.width / 2 - floatingWidth / 2;
  const crossTop = align === 'start'
    ? anchorRect.top
    : anchorRect.top + anchorRect.height / 2 - floatingHeight / 2;

  if (placement === 'top') {
    top = anchorRect.top - floatingHeight - offset;
    left = crossLeft;
  } else if (placement === 'bottom') {
    top = anchorRect.bottom + offset;
    left = crossLeft;
  } else if (placement === 'left') {
    top = crossTop;
    left = anchorRect.left - floatingWidth - offset;
  } else {
    top = crossTop;
    left = anchorRect.right + offset;
  }

  // Flip: if overflowing on primary axis, try the opposite side
  if (placement === 'top' && top < VIEWPORT_PADDING) {
    const flippedTop = anchorRect.bottom + offset;
    if (flippedTop + floatingHeight <= vh - VIEWPORT_PADDING) {
      top = flippedTop;
      actual = 'bottom';
    }
  } else if (placement === 'bottom' && top + floatingHeight > vh - VIEWPORT_PADDING) {
    const flippedTop = anchorRect.top - floatingHeight - offset;
    if (flippedTop >= VIEWPORT_PADDING) {
      top = flippedTop;
      actual = 'top';
    }
  } else if (placement === 'left' && left < VIEWPORT_PADDING) {
    const flippedLeft = anchorRect.right + offset;
    if (flippedLeft + floatingWidth <= vw - VIEWPORT_PADDING) {
      left = flippedLeft;
      actual = 'right';
    }
  } else if (placement === 'right' && left + floatingWidth > vw - VIEWPORT_PADDING) {
    const flippedLeft = anchorRect.left - floatingWidth - offset;
    if (flippedLeft >= VIEWPORT_PADDING) {
      left = flippedLeft;
      actual = 'left';
    }
  }

  // Clamp: keep within viewport on cross axis
  if (actual === 'top' || actual === 'bottom') {
    left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - floatingWidth - VIEWPORT_PADDING));
  } else {
    top = Math.max(VIEWPORT_PADDING, Math.min(top, vh - floatingHeight - VIEWPORT_PADDING));
  }

  // Also clamp primary axis as last resort
  top = Math.max(VIEWPORT_PADDING, Math.min(top, vh - floatingHeight - VIEWPORT_PADDING));
  left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - floatingWidth - VIEWPORT_PADDING));

  return { top, left, actualPlacement: actual };
}

export function useFloatingPosition(
  anchorRef: RefObject<HTMLElement | null>,
  floatingRef: RefObject<HTMLElement | null>,
  options: UseFloatingPositionOptions,
): UseFloatingPositionResult {
  const { placement, offset = 8, enabled = true } = options;

  const [result, setResult] = useState<{ top: number; left: number; actualPlacement: Placement }>({
    top: -9999,
    left: -9999,
    actualPlacement: placement,
  });

  const update = useCallback(() => {
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    if (!anchor || !floating) return;

    const anchorRect = anchor.getBoundingClientRect();
    const floatingRect = floating.getBoundingClientRect();

    const pos = computeFloatingPosition(
      anchorRect,
      floatingRect.width,
      floatingRect.height,
      placement,
      offset,
    );

    setResult((prev) => {
      if (prev.top === pos.top && prev.left === pos.left && prev.actualPlacement === pos.actualPlacement) {
        return prev;
      }
      return pos;
    });
  }, [anchorRef, floatingRef, placement, offset]);

  useLayoutEffect(() => {
    if (!enabled) return;
    update();

    // Observe resize of both elements
    const anchor = anchorRef.current;
    const floating = floatingRef.current;
    const targets: Element[] = [];
    if (anchor) targets.push(anchor);
    if (floating) targets.push(floating);

    const ro = new ResizeObserver(update);
    targets.forEach((t) => ro.observe(t));

    // Also update on scroll/resize
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);

    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [enabled, update, anchorRef, floatingRef]);

  return {
    style: {
      position: 'fixed',
      top: result.top,
      left: result.left,
      zIndex: 200,
    },
    actualPlacement: result.actualPlacement,
  };
}
