import { describe, it, expect } from 'vitest';
import {
  clampRightPanelWidth,
  RIGHT_PANEL_DEFAULT_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_KEYBOARD_STEP,
} from './rightPanelResize';

describe('clampRightPanelWidth', () => {
  it('keeps in-range widths, rounded to whole pixels', () => {
    expect(clampRightPanelWidth(240)).toBe(240);
    expect(clampRightPanelWidth(243.6)).toBe(244);
    expect(clampRightPanelWidth(RIGHT_PANEL_MIN_WIDTH)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(RIGHT_PANEL_MAX_WIDTH)).toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it('clamps below the minimum', () => {
    expect(clampRightPanelWidth(RIGHT_PANEL_MIN_WIDTH - 1)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(0)).toBe(RIGHT_PANEL_MIN_WIDTH);
    expect(clampRightPanelWidth(-4000)).toBe(RIGHT_PANEL_MIN_WIDTH);
  });

  it('clamps above the maximum', () => {
    expect(clampRightPanelWidth(RIGHT_PANEL_MAX_WIDTH + 1)).toBe(RIGHT_PANEL_MAX_WIDTH);
    expect(clampRightPanelWidth(100000)).toBe(RIGHT_PANEL_MAX_WIDTH);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampRightPanelWidth(Number.NaN)).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(clampRightPanelWidth(Number.POSITIVE_INFINITY)).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(clampRightPanelWidth(Number.NEGATIVE_INFINITY)).toBe(RIGHT_PANEL_DEFAULT_WIDTH);
  });

  it('exports a coherent constant set', () => {
    // The defaults must describe a real column: default in range, min < max,
    // and a keyboard step that divides the default so resets land on the
    // exact default rather than a rounded neighbour.
    expect(RIGHT_PANEL_MIN_WIDTH).toBeLessThan(RIGHT_PANEL_DEFAULT_WIDTH);
    expect(RIGHT_PANEL_DEFAULT_WIDTH).toBeLessThan(RIGHT_PANEL_MAX_WIDTH);
    expect(RIGHT_PANEL_DEFAULT_WIDTH % RIGHT_PANEL_KEYBOARD_STEP).toBe(0);
  });
});
