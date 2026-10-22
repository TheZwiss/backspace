import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelResizer } from './PanelResizer';
import { useUIStore } from '../../stores/uiStore';
import { useInterfaceScaleStore } from '../../stores/interfaceScaleStore';
import {
  RESIZABLE_PANELS,
  RESIZABLE_PANEL_IDS,
  clampPanelWidth,
  resolvePanelWidths,
  type ResizablePanelId,
} from '../../stores/panelWidths';

// Every resizable column follows one rule: the default width is the minimum,
// and the divider only grows the column up to its maximum. The divider moves
// with the column's edge: rightward on the left column, leftward on the right.

// jsdom does not implement pointer capture.
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.hasPointerCapture = () => false;
}

const widthOf = (panel: ResizablePanelId) => useUIStore.getState().panelWidths[panel];

function drag(divider: HTMLElement, fromX: number, toX: number) {
  fireEvent.pointerDown(divider, { button: 0, pointerId: 1, clientX: fromX });
  fireEvent.pointerMove(divider, { pointerId: 1, clientX: toX });
  fireEvent.pointerUp(divider, { pointerId: 1, clientX: toX });
}

/** Pointer travel that grows the panel by `px` (its edge moves outward). */
function outward(panel: ResizablePanelId, px: number): number {
  return RESIZABLE_PANELS[panel].edge === 'right' ? px : -px;
}

beforeEach(() => {
  useUIStore.setState({ panelWidths: resolvePanelWidths() });
  useInterfaceScaleStore.setState({ scale: 100 });
});

describe.each(RESIZABLE_PANEL_IDS)('PanelResizer (%s)', (panel) => {
  const { defaultWidth, maxWidth } = RESIZABLE_PANELS[panel];
  // Arrow key that points away from the column, i.e. grows it.
  const growKey = RESIZABLE_PANELS[panel].edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
  const shrinkKey = growKey === 'ArrowRight' ? 'ArrowLeft' : 'ArrowRight';

  function renderResizer() {
    render(<PanelResizer panel={panel} />);
    return screen.getByRole('separator');
  }

  it('grows when its edge is dragged outward, up to the maximum', () => {
    const divider = renderResizer();
    drag(divider, 600, 600 + outward(panel, 60));
    expect(widthOf(panel)).toBe(defaultWidth + 60);
    drag(divider, 600, 600 + outward(panel, 5000));
    expect(widthOf(panel)).toBe(maxWidth);
  });

  it('never shrinks below its default', () => {
    const divider = renderResizer();
    drag(divider, 600, 600 - outward(panel, 100));
    expect(widthOf(panel)).toBe(defaultWidth);
    fireEvent.keyDown(divider, { key: shrinkKey });
    expect(widthOf(panel)).toBe(defaultWidth);
  });

  it('converts visual pointer pixels to layout pixels under interface scale', () => {
    useInterfaceScaleStore.setState({ scale: 200 });
    const divider = renderResizer();
    drag(divider, 600, 600 + outward(panel, 100));
    expect(widthOf(panel)).toBe(defaultWidth + 50);
  });

  it('ignores pointer moves without a drag in progress', () => {
    const divider = renderResizer();
    fireEvent.pointerMove(divider, { pointerId: 1, clientX: 0 });
    expect(widthOf(panel)).toBe(defaultWidth);
  });

  it('steps with the keyboard and resets with Home, Enter or double-click', () => {
    const divider = renderResizer();
    fireEvent.keyDown(divider, { key: growKey });
    expect(widthOf(panel)).toBe(defaultWidth + 16);
    fireEvent.keyDown(divider, { key: growKey, shiftKey: true });
    expect(widthOf(panel)).toBe(defaultWidth + 16 + 64);
    fireEvent.keyDown(divider, { key: shrinkKey });
    expect(widthOf(panel)).toBe(defaultWidth + 64);
    expect(divider.getAttribute('aria-valuenow')).toBe(String(defaultWidth + 64));
    fireEvent.keyDown(divider, { key: 'Home' });
    expect(widthOf(panel)).toBe(defaultWidth);
    fireEvent.keyDown(divider, { key: 'End' });
    expect(widthOf(panel)).toBe(maxWidth);
    fireEvent.keyDown(divider, { key: 'Enter' });
    expect(widthOf(panel)).toBe(defaultWidth);
    fireEvent.keyDown(divider, { key: 'End' });
    fireEvent.doubleClick(divider);
    expect(widthOf(panel)).toBe(defaultWidth);
  });

  it('announces its bounds', () => {
    const divider = renderResizer();
    expect(divider.getAttribute('aria-valuemin')).toBe(String(defaultWidth));
    expect(divider.getAttribute('aria-valuemax')).toBe(String(maxWidth));
  });
});

describe('panel width bounds', () => {
  it('clamps between default and maximum, falling back on non-finite input', () => {
    for (const panel of RESIZABLE_PANEL_IDS) {
      const { defaultWidth, maxWidth } = RESIZABLE_PANELS[panel];
      expect(clampPanelWidth(panel, defaultWidth - 1)).toBe(defaultWidth);
      expect(clampPanelWidth(panel, maxWidth + 1)).toBe(maxWidth);
      expect(clampPanelWidth(panel, defaultWidth + 10.6)).toBe(defaultWidth + 11);
      expect(clampPanelWidth(panel, Number.NaN)).toBe(defaultWidth);
    }
  });

  it('resolves stored widths panel by panel', () => {
    expect(resolvePanelWidths({ memberList: 9999, channelSidebar: 'wide' })).toEqual({
      memberList: RESIZABLE_PANELS.memberList.maxWidth,
      channelSidebar: RESIZABLE_PANELS.channelSidebar.defaultWidth,
    });
  });
});
