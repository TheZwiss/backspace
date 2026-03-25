import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGridLayout } from '../useGridLayout';

// --- ResizeObserver mock ---
let resizeCallback: ResizeObserverCallback | null = null;
let observedElements: Set<Element> = new Set();

class MockResizeObserver {
  constructor(cb: ResizeObserverCallback) {
    resizeCallback = cb;
  }
  observe(el: Element) { observedElements.add(el); }
  unobserve(el: Element) { observedElements.delete(el); }
  disconnect() { observedElements.clear(); }
}

function fireResize(el: Element, width: number, height: number) {
  if (!resizeCallback) return;
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true });
  resizeCallback([{ target: el } as ResizeObserverEntry], {} as ResizeObserver);
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', MockResizeObserver);
});

beforeEach(() => {
  resizeCallback = null;
  observedElements.clear();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('useGridLayout', () => {
  it('returns a stable callback ref', () => {
    const { result, rerender } = renderHook(() => useGridLayout(4));
    const ref1 = result.current.ref;
    rerender();
    expect(result.current.ref).toBe(ref1);
  });

  it('attaches observer when ref is called with an element', () => {
    const { result } = renderHook(() => useGridLayout(4));
    const el = document.createElement('div');

    act(() => { result.current.ref(el); });

    expect(observedElements.has(el)).toBe(true);
  });

  it('computes layout from element dimensions', () => {
    const { result } = renderHook(() => useGridLayout(4));
    const el = document.createElement('div');

    act(() => { result.current.ref(el); });
    act(() => { fireResize(el, 800, 600); });

    expect(result.current.tileWidth).toBeGreaterThan(0);
    expect(result.current.tileHeight).toBeGreaterThan(0);
    expect(result.current.cols).toBeGreaterThanOrEqual(1);
  });

  it('disconnects observer when ref is called with null', () => {
    const { result } = renderHook(() => useGridLayout(4));
    const el = document.createElement('div');

    act(() => { result.current.ref(el); });
    expect(observedElements.size).toBe(1);

    act(() => { result.current.ref(null); });
    expect(observedElements.size).toBe(0);
  });

  it('reattaches observer when element remounts (the critical bug scenario)', () => {
    const { result } = renderHook(() => useGridLayout(4));

    // Mount: grid mode
    const el1 = document.createElement('div');
    act(() => { result.current.ref(el1); });
    act(() => { fireResize(el1, 1920, 1080); });
    const fullscreenWidth = result.current.tileWidth;
    expect(fullscreenWidth).toBeGreaterThan(0);

    // Unmount: focus mode (grid div removed)
    act(() => { result.current.ref(null); });
    expect(observedElements.size).toBe(0);

    // Remount: back to grid mode with smaller container
    const el2 = document.createElement('div');
    act(() => { result.current.ref(el2); });
    act(() => { fireResize(el2, 800, 600); });

    // Layout must reflect the NEW element's dimensions, not stale fullscreen ones
    expect(result.current.tileWidth).toBeLessThan(fullscreenWidth);
    expect(observedElements.has(el2)).toBe(true);
    expect(observedElements.has(el1)).toBe(false);
  });

  it('does not observe when tileCount is 0', () => {
    const { result } = renderHook(() => useGridLayout(0));
    const el = document.createElement('div');

    act(() => { result.current.ref(el); });

    expect(observedElements.size).toBe(0);
  });
});
