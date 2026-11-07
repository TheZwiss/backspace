import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { act, render } from '@testing-library/react';
import { MSN_WINK_EFFECTS } from '@backspace/shared';
import { NudgeEffectPreview, previewAssets } from './NudgeEffectPreview';

describe('NudgeEffectPreview', () => {
  it('draws the five screen effects as a miniature screen that only runs while active', () => {
    for (const effect of ['shake', 'wave', 'jelly', 'confetti', 'pulse'] as const) {
      const { container, rerender } = render(<NudgeEffectPreview effect={effect} active={false} />);
      const root = container.querySelector('.nudge-preview')!;
      expect(root.getAttribute('data-active')).toBe('false');
      expect(container.querySelector(`.nudge-mini[data-effect="${effect}"]`)).not.toBeNull();
      expect(container.querySelector('img')).toBeNull();
      rerender(<NudgeEffectPreview effect={effect} active />);
      expect(root.getAttribute('data-active')).toBe('true');
    }
  });

  it('cuts the wave into columns that carry the picture, and scatters the confetti', () => {
    expect(render(<NudgeEffectPreview effect="wave" active />).container.querySelectorAll('.nudge-mini-wave-column').length).toBeGreaterThan(4);
    expect(render(<NudgeEffectPreview effect="confetti" active />).container.querySelectorAll('.nudge-mini-confetti').length).toBeGreaterThan(4);
  });

  it('shows the still of a clip at rest and its animation once it has loaded while active', () => {
    const loads: Array<() => void> = [];
    vi.stubGlobal('Image', class { onload: (() => void) | null = null; set src(_: string) { loads.push(() => this.onload?.()); } });
    try {
      const { container, rerender } = render(<NudgeEffectPreview effect="msn_frog" active={false} />);
      expect(container.querySelector('img')!.getAttribute('src')).toBe('/nudge-previews/frog.png');
      rerender(<NudgeEffectPreview effect="msn_frog" active />);
      // Still loading: the picture does not change yet.
      expect(container.querySelector('img')!.getAttribute('src')).toBe('/nudge-previews/frog.png');
      act(() => loads.forEach((load) => load()));
      expect(container.querySelector('img')!.getAttribute('src')).toBe('/nudge-previews/frog.webp');
      rerender(<NudgeEffectPreview effect="msn_frog" active={false} />);
      expect(container.querySelector('img')!.getAttribute('src')).toBe('/nudge-previews/frog.png');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('has a recorded still and animation for the knock and every wink', () => {
    const publicDir = path.resolve(__dirname, '../../../public');
    for (const effect of ['knock', ...MSN_WINK_EFFECTS] as const) {
      const { still, animated } = previewAssets(effect);
      expect(existsSync(path.join(publicDir, still)), still).toBe(true);
      expect(existsSync(path.join(publicDir, animated)), animated).toBe(true);
    }
  });
});
