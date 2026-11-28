import { describe, it, expect } from 'vitest';
import {
  clampLeftPanelWidth,
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  LEFT_PANEL_MAX_WIDTH,
} from './leftPanelResize';

describe('clampLeftPanelWidth', () => {
  it('keeps in-range widths, rounded to whole pixels', () => {
    expect(clampLeftPanelWidth(312)).toBe(312);
    expect(clampLeftPanelWidth(315.6)).toBe(316);
    expect(clampLeftPanelWidth(LEFT_PANEL_MIN_WIDTH)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampLeftPanelWidth(LEFT_PANEL_MAX_WIDTH)).toBe(LEFT_PANEL_MAX_WIDTH);
  });

  it('clamps below the minimum', () => {
    expect(clampLeftPanelWidth(LEFT_PANEL_MIN_WIDTH - 1)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampLeftPanelWidth(0)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampLeftPanelWidth(-4000)).toBe(LEFT_PANEL_MIN_WIDTH);
  });

  it('clamps above the maximum', () => {
    expect(clampLeftPanelWidth(LEFT_PANEL_MAX_WIDTH + 1)).toBe(LEFT_PANEL_MAX_WIDTH);
    expect(clampLeftPanelWidth(100000)).toBe(LEFT_PANEL_MAX_WIDTH);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampLeftPanelWidth(Number.NaN)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    expect(clampLeftPanelWidth(Number.POSITIVE_INFINITY)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
    expect(clampLeftPanelWidth(Number.NEGATIVE_INFINITY)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it('exports a coherent constant set', () => {
    // The constants must describe the real column: the bounds bracket the
    // shipped 312px default (72px rail + 240px list), and they are the rail
    // plus the same 180-420px band the right column's list uses. The default
    // is not a multiple of the 16px keyboard step — that is fine: the
    // double-click reset writes the exact default and every other path
    // clamps at whole pixels.
    expect(LEFT_PANEL_MIN_WIDTH).toBeLessThan(LEFT_PANEL_DEFAULT_WIDTH);
    expect(LEFT_PANEL_DEFAULT_WIDTH).toBeLessThan(LEFT_PANEL_MAX_WIDTH);
    expect(LEFT_PANEL_MIN_WIDTH).toBe(72 + 180);
    expect(LEFT_PANEL_MAX_WIDTH).toBe(72 + 420);
  });
});
