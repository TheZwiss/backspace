/** Install feedback only on explicitly marked interactive controls. */
export function installIconMotion(doc, definitions) {
  const view = doc.defaultView;
  if (!view) return () => {};
  const preference = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const active = new Map();
  let stopped = false;
  const cancelAll = () => { for (const animation of active.values()) animation.cancel(); active.clear(); };
  const onPreferenceChange = () => { if (preference?.matches) cancelAll(); };
  const eligible = (element, control) => {
    if (element.closest('[data-icon-motion]') !== control || element.closest('[data-icon-motion-ignore]')) return false;
    if (element.classList.contains('animate-spin') || element.closest('[role="progressbar"]')) return false;
    const rect = element.getBoundingClientRect();
    const max = element.hasAttribute('data-icon-motion-target') ? 128 : 64;
    return rect.width > 0 && rect.height > 0 && rect.width <= max && rect.height <= max;
  };
  const click = event => {
    if (stopped || preference?.matches) return;
    const control = event.composedPath().find(node => node instanceof view.Element && node.hasAttribute('data-icon-motion'));
    if (!control || control.dataset.iconMotion === 'none' || control.matches(':disabled') || control.closest('[aria-disabled="true"], [aria-busy="true"], [inert]')) return;
    const clickedIcon = event.target instanceof view.Element ? event.target.closest('svg, [data-icon-motion-target], img') : null;
    const icon = clickedIcon && control.contains(clickedIcon) && eligible(clickedIcon, control) ? clickedIcon : [...(control.hasAttribute('data-icon-motion-target') ? [control] : []), ...control.querySelectorAll('svg, [data-icon-motion-target], img')].find(element => eligible(element, control));
    if (!icon || typeof icon.animate !== 'function') return;
    const family = icon.getAttribute('data-icon-motion-family') || control.dataset.iconMotion || 'press';
    const definition = definitions[family] || definitions.press;
    if (!definition) return;
    active.get(icon)?.cancel();
    try {
      const frames = definition.keyframes.map(frame => ({ transformOrigin: '50% 50%', transformBox: 'fill-box', ...frame }));
      const animation = icon.animate(frames, { duration: definition.duration, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'none' });
      active.set(icon, animation);
      const done = () => { if (active.get(icon) === animation) active.delete(icon); };
      void animation.finished.then(done, done);
    } catch { active.delete(icon); }
  };
  doc.addEventListener('click', click, true);
  if (preference?.addEventListener) preference.addEventListener('change', onPreferenceChange);
  else preference?.addListener?.(onPreferenceChange);
  return () => {
    stopped = true; doc.removeEventListener('click', click, true); cancelAll();
    if (preference?.removeEventListener) preference.removeEventListener('change', onPreferenceChange);
    else preference?.removeListener?.(onPreferenceChange);
  };
}
