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

export function isMobileViewport(): boolean {
  // Zooming out must not turn a physically narrow phone into the desktop shell.
  return window.innerWidth < 600 || layoutPixels(window.innerWidth) < 768;
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
