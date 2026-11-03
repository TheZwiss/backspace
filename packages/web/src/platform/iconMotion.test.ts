import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installIconClickMotion } from './iconMotion';

describe('icon click feedback', () => {
  let stop: () => void;
  let reduced = false;
  let preferenceChanged: () => void;
  let animations: { cancel: ReturnType<typeof vi.fn>; finished: Promise<void> }[];
  const animate = vi.fn();
  beforeEach(() => {
    animations = [];
    reduced = false;
    vi.stubGlobal('matchMedia', vi.fn(() => ({ get matches() { return reduced; }, addEventListener: (_: string, callback: () => void) => { preferenceChanged = callback; }, removeEventListener: vi.fn() })));
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 24, height: 24 } as DOMRect);
    animate.mockReset().mockImplementation(() => {
      const animation = { cancel: vi.fn(), finished: new Promise<void>(() => {}) };
      animations.push(animation);
      return animation;
    });
    Object.defineProperty(Element.prototype, 'animate', { configurable: true, value: animate });
    document.body.innerHTML = '<button data-icon-motion="bell"><svg><path /></svg></button>';
    stop = installIconClickMotion();
  });
  afterEach(() => { stop(); document.body.innerHTML = ''; vi.restoreAllMocks(); vi.unstubAllGlobals(); delete (Element.prototype as Partial<Element>).animate; });
  const click = () => document.querySelector('button')!.click();

  it('animates only the icon and leaves the action synchronous', () => {
    const action = vi.fn();
    document.querySelector('button')!.addEventListener('click', action);
    click();
    expect(action).toHaveBeenCalledOnce();
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.instances[0]).toBe(document.querySelector('svg'));
    expect(animate.mock.calls[0][1].duration).toBe(240);
  });
  it('replaces repeated feedback rather than stacking animations', () => {
    for (let count = 0; count < 20; count++) click();
    expect(animations.slice(0, -1).every(animation => animation.cancel.mock.calls.length === 1)).toBe(true);
    expect(animations.at(-1)!.cancel).not.toHaveBeenCalled();
  });
  it('respects reduced motion and cancels feedback when the preference changes', () => {
    click(); reduced = true; preferenceChanged(); click();
    expect(animate).toHaveBeenCalledOnce();
    expect(animations[0].cancel).toHaveBeenCalledOnce();
  });
  it('skips disabled, busy and unmarked controls', () => {
    const button = document.querySelector('button')!;
    button.disabled = true; click(); button.disabled = false;
    button.setAttribute('aria-busy', 'true'); click(); button.removeAttribute('aria-busy');
    button.removeAttribute('data-icon-motion'); click();
    expect(animate).not.toHaveBeenCalled();
  });
  it('skips hidden, large decorative and loading icons', () => {
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({ width: 0, height: 0 } as DOMRect); click();
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({ width: 300, height: 300 } as DOMRect); click();
    vi.mocked(Element.prototype.getBoundingClientRect).mockReturnValue({ width: 24, height: 24 } as DOMRect);
    document.querySelector('svg')!.classList.add('animate-spin'); click();
    expect(animate).not.toHaveBeenCalled();
  });
  it('animates a clickable avatar itself, including avatars without photos', () => {
    document.body.innerHTML = '<div data-icon-motion="press" data-icon-motion-target>AB</div>';
    const avatar = document.querySelector('div')!;
    avatar.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(animate.mock.instances[0]).toBe(avatar);
  });
  it('keeps feedback on the nearest interactive control', () => {
    document.body.innerHTML = '<div data-icon-motion="bell"><button data-icon-motion="pulse"><svg /></button><svg /></div>';
    click();
    expect(animate).toHaveBeenCalledOnce();
    expect(animate.mock.calls[0][1].duration).toBe(200);
  });
  it('removes listeners and cancels animations on cleanup', () => {
    click(); stop(); click();
    expect(animate).toHaveBeenCalledOnce(); expect(animations[0].cancel).toHaveBeenCalledOnce();
  });
});
