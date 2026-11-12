import { useInterfaceScaleStore } from '../stores/interfaceScaleStore';
import { isElectron } from './platform';

/** DOM rects and pointer events are visual pixels; CSS positions are unzoomed. */
export function layoutPixels(value: number): number {
  return value / (useInterfaceScaleStore.getState().scale / 100);
}

/** Convert layout constants to the visual coordinates used by DOM anchors. */
export function visualPixels(value: number): number {
  return value * (useInterfaceScaleStore.getState().scale / 100);
}

/** Below this many layout pixels the app shell is MobileShell, not AppLayout. */
export const MOBILE_LAYOUT_BREAKPOINT = 768;

/** Physically narrow viewports stay mobile at any scale. Phones are 390-430px. */
export const NARROW_VIEWPORT_BREAKPOINT = 600;

/**
 * A phone turned on its side is 640-930px wide but under ~430px tall. Below this
 * physical height a touch device stays in MobileShell: the desktop shell does not
 * fit (28px controls, three columns in 400px) and crossing into it on rotation
 * threw away the screen the person was on, a call included. A tablet on its side
 * is 768px or more tall and keeps the desktop shell.
 */
export const LANDSCAPE_PHONE_MAX_HEIGHT = 500;

/** The primary input is a finger. A desktop window with a mouse is never "a phone", however short. */
function hasCoarsePrimaryPointer(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
}

export function isMobileViewport(): boolean {
  // Zooming out must not turn a physically narrow phone into the desktop shell.
  return window.innerWidth < NARROW_VIEWPORT_BREAKPOINT
    || layoutPixels(window.innerWidth) < MOBILE_LAYOUT_BREAKPOINT
    || (window.innerHeight < LANDSCAPE_PHONE_MAX_HEIGHT && hasCoarsePrimaryPointer());
}

export function layoutRect<T extends { top: number; right: number; bottom: number; left: number; width: number; height: number }>(rect: T) {
  return {
    top: layoutPixels(rect.top), right: layoutPixels(rect.right),
    bottom: layoutPixels(rect.bottom), left: layoutPixels(rect.left),
    width: layoutPixels(rect.width), height: layoutPixels(rect.height),
  };
}

/** Apply before React mounts, so persisted scale also covers login and portals. */
export function initializeInterfaceScale(): () => void {
  const updateViewport = () => {
    document.documentElement.dataset.viewport = isMobileViewport() ? 'mobile' : 'desktop';
  };
  const apply = () => {
    const factor = useInterfaceScaleStore.getState().scale / 100;
    document.documentElement.style.zoom = String(factor);
    document.documentElement.style.setProperty('--interface-scale', String(factor));
    // Native controls do not participate in CSS zoom. Share their full inset
    // (32px drag region + 1px separator) across normal layout and fixed overlays.
    document.documentElement.style.setProperty('--titlebar-inset', isElectron()
      ? 'calc(33px / var(--interface-scale))' : '0px');
    // CSS zoom does not fire resize, but positioning and mobile-layout hooks need it.
    window.dispatchEvent(new Event('resize'));
  };
  window.addEventListener('resize', updateViewport);
  apply();
  const unsubscribe = useInterfaceScaleStore.subscribe(apply);
  return () => {
    unsubscribe();
    window.removeEventListener('resize', updateViewport);
  };
}
