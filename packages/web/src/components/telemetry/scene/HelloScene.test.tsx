import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HelloScene, type SceneMood } from './HelloScene';
import { SCENE_PALETTE } from './palette';

const MOODS: readonly SceneMood[] = ['idle', 'happy', 'farewell'];
const LAYERS = ['void', 'nebula', 'stars', 'ship', 'window', 'pilot', 'beam'];
const PARTS = ['arm', 'eyes', 'glow'];

// jsdom has neither window.matchMedia nor Element.prototype.animate. Install
// both the way src/test/setup.ts installs its stubs, so each test can choose
// the motion preference and count the animations the scene starts.
function installMatchMedia(reduce: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    value: (query: string): MediaQueryList => ({
      matches: reduce && query.includes('prefers-reduced-motion'),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
    configurable: true,
    writable: true,
  });
}

function installAnimate(): ReturnType<typeof vi.fn> {
  const animate = vi.fn(() => ({
    cancel: () => {},
    finished: Promise.resolve(),
    playState: 'running',
  }));
  Object.defineProperty(Element.prototype, 'animate', {
    value: animate,
    configurable: true,
    writable: true,
  });
  return animate;
}

function renderScene(mood: SceneMood): SVGSVGElement {
  const { container } = render(<HelloScene mood={mood} />);
  const svg = container.querySelector('svg');
  if (!svg) throw new Error('scene did not render an svg');
  return svg;
}

describe('HelloScene', () => {
  let animate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    installMatchMedia(false);
    animate = installAnimate();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(MOODS)('renders the %s mood as a hidden, text-free svg with named layers', (mood) => {
    const svg = renderScene(mood);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('focusable')).toBe('false');
    expect(svg.getAttribute('viewBox')).toBe('0 0 480 320');
    expect(svg.getAttribute('data-mood')).toBe(mood);
    for (const layer of LAYERS) {
      expect(svg.querySelector(`g[data-layer="${layer}"]`), layer).not.toBeNull();
    }
    for (const part of PARTS) {
      expect(svg.querySelector(`[data-part="${part}"]`), part).not.toBeNull();
    }
    expect(svg.querySelectorAll('text').length).toBe(0);
    expect(svg.querySelectorAll('*').length).toBeLessThan(200);
    const styleText = svg.querySelector('style')?.textContent ?? '';
    expect(svg.textContent).toBe(styleText);
  });

  it('starts no choreography in idle and some in happy and farewell', () => {
    renderScene('idle');
    expect(animate).not.toHaveBeenCalled();
    renderScene('happy');
    const afterHappy = animate.mock.calls.length;
    expect(afterHappy).toBeGreaterThan(0);
    renderScene('farewell');
    expect(animate.mock.calls.length).toBeGreaterThan(afterHappy);
  });

  it('runs the choreography when the mood changes on a mounted scene', () => {
    const { rerender } = render(<HelloScene mood="idle" />);
    expect(animate).not.toHaveBeenCalled();
    rerender(<HelloScene mood="happy" />);
    expect(animate).toHaveBeenCalled();
  });

  it.each(MOODS)('starts no animation for %s when reduced motion is preferred', (mood) => {
    installMatchMedia(true);
    renderScene(mood);
    expect(animate).not.toHaveBeenCalled();
  });

  it('uses only palette colours, nothing pure black or white', () => {
    const svg = renderScene('happy');
    const markup = svg.outerHTML;
    const allowed = new Set(Object.values(SCENE_PALETTE).map((c) => c.toLowerCase()));
    const found = markup.match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(found.length).toBeGreaterThan(0);
    for (const colour of found) {
      // Gradient and filter references look like url(#id); only real colours count.
      if (markup.includes(`url(${colour})`)) continue;
      expect(allowed.has(colour.toLowerCase()), colour).toBe(true);
    }
    expect(allowed.has('#000000')).toBe(false);
    expect(allowed.has('#ffffff')).toBe(false);
    expect(markup).not.toMatch(/(["\s:])(black|white)(["\s;])/);
  });
});
