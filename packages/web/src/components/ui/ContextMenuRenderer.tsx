import React, { useEffect, useLayoutEffect, useRef, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useContextMenuStore,
  filterMenuItems,
  type ContextMenuItem,
  type ContextMenuLeafItem,
  type ContextMenuSubmenu,
} from '../../stores/contextMenuStore';
import { useUIStore } from '../../stores/uiStore';

// ── Desktop item button ──────────────────────────────────────────────────────

const ITEM_CLASS =
  'w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-secondary hover:bg-accent-primary hover:text-white';
const ITEM_DANGER_CLASS =
  'w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-danger hover:bg-accent-rose hover:text-white';
const ITEM_DISABLED_CLASS =
  'w-full text-left px-2 py-1.5 mx-1.5 text-sm rounded-sm flex items-center gap-2 text-txt-secondary opacity-50 cursor-default';
const ITEM_STYLE: React.CSSProperties = { width: 'calc(100% - 12px)' };

// ── Mobile item button ───────────────────────────────────────────────────────

const MOBILE_ITEM_CLASS = 'w-full text-left px-5 py-3 text-sm flex items-center gap-3';

// ── Checkbox indicator ───────────────────────────────────────────────────────

function CheckboxIndicator({ checked }: { checked: boolean }) {
  return (
    <div
      className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${
        checked ? 'bg-accent-primary border-accent-primary' : 'border-txt-tertiary'
      }`}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="white">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
        </svg>
      )}
    </div>
  );
}

// ── Desktop submenu flyout ───────────────────────────────────────────────────

interface SubmenuFlyoutProps {
  submenu: ContextMenuSubmenu;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  close: () => void;
}

function SubmenuFlyout({ submenu, triggerRef, onMouseEnter, onMouseLeave, close }: SubmenuFlyoutProps) {
  const flyoutRef = useRef<HTMLDivElement>(null);
  const filteredChildren = filterMenuItems(submenu.children);

  useLayoutEffect(() => {
    const flyout = flyoutRef.current;
    const trigger = triggerRef.current;
    if (!flyout || !trigger) return;

    const tRect = trigger.getBoundingClientRect();
    const fRect = flyout.getBoundingClientRect();
    const gap = 4;

    let left = tRect.right + gap;
    if (left + fRect.width > window.innerWidth) {
      left = tRect.left - fRect.width - gap;
    }
    if (left < 8) left = 8;

    let top = tRect.top;
    if (top + fRect.height > window.innerHeight - 8) {
      top = window.innerHeight - fRect.height - 8;
    }
    if (top < 8) top = 8;

    flyout.style.left = `${left}px`;
    flyout.style.top = `${top}px`;
  }, [triggerRef]);

  if (filteredChildren.length === 0) return null;

  return createPortal(
    <div
      ref={flyoutRef}
      className="fixed z-[210] glass rounded-md py-1.5 min-w-[160px] overflow-y-auto scrollbar-thin animate-fade-in"
      style={{ left: -9999, top: -9999 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {filteredChildren.map((child) => (
        <DesktopLeafItem key={child.key} item={child} close={close} />
      ))}
    </div>,
    document.body,
  );
}

// ── Desktop leaf item ────────────────────────────────────────────────────────

interface DesktopLeafItemProps {
  item: ContextMenuLeafItem;
  close: () => void;
}

function DesktopLeafItem({ item, close }: DesktopLeafItemProps) {
  switch (item.type) {
    case 'separator':
      return <div className="h-px bg-white/[0.06] my-1 mx-1.5" />;

    case 'custom':
      return <div>{item.render()}</div>;

    case 'checkbox':
      return (
        <button
          className={ITEM_CLASS}
          style={ITEM_STYLE}
          onClick={(e) => {
            e.stopPropagation();
            item.onChange(!item.checked);
          }}
        >
          <span className="flex-1">{item.label}</span>
          <CheckboxIndicator checked={item.checked} />
        </button>
      );

    case 'action': {
      const className = item.disabled
        ? ITEM_DISABLED_CLASS
        : item.danger
          ? ITEM_DANGER_CLASS
          : ITEM_CLASS;
      return (
        <button
          className={className}
          style={ITEM_STYLE}
          disabled={item.disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (item.disabled) return;
            item.onClick();
            close();
          }}
        >
          {item.icon && <span className="w-4 h-4">{item.icon}</span>}
          {item.label}
        </button>
      );
    }
  }
}

// ── Desktop submenu trigger item ─────────────────────────────────────────────

interface DesktopSubmenuItemProps {
  item: ContextMenuSubmenu;
  close: () => void;
}

function DesktopSubmenuItem({ item, close }: DesktopSubmenuItemProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openSubmenuKey = useContextMenuStore((s) => s.openSubmenuKey);
  const setOpenSubmenu = useContextMenuStore((s) => s.setOpenSubmenu);
  const isOpen = openSubmenuKey === item.key;

  const cancelTimers = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);

  const handleTriggerEnter = useCallback(() => {
    cancelTimers();
    openTimer.current = setTimeout(() => {
      setOpenSubmenu(item.key);
    }, 150);
  }, [cancelTimers, setOpenSubmenu, item.key]);

  const handleTriggerLeave = useCallback(() => {
    cancelTimers();
    closeTimer.current = setTimeout(() => {
      setOpenSubmenu(null);
    }, 150);
  }, [cancelTimers, setOpenSubmenu]);

  const handleFlyoutEnter = useCallback(() => {
    cancelTimers();
  }, [cancelTimers]);

  const handleFlyoutLeave = useCallback(() => {
    cancelTimers();
    closeTimer.current = setTimeout(() => {
      setOpenSubmenu(null);
    }, 150);
  }, [cancelTimers, setOpenSubmenu]);

  useEffect(() => {
    return () => {
      cancelTimers();
    };
  }, [cancelTimers]);

  return (
    <>
      <button
        ref={triggerRef}
        className={ITEM_CLASS}
        style={ITEM_STYLE}
        onMouseEnter={handleTriggerEnter}
        onMouseLeave={handleTriggerLeave}
      >
        {item.icon && <span className="w-4 h-4">{item.icon}</span>}
        <span className="flex-1">{item.label}</span>
        <span className="text-txt-tertiary text-xs ml-auto">{'\u203A'}</span>
      </button>
      {isOpen && (
        <SubmenuFlyout
          submenu={item}
          triggerRef={triggerRef}
          onMouseEnter={handleFlyoutEnter}
          onMouseLeave={handleFlyoutLeave}
          close={close}
        />
      )}
    </>
  );
}

// ── Desktop menu item dispatcher ─────────────────────────────────────────────

interface DesktopMenuItemProps {
  item: ContextMenuItem;
  close: () => void;
}

function DesktopMenuItem({ item, close }: DesktopMenuItemProps) {
  if (item.type === 'submenu') {
    return <DesktopSubmenuItem item={item} close={close} />;
  }
  return <DesktopLeafItem item={item} close={close} />;
}

// ── Desktop menu panel ───────────────────────────────────────────────────────

interface DesktopMenuProps {
  items: ContextMenuItem[];
  position: { x: number; y: number };
  close: () => void;
  closeGuard: boolean;
}

function DesktopMenu({ items, position, close, closeGuard }: DesktopMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Viewport-aware positioning via direct DOM mutation
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = position.x;
    let y = position.y;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    if (x < 8) x = 8;
    if (y < 8) y = 8;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, [position]);

  // Auto-focus on mount for keyboard nav
  useEffect(() => {
    menuRef.current?.focus();
  }, []);

  // Dismiss on scroll/resize
  useEffect(() => {
    const dismiss = () => close();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [close]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const container = menuRef.current;
      if (!container) return;

      const focusableSelector = 'button:not([disabled])';

      if (e.key === 'Escape') {
        e.preventDefault();
        // Close submenu first if open, otherwise close the whole menu
        const openSubmenuKey = useContextMenuStore.getState().openSubmenuKey;
        if (openSubmenuKey) {
          useContextMenuStore.getState().setOpenSubmenu(null);
        } else {
          close();
        }
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const buttons = Array.from(container.querySelectorAll<HTMLElement>(focusableSelector));
        if (buttons.length === 0) return;
        const currentIndex = buttons.indexOf(document.activeElement as HTMLElement);
        let nextIndex: number;
        if (e.key === 'ArrowDown') {
          nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % buttons.length;
        } else {
          nextIndex = currentIndex <= 0 ? buttons.length - 1 : currentIndex - 1;
        }
        buttons[nextIndex]?.focus();
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement && container.contains(focused)) {
          focused.click();
        }
        return;
      }

      if (e.key === 'ArrowRight') {
        // Open submenu if focused item is a submenu trigger
        e.preventDefault();
        const focused = document.activeElement;
        if (focused instanceof HTMLButtonElement) {
          // Simulate mouse enter to open the submenu
          focused.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const openSubmenuKey = useContextMenuStore.getState().openSubmenuKey;
        if (openSubmenuKey) {
          useContextMenuStore.getState().setOpenSubmenu(null);
        }
        return;
      }
    },
    [close],
  );

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[199]"
        onMouseDown={(e) => {
          if (!closeGuard) {
            close();
          }
        }}
        onContextMenu={(e) => {
          // Prevent browser context menu but do NOT stopPropagation.
          // This allows right-clicks to reach underlying elements that may
          // open a new context menu via their own onContextMenu handler.
          e.preventDefault();
        }}
      />
      {/* Menu panel */}
      <div
        ref={menuRef}
        tabIndex={-1}
        className="fixed z-[200] min-w-[180px] py-1.5 glass rounded-md animate-fade-in max-h-[calc(100vh-16px)] overflow-y-auto scrollbar-thin outline-none"
        style={{ left: position.x, top: position.y }}
        onKeyDown={handleKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <DesktopMenuItem key={item.key} item={item} close={close} />
        ))}
      </div>
    </>,
    document.body,
  );
}

// ── Mobile leaf item ─────────────────────────────────────────────────────────

interface MobileLeafItemProps {
  item: ContextMenuLeafItem;
  close: () => void;
}

function MobileLeafItem({ item, close }: MobileLeafItemProps) {
  switch (item.type) {
    case 'separator':
      return <div className="h-px bg-white/[0.06] my-1 mx-1.5" />;

    case 'custom':
      return <div>{item.render()}</div>;

    case 'checkbox':
      return (
        <button
          className={`${MOBILE_ITEM_CLASS} text-txt-primary`}
          onClick={(e) => {
            e.stopPropagation();
            item.onChange(!item.checked);
          }}
        >
          <span className="flex-1">{item.label}</span>
          <CheckboxIndicator checked={item.checked} />
        </button>
      );

    case 'action': {
      const colorClass = item.danger ? 'text-txt-danger' : 'text-txt-primary';
      return (
        <button
          className={`${MOBILE_ITEM_CLASS} ${colorClass} ${item.disabled ? 'opacity-50' : ''}`}
          disabled={item.disabled}
          onClick={(e) => {
            e.stopPropagation();
            if (item.disabled) return;
            item.onClick();
            close();
          }}
        >
          {item.icon && <span className="w-5 h-5">{item.icon}</span>}
          {item.label}
        </button>
      );
    }
  }
}

// ── Mobile bottom sheet menu ─────────────────────────────────────────────────

interface MobileMenuProps {
  items: ContextMenuItem[];
  close: () => void;
}

function MobileMenu({ items, close }: MobileMenuProps) {
  const [submenuStack, setSubmenuStack] = useState<ContextMenuSubmenu | null>(null);

  // Dismiss on scroll/resize
  useEffect(() => {
    const dismiss = () => close();
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => {
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
    };
  }, [close]);

  // Determine what items to render: root or submenu
  const currentItems: ReadonlyArray<ContextMenuLeafItem | ContextMenuItem> = submenuStack
    ? filterMenuItems(submenuStack.children)
    : items;

  return createPortal(
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-[300] bg-black/50" onClick={close} />
      {/* Bottom sheet */}
      <div
        className="fixed bottom-0 left-0 right-0 z-[301] rounded-t-2xl glass-bubble animate-slide-up-sheet"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1" />
        {/* Back button for submenu */}
        {submenuStack && (
          <button
            className={`${MOBILE_ITEM_CLASS} text-txt-secondary`}
            onClick={() => setSubmenuStack(null)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="flex-shrink-0">
              <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z" />
            </svg>
            <span>Back</span>
          </button>
        )}
        <div className="py-1">
          {currentItems.map((item) => {
            if (item.type === 'submenu') {
              // Render submenu trigger as a button that switches sheet content
              const colorClass = 'text-txt-primary';
              return (
                <button
                  key={item.key}
                  className={`${MOBILE_ITEM_CLASS} ${colorClass}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    setSubmenuStack(item);
                  }}
                >
                  {item.icon && <span className="w-5 h-5">{item.icon}</span>}
                  <span className="flex-1">{item.label}</span>
                  <span className="text-txt-tertiary text-sm">{'\u203A'}</span>
                </button>
              );
            }
            return <MobileLeafItem key={item.key} item={item as ContextMenuLeafItem} close={close} />;
          })}
        </div>
      </div>
    </>,
    document.body,
  );
}

