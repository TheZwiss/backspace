import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleOverlayPopState, registerBackDismiss, resetOverlayBack } from './overlayBack';
import { useUIStore } from '../stores/uiStore';

/** jsdom runs history traversal asynchronously and fires `popstate` itself. */
function nextPopState(): Promise<void> {
  return new Promise((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** What the shell does: overlays first, then the screen stack. */
let screenPops = 0;
const shell = () => { if (handleOverlayPopState()) return; screenPops++; };

beforeEach(() => {
  resetOverlayBack();
  screenPops = 0;
  window.history.replaceState({ key: 'base' }, '', '/channels/@me');
  useUIStore.setState({ isMobile: true, mobileStack: [] });
  window.addEventListener('popstate', shell);
});

afterEach(() => {
  window.removeEventListener('popstate', shell);
  resetOverlayBack();
});

describe('Back closes the overlay, not the screen', () => {
  it('pushes a marker with the same URL and the router state kept', async () => {
    expect(window.history.state).not.toHaveProperty('__overlayId');
    const unregister = registerBackDismiss(() => {});
    await tick();
    expect(window.history.state).toHaveProperty('__overlayId');
    expect(window.location.pathname).toBe('/channels/@me');
    expect(window.history.state).toMatchObject({ key: 'base' });
    unregister();
    await tick();
  });

  it('dismisses the top overlay on Back and leaves the screen stack alone', async () => {
    const close = vi.fn();
    registerBackDismiss(close);
    await tick();
    const popped = nextPopState();
    window.history.back();
    await popped;
    await tick();
    expect(close).toHaveBeenCalledTimes(1);
    expect(screenPops).toBe(0);
  });

  it('dismisses overlays one at a time, newest first', async () => {
    const order: string[] = [];
    registerBackDismiss(() => order.push('first'));
    await tick();
    registerBackDismiss(() => order.push('second'));
    await tick();
    for (let i = 0; i < 2; i++) { const p = nextPopState(); window.history.back(); await p; await tick(); }
    expect(order).toEqual(['second', 'first']);
    expect(screenPops).toBe(0);
  });

  it('takes its marker off the history when the overlay closes by itself', async () => {
    const unregister = registerBackDismiss(() => {});
    await tick();
    expect(window.history.state).toHaveProperty('__overlayId');
    const popped = nextPopState();
    unregister();
    await popped;
    await tick();
    expect(screenPops).toBe(0); // the echo is swallowed, not read as a Back press
    expect((window.history.state as Record<string, unknown>)?.key).toBe('base');
    expect(window.history.state).not.toHaveProperty('__overlayId');
  });

  it('lets the next Back through to the shell once the overlay is gone', async () => {
    const unregister = registerBackDismiss(() => {});
    await tick();
    const echo = nextPopState();
    unregister();
    await echo; await tick();
    // A screen to pop: a real Back reaches the shell
    useUIStore.setState({ mobileStack: [{ screen: 'settings' }] });
    window.history.pushState({ mobileScreen: 'settings' }, '');
    const popped = nextPopState();
    window.history.back();
    await popped;
    expect(screenPops).toBe(1);
  });

  it('does not undo a screen pushed over the marker by the closing handler', async () => {
    const unregister = registerBackDismiss(() => {});
    await tick();
    // The sheet closes and, in the same handler, opens a screen over its marker
    unregister();
    window.history.pushState({ mobileScreen: 'explore' }, '');
    await tick(); await tick();
    expect(window.history.state).toMatchObject({ mobileScreen: 'explore' });
  });

  it('steps over a dead marker when there is nothing to pop', async () => {
    const unregister = registerBackDismiss(() => {});
    await tick();
    unregister();
    window.history.pushState({ mobileScreen: 'explore' }, '');   // marker stays underneath
    await tick(); await tick();
    useUIStore.setState({ mobileStack: [] });
    const popped = nextPopState();
    window.history.back();  // lands on the dead marker
    await popped; await tick(); await tick();
    expect(screenPops).toBe(0);
    expect(window.history.state).not.toHaveProperty('__overlayId');
  });

  it('registers nothing while its StrictMode replay unregisters in the same tick', async () => {
    const closeSecond = vi.fn();
    const first = registerBackDismiss(() => {});
    first();                                   // StrictMode cleanup
    registerBackDismiss(closeSecond);
    await tick();
    expect(window.history.state).toHaveProperty('__overlayId');
    // One marker, not two: a single Back lands on the entry below it
    const popped = nextPopState();
    window.history.back();
    await popped; await tick();
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(window.history.state).not.toHaveProperty('__overlayId');
    expect(screenPops).toBe(0);
  });
});
