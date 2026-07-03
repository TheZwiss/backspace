import React from 'react';
import { useUIStore } from '../../stores/uiStore';

export function MobileNav() {
  const isMobile = useUIStore((s) => s.isMobile);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const sidebarOpen = useUIStore((s) => s.sidebarOpen);

  if (!isMobile) return null;

  return (
    <>
      {/* Hamburger button in header */}
      <button
        onClick={toggleSidebar}
        className="fixed top-3 left-3 z-[120] p-1.5 rounded bg-surface-channel text-txt-primary md:hidden"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          {sidebarOpen ? (
            <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
          ) : (
            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
          )}
        </svg>
      </button>

      {/* Backdrop when sidebar is open on mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-[35] md:hidden"
          onClick={toggleSidebar}
        />
      )}
    </>
  );
}
