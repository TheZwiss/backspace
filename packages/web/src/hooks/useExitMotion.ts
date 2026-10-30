import { useLayoutEffect, type RefObject } from 'react';

/** Let React dismiss immediately; only a short, inert visual copy fades out.
 * No handlers, focusable controls, media playback or application state survive.
 */
export function useExitMotion(ref: RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    return () => {
      const doc = element.ownerDocument;
      const view = doc.defaultView;
      if (!element.isConnected || !view?.matchMedia || !element.animate) return;
      const preference = view.matchMedia('(prefers-reduced-motion: reduce)');
      if (preference.matches) return;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const opacity = view.getComputedStyle(element).opacity;
      // StrictMode replays layout-effect cleanup while the real node stays mounted.
      view.queueMicrotask(() => {
        if (element.isConnected || preference.matches) return;
        const copy = element.cloneNode(true) as HTMLElement;
        copy.setAttribute('inert', '');
        copy.setAttribute('aria-hidden', 'true');
        copy.setAttribute('data-motion-exit', '');
        for (const node of [copy, ...copy.querySelectorAll<HTMLElement>('*')]) {
          node.removeAttribute('id');
          node.removeAttribute('autofocus');
          node.style.setProperty('animation', 'none', 'important');
          node.style.setProperty('transition', 'none', 'important');
        }
        for (const media of copy.querySelectorAll('audio, video')) {
          media.removeAttribute('src');
          media.removeAttribute('autoplay');
          media.querySelectorAll('source').forEach((source) => source.remove());
        }
        copy.querySelectorAll('iframe').forEach((frame) => frame.remove());
        Object.assign(copy.style, {
          position: 'fixed', left: `${rect.left}px`, top: `${rect.top}px`,
          width: `${rect.width}px`, height: `${rect.height}px`, margin: '0',
          maxHeight: 'none', maxWidth: 'none', transform: 'none',
        });
        copy.style.setProperty('pointer-events', 'none', 'important');
        for (const child of copy.querySelectorAll<HTMLElement>('*')) {
          child.style.setProperty('pointer-events', 'none', 'important');
        }
        const container = doc.fullscreenElement ?? doc.body;
        container.appendChild(copy);
        const animation = copy.animate([{ opacity }, { opacity: 0 }], {
          duration: 120, easing: 'ease-out',
        });
        const remove = () => {
          view.clearTimeout(timer);
          preference.removeEventListener('change', stop);
          copy.remove();
        };
        const stop = () => { animation.cancel(); remove(); };
        const timer = view.setTimeout(stop, 180);
        animation.onfinish = remove;
        animation.oncancel = remove;
        preference.addEventListener('change', stop);
      });
    };
  }, [ref]);
}