// ── Global long-press → contextmenu for mobile ──────────────────────────────

/**
 * Adds document-level touch listeners that detect long-press (500ms hold,
 * < 10px movement) and dispatch a synthetic `contextmenu` event on the
 * touched element. This allows ALL existing onContextMenu handlers to work
 * on touch devices without per-component changes.
 */
function useGlobalLongPress(isMobile: boolean) {
  useEffect(() => {
    if (!isMobile) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let originX = 0;
    let originY = 0;
    let fired = false;
    let activeTarget: EventTarget | null = null;

    const cancel = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { cancel(); return; }
      const touch = e.touches[0]!;
      originX = touch.clientX;
      originY = touch.clientY;
      fired = false;
      activeTarget = e.target;

      timer = setTimeout(() => {
        timer = null;
        fired = true;
        // Clear any native text selection that started during the hold
        window.getSelection()?.removeAllRanges();
        // Dispatch synthetic contextmenu on the original target.
        // React's event delegation picks it up and fires onContextMenu handlers.
        const syntheticEvent = new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          clientX: originX,
          clientY: originY,
          screenX: originX,
          screenY: originY,
        });
        if (activeTarget) {
          activeTarget.dispatchEvent(syntheticEvent);
        }
      }, 500);
    };

    const onTouchMove = (e: TouchEvent) => {
      if (timer === null) return;
      const touch = e.touches[0];
      if (!touch) return;
      if (Math.hypot(touch.clientX - originX, touch.clientY - originY) > 10) cancel();
    };

    const onTouchEnd = () => {
      cancel();
      if (fired) {
        const suppressClick = (ev: MouseEvent) => {
          ev.preventDefault();
          ev.stopPropagation();
        };
        document.addEventListener('click', suppressClick, { capture: true, once: true });
        setTimeout(() => {
          document.removeEventListener('click', suppressClick, { capture: true });
        }, 500);
        fired = false;
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchEnd, { passive: true });

    return () => {
      cancel();
      document.removeEventListener('touchstart', onTouchStart);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);
      document.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [isMobile]);
}

// ── Main renderer ────────────────────────────────────────────────────────────

export function ContextMenuRenderer() {
  const menu = useContextMenuStore((s) => s.menu);
  const close = useContextMenuStore((s) => s.close);
  const closeGuard = useContextMenuStore((s) => s.closeGuard);
  const isMobile = useUIStore((s) => s.isMobile);

  // Global long-press detection — enables context menus on all touch targets
  useGlobalLongPress(isMobile);

  if (!menu) return null;

  const filteredItems = filterMenuItems(menu.items);
  if (filteredItems.length === 0) return null;

  if (isMobile) {
    return <MobileMenu items={filteredItems} close={close} />;
  }

  return (
    <DesktopMenu
      items={filteredItems}
      position={menu.position}
      close={close}
      closeGuard={closeGuard}
    />
  );
}
