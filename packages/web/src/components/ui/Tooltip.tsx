import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { useUIStore } from '../../stores/uiStore';
import { useDismissOnEscape } from '../../hooks/useDismissOnEscape';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'right' | 'bottom' | 'left';
  delay?: number;
}

export function Tooltip({ content, children, position = 'right', delay = 200 }: TooltipProps) {
  const isMobile = useUIStore((s) => s.isMobile);

  const [isVisible, setIsVisible] = useState(false);
  // A show is scheduled but its delay has not run out yet.
  const [isPending, setIsPending] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const anchorRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const portalContainer = usePortalContainer();

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: position,
    offset: 8,
    enabled: isVisible,
  });

  const show = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsPending(true);
    timeoutRef.current = setTimeout(() => {
      setIsPending(false);
      setIsVisible(true);
    }, delay);
  };

  const hide = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsPending(false);
    setIsVisible(false);
  };

  // Escape closes it, or cancels one still waiting out its delay; it reopens
  // only when the pointer leaves and comes back.
  useDismissOnEscape(!isMobile && (isPending || isVisible), hide);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // No tooltips on touch devices: render the children unwrapped. This has to
  // sit below every hook call, because isMobile flips when the viewport
  // crosses the mobile breakpoint, and an early return above the hooks would
  // change the hook count between two renders of the same component.
  if (isMobile) return <>{children}</>;

  return (
    <div ref={anchorRef} className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {isVisible && createPortal(
        <div
          ref={floatingRef}
          role="tooltip"
          style={style}
          className="px-3 py-1.5 text-sm font-medium text-txt-primary glass rounded-md whitespace-nowrap pointer-events-none"
        >
          {content}
        </div>,
        portalContainer,
      )}
    </div>
  );
}
