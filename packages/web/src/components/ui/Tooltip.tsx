import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { useUIStore } from '../../stores/uiStore';

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: 'top' | 'right' | 'bottom' | 'left';
  delay?: number;
}

export function Tooltip({ content, children, position = 'right', delay = 200 }: TooltipProps) {
  const isMobile = useUIStore((s) => s.isMobile);

  const [isVisible, setIsVisible] = useState(false);
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
    timeoutRef.current = setTimeout(() => setIsVisible(true), delay);
  };

  const hide = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setIsVisible(false);
  };

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
