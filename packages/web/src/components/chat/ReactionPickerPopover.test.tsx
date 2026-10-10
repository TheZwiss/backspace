import { useInterfaceScaleStore } from '../../stores/interfaceScaleStore';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { ReactionPickerPopover } from './ReactionPickerPopover';

// Mock EmojiPicker to keep test light and focused on positioning/interactions
vi.mock('./EmojiPicker', () => ({
  EmojiPicker: ({ onEmojiSelect }: { onEmojiSelect: (emoji: { native: string }) => void }) => (
    <div data-testid="mock-emoji-picker" onKeyDown={(event) => event.stopPropagation()} style={{ height: 440, width: 350 }}>
      <button onClick={() => onEmojiSelect({ native: '🎉' })}>Select Emoji</button>
    </div>
  ),
}));

describe('ReactionPickerPopover', () => {
  let resized: () => void;
  let pickerHeight: number;
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useInterfaceScaleStore.setState({ scale: 100 });
  });
  beforeEach(() => {
    pickerHeight = 450;
    useInterfaceScaleStore.setState({ scale: 100 });
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(360);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => pickerHeight);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    // Standard desktop viewport (1024 x 800)
    Object.defineProperty(window, 'innerWidth', { value: 1024, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  });

  function createAnchor(rect: { top: number; bottom: number; left: number; right: number; width?: number; height?: number }) {
    const el = document.createElement('button');
    el.getBoundingClientRect = () => ({
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      width: rect.width ?? (rect.right - rect.left),
      height: rect.height ?? (rect.bottom - rect.top),
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    } as DOMRect);
    document.body.appendChild(el);
    return el;
  }

  it('renders below the anchor when there is sufficient space below', () => {
    const anchor = createAnchor({ top: 100, bottom: 132, left: 800, right: 832 });
    render(
      <ReactionPickerPopover
        anchorEl={anchor}
        onEmojiSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Top should be anchor bottom (132) + MARGIN (8) = 140
    expect(dialog.style.top).toBe('140px');
  });

  it('flips above the anchor when the message is near the viewport bottom', () => {
    // Anchor near the bottom of an 800px window (e.g. top: 650, bottom: 682)
    const anchor = createAnchor({ top: 650, bottom: 682, left: 800, right: 832 });
    render(
      <ReactionPickerPopover
        anchorEl={anchor}
        onEmojiSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();

    // Flip above: top = anchor.top (650) - measured picker height (450) - MARGIN (8) = 192px
    const topValue = parseInt(dialog.style.top, 10);
    expect(topValue).toBeLessThan(650);
    // Ensure the dialog bottom does not exceed viewport height (800)
    expect(topValue + 450).toBeLessThanOrEqual(800 - 8);
  });

  it('clamps to viewport bottom when downward placement would exceed bottom boundary', () => {
    // Anchor at top: 400, bottom: 432 in an 800px window.
    // Space below is 800 - 432 = 368px (< 458px), space above is 400px.
    // Downward would be 432 + 8 = 440px -> 440 + 450 = 890px > 800px!
    // With clamping, top must never exceed 800 - 450 - 8 = 342px.
    const anchor = createAnchor({ top: 400, bottom: 432, left: 800, right: 832 });
    render(
      <ReactionPickerPopover
        anchorEl={anchor}
        onEmojiSelect={vi.fn()}
        onClose={vi.fn()}
      />
    );

    const dialog = screen.getByRole('dialog');
    const topValue = parseInt(dialog.style.top, 10);
    expect(topValue + 450).toBeLessThanOrEqual(800 - 8);
    expect(topValue).toBeGreaterThanOrEqual(8);
  });

  it('closes on Escape from inside the picker even when it stops bubbling', () => {
    const onClose = vi.fn();
    const anchor = createAnchor({ top: 200, bottom: 232, left: 800, right: 832 });
    render(
      <ReactionPickerPopover
        anchorEl={anchor}
        onEmojiSelect={vi.fn()}
        onClose={onClose}
      />
    );

    fireEvent.keyDown(screen.getByText('Select Emoji'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on outside click', () => {
    const onClose = vi.fn();
    const anchor = createAnchor({ top: 200, bottom: 232, left: 800, right: 832 });
    render(
      <ReactionPickerPopover
        anchorEl={anchor}
        onEmojiSelect={vi.fn()}
        onClose={onClose}
      />
    );

    // Click outside
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('triggers onEmojiSelect when an emoji is picked', () => {
    const onEmojiSelect = vi.fn();
    const anchor = createAnchor({ top: 200, bottom: 232, left: 800, right: 832 });
    render(
      <ReactionPickerPopover
        anchorEl={anchor}
        onEmojiSelect={onEmojiSelect}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText('Select Emoji'));
    expect(onEmojiSelect).toHaveBeenCalledWith({ native: '🎉' });
  });
  it('keeps CSS dimensions unscaled at 200% interface zoom', () => {
    useInterfaceScaleStore.setState({ scale: 200 });
    const anchor = createAnchor({ top: 650, bottom: 682, left: 800, right: 832 });
    render(<ReactionPickerPopover anchorEl={anchor} onEmojiSelect={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    // 1024 visual pixels = 512 CSS pixels; the 360px picker must not be divided again.
    expect(dialog.style.left).toBe('56px');
    expect(dialog.style.top).toBe('8px');
  });

  it('remeasures when switching from emoji to the taller sticker tab', () => {
    pickerHeight = 200;
    const anchor = createAnchor({ top: 400, bottom: 432, left: 800, right: 832 });
    render(<ReactionPickerPopover anchorEl={anchor} onEmojiSelect={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('dialog').style.top).toBe('440px');
    act(() => { pickerHeight = 500; resized(); });
    expect(screen.getByRole('dialog').style.top).toBe('8px');
  });

});
