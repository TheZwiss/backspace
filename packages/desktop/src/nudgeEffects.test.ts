import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { buildNudgeAnimation, type NudgeEffect } from './nudgeEffects';

describe('nudge animation programs', () => {
  afterEach(() => vi.useRealTimers());
  it('plays the original knock movie and waits for its end', async () => {
    vi.useFakeTimers();
    let ended: (() => void) | undefined;
    const video = { style: {}, volume: 0, currentTime: -1,
      addEventListener: vi.fn((_name, callback) => { ended = callback; }),
      play: vi.fn(async () => { ended?.(); }),
    };
    const image = { animate: vi.fn() };
    const document = { querySelector: (selector: string) => selector === 'video' ? video : image };
    const script = buildNudgeAnimation('knock', Date.now() + 150, []);
    const done = new Function('document', `return ${script}`)(document);
    await vi.runAllTimersAsync();
    await done;
    expect(video.play).toHaveBeenCalledOnce();
    expect(video.currentTime).toBe(0);
    expect(image.animate).not.toHaveBeenCalled();
  });
  it.each<[NudgeEffect, number]>([['shake', 0], ['wave', 24], ['jelly', 0], ['knock', 0], ['confetti', 48], ['pulse', 1]])(
    '%s completes and allocates only its expected layers', async (effect, expectedLayers) => {
      vi.useFakeTimers();
      const animations: Array<{ finished: Promise<void>; currentTime: number }> = [];
      const nodes: unknown[] = [];
      interface FakeNode { style: Record<string, unknown>; append: Mock; cloneNode: () => FakeNode; animate: Mock }
      const makeNode = (): FakeNode => ({ style: {}, append: vi.fn(), cloneNode: () => makeNode(), animate: vi.fn((frames: unknown[], options: { duration: number }) => {
        expect(options.duration).toBe(2000);
        expect(frames.length).toBeGreaterThan(1);
        const animation = { finished: Promise.resolve(), currentTime: 0 };
        animations.push(animation);
        return animation;
      }) });
      const image = makeNode();
      const document = { querySelector: (selector: string) => selector === 'img' ? image : null, createElement: makeNode, body: { append: (node: unknown) => nodes.push(node) } };
      const start = Date.now() + 150;
      const script = buildNudgeAnimation(effect, start, [{ transform: 'translateX(0)' }, { transform: 'translateX(5px)' }]);
      const done = new Function('document', 'innerWidth', 'innerHeight', `return ${script}`)(document, 1920, 1080);
      await vi.runAllTimersAsync();
      await done;
      expect(nodes).toHaveLength(expectedLayers);
      expect(animations.length).toBeGreaterThan(0);
      expect(animations.every(a => a.currentTime === 0)).toBe(true);
    },
  );
});
