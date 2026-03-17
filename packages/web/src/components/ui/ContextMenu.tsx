import React, { useEffect, useRef, useState } from 'react';
import { useUIStore } from '../../stores/uiStore';

interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  icon?: React.ReactNode;
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  children: React.ReactNode;
}

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const menuRef = useRef<HTMLDivElement>(null);
  const isMobile = useUIStore((s) => s.isMobile);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setPosition({ x: e.clientX, y: e.clientY });
    setIsOpen(true);
  };

  useEffect(() => {
    const handleClick = () => setIsOpen(false);
    const handleScroll = () => setIsOpen(false);

    if (isOpen) {
      document.addEventListener('click', handleClick);
      document.addEventListener('scroll', handleScroll, true);
      return () => {
        document.removeEventListener('click', handleClick);
        document.removeEventListener('scroll', handleScroll, true);
      };
    }
  }, [isOpen]);

  // Adjust position to keep menu in viewport
  useEffect(() => {
    if (isOpen && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      const newPosition = { ...position };

      if (rect.right > window.innerWidth) {
        newPosition.x = window.innerWidth - rect.width - 8;
      }
      if (rect.bottom > window.innerHeight) {
        newPosition.y = window.innerHeight - rect.height - 8;
      }
      if (newPosition.x < 8) newPosition.x = 8;
      if (newPosition.y < 8) newPosition.y = 8;

      if (newPosition.x !== position.x || newPosition.y !== position.y) {
        setPosition(newPosition);
      }
    }
  }, [isOpen, position]);

  return (
    <>
      <div onContextMenu={handleContextMenu}>{children}</div>
      {isOpen && isMobile && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-[300] bg-black/50" onClick={() => setIsOpen(false)} />
          {/* Bottom sheet menu */}
          <div
            className="fixed bottom-0 left-0 right-0 z-[301] rounded-t-2xl glass-bubble animate-slide-up-sheet"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1" />
            <div className="py-1">
              {items.map((item, i) => (
                <button
                  key={i}
                  className={`w-full text-left px-5 py-3 text-sm flex items-center gap-3 ${
                    item.danger ? 'text-txt-danger' : 'text-txt-primary'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    item.onClick();
                    setIsOpen(false);
                  }}
                >
                  {item.icon && <span className="w-5 h-5">{item.icon}</span>}
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      {isOpen && !isMobile && (
        <div
          ref={menuRef}
          className="fixed z-[200] min-w-[180px] py-1.5 glass rounded-md animate-fade-in max-h-[calc(100vh-16px)] overflow-y-auto scrollbar-thin"
          style={{ left: position.x, top: position.y }}
        >
          {items.map((item, i) => (
            <button
              key={i}
              className={`w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 ${
                item.danger
                  ? 'text-txt-danger hover:bg-accent-rose hover:text-white'
                  : 'text-txt-secondary hover:bg-accent-primary hover:text-white'
              }`}
              style={{ width: 'calc(100% - 12px)' }}
              onClick={(e) => {
                e.stopPropagation();
                item.onClick();
                setIsOpen(false);
              }}
            >
              {item.icon && <span className="w-4 h-4">{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}
