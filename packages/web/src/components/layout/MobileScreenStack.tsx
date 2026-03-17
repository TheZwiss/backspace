import React, { useRef, useEffect, useState } from 'react';
import { useUIStore } from '../../stores/uiStore';

interface MobileScreenStackProps {
  rootScreen: React.ReactNode;
  screenMap: Record<string, (params?: Record<string, string>) => React.ReactNode>;
}

export function MobileScreenStack({ rootScreen, screenMap }: MobileScreenStackProps) {
  const mobileStack = useUIStore((s) => s.mobileStack);
  const [transitioning, setTransitioning] = useState<'push' | 'pop' | null>(null);
  const [renderStack, setRenderStack] = useState(mobileStack);
  const prevStackRef = useRef(mobileStack);
  const animatingRef = useRef(false);

  useEffect(() => {
    const prevStack = prevStackRef.current;
    const prevLen = prevStack.length;
    const newLen = mobileStack.length;
    prevStackRef.current = mobileStack;

    if (newLen > prevLen) {
      // Push — render new screen off-screen, then animate in on next frame
      setRenderStack(mobileStack);
      setTransitioning('push');
      animatingRef.current = true;
      // Use rAF to ensure the off-screen position is painted before animating
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTransitioning(null);
          animatingRef.current = false;
        });
      });
    } else if (newLen < prevLen) {
      // Pop — keep old screen visible during exit animation, then remove
      setTransitioning('pop');
      animatingRef.current = true;
      const timer = setTimeout(() => {
        setRenderStack(mobileStack);
        setTransitioning(null);
        animatingRef.current = false;
      }, 200);
      return () => clearTimeout(timer);
    } else {
      setRenderStack(mobileStack);
    }
  }, [mobileStack]);

  return (
    <div className="relative flex-1 overflow-hidden">
      {/* Root screen — always rendered underneath, invisible when covered by stack */}
      <div
        className="flex flex-col h-full"
        style={{ visibility: renderStack.length > 0 ? 'hidden' : 'visible' }}
      >
        {rootScreen}
      </div>

      {/* Stacked screens */}
      {renderStack.map((entry, index) => {
        const isTop = index === renderStack.length - 1;
        const renderer = screenMap[entry.screen];
        if (!renderer) return null;

        let style: React.CSSProperties = {};
        let className = 'absolute inset-0 bg-surface-base z-10 flex flex-col';

        if (isTop && transitioning === 'push') {
          // Initial position: off-screen right
          style.transform = 'translateX(100%)';
        } else if (isTop && transitioning === 'pop') {
          // Animate out to the right
          className += ' transition-transform duration-200 ease-out';
          style.transform = 'translateX(100%)';
        } else if (isTop && !transitioning && !animatingRef.current) {
          // Settled position
          className += ' transition-transform duration-200 ease-out';
        }

        return (
          <div key={`${entry.screen}-${index}`} className={className} style={style}>
            {renderer(entry.params)}
          </div>
        );
      })}
    </div>
  );
}
