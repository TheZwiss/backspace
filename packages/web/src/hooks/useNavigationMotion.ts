import { useLayoutEffect, useRef } from 'react';

/** Fade new navigation content without remounting editors, media or call state.
 * Opacity only: transforms would change the containing block of fixed overlays.
 */
export function useNavigationMotion(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    const view = element?.ownerDocument.defaultView;
    if (!element || !view?.matchMedia || !element.animate) return;
    const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
    if (preference.matches) return;
    const animation = element.animate([{ opacity: 0.72 }, { opacity: 1 }], {
      duration: 150,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
    });
    const cancel = () => animation.cancel();
    preference.addEventListener('change', cancel);
    return () => {
      preference.removeEventListener('change', cancel);
      cancel();
    };
  }, [key]);
  return ref;
}
