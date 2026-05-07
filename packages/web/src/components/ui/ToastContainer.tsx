import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';

const borderColors = {
  info: 'border-l-accent-sky',
  warning: 'border-l-accent-amber',
  success: 'border-l-accent-mint',
} as const;

/**
 * Resolve the bottom-edge offset for the toast stack on mobile.
 *
 * Mobile layout has up to three pieces of bottom chrome that toasts must
 * clear, depending on what's visible:
 *
 *  - Bottom nav (`MobileBottomNav`): 56px + safe-area-inset-bottom — visible
 *    when the screen stack is empty.
 *  - Voice mini-bar (`MobileVoiceMiniBar`): ~56px on top of whatever sits
 *    below it — visible whenever a voice channel is connected and `voice-full`
 *    is NOT the topmost screen.
 *  - Voice fullscreen control bar (`MobileVoiceFullScreen`): ~72px including
 *    its `mb-2 + safe-area-inset-bottom` — visible only when `voice-full` is
 *    the topmost screen, and the bottom nav + mini-bar are both hidden in
 *    that mode.
 *
 * Returns a CSS bottom offset value (string with units) that lifts the toast
 * stack above whichever chrome is currently rendered, plus an extra 12px of
 * breathing room.
 */
function resolveMobileBottomOffset(
  hasStack: boolean,
  topScreen: string | null,
  inVoice: boolean,
): string {
  // Voice fullscreen is on top: clear its control bar (mx-2 mb-2 round bar
  // with safe-area inset). Bottom nav + mini-bar are hidden in this mode.
  if (topScreen === 'voice-full') {
    return 'calc(72px + 12px + env(safe-area-inset-bottom))';
  }

  // Stack non-empty (some pushed screen other than voice-full): bottom nav is
  // hidden. Mini-bar is visible iff in voice.
  if (hasStack) {
    if (inVoice) {
      // Mini-bar (~56px + mb-1) sits at bottom alone.
      return 'calc(64px + 12px + env(safe-area-inset-bottom))';
    }
    return 'calc(12px + env(safe-area-inset-bottom))';
  }

  // Root tab (no stack). Bottom nav is visible. Mini-bar may also be present
  // above it.
  if (inVoice) {
    return 'calc(56px + 64px + 12px + env(safe-area-inset-bottom))';
  }
  return 'calc(56px + 12px + env(safe-area-inset-bottom))';
}

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts);
  const removeToast = useUIStore((s) => s.removeToast);
  const isMobile = useUIStore((s) => s.isMobile);
  const mobileStack = useUIStore((s) => s.mobileStack);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);

  if (toasts.length === 0) return null;

  const topScreen =
    mobileStack.length > 0 ? mobileStack[mobileStack.length - 1]?.screen ?? null : null;
  const inVoice = currentVoiceChannelId !== null;

  // Mobile: lift above bottom chrome and center horizontally so the toast
  // doesn't get cropped by `right-6` against narrow viewports. Desktop:
  // keep the existing `bottom-6 right-6` anchor.
  const containerStyle: React.CSSProperties = isMobile
    ? {
        position: 'fixed',
        left: '12px',
        right: '12px',
        bottom: resolveMobileBottomOffset(mobileStack.length > 0, topScreen, inVoice),
        zIndex: 300,
      }
    : { position: 'fixed', bottom: '24px', right: '24px', zIndex: 300 };

  return (
    <div
      className={
        isMobile
          ? 'flex flex-col gap-2 pointer-events-none items-center'
          : 'flex flex-col gap-2 pointer-events-none'
      }
      style={containerStyle}
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`glass-pill border-l-2 ${borderColors[toast.type]} rounded-[10px] px-4 py-2.5 max-w-[320px] animate-slide-up pointer-events-auto cursor-pointer`}
          onClick={() => removeToast(toast.id)}
        >
          <span className="text-sm text-txt-primary leading-snug">{toast.message}</span>
        </div>
      ))}
    </div>
  );
}
