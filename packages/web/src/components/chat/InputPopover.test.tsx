import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { InputPopover } from './InputPopover';
import { useUIStore } from '../../stores/uiStore';

vi.mock('./EmojiPicker', () => ({
  EmojiPicker: () => <div data-testid="mock-emoji-picker">Emoji Picker</div>,
}));

vi.mock('./StickerPicker', () => ({
  StickerPicker: () => <div data-testid="mock-sticker-picker">Sticker Picker</div>,
}));

vi.mock('./GifPicker', () => ({
  GifPicker: () => <div data-testid="mock-gif-picker">Gif Picker</div>,
}));

describe('InputPopover', () => {
  let anchorEl: HTMLButtonElement;

  beforeEach(() => {
    useUIStore.setState({ isMobile: false });
    anchorEl = document.createElement('button');
    anchorEl.setAttribute('data-testid', 'anchor-button');
    anchorEl.getBoundingClientRect = () => ({
      top: 600,
      bottom: 632,
      left: 500,
      right: 532,
      width: 32,
      height: 32,
      x: 500,
      y: 600,
      toJSON: () => ({}),
    } as DOMRect);
    document.body.appendChild(anchorEl);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    anchorEl.remove();
  });

  it('closes on outside click on normal document body', () => {
    const onClose = vi.fn();
    render(
      <InputPopover
        activeTab="sticker"
        onClose={onClose}
        onEmojiSelect={vi.fn()}
        onGifSelect={vi.fn()}
        anchorRef={{ current: anchorEl }}
        gifEnabled={false}
        onTabChange={vi.fn()}
      />
    );

    expect(screen.getByTestId('mock-sticker-picker')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on outside click when interacting with a modal dialog overlay', () => {
    const onClose = vi.fn();
    render(
      <InputPopover
        activeTab="sticker"
        onClose={onClose}
        onEmojiSelect={vi.fn()}
        onGifSelect={vi.fn()}
        anchorRef={{ current: anchorEl }}
        gifEnabled={false}
        onTabChange={vi.fn()}
      />
    );

    // Create a mock modal dialog in body representing StickerStoreModal
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const modalButton = document.createElement('button');
    modalButton.textContent = 'Install Pack';
    modal.appendChild(modalButton);
    document.body.appendChild(modal);

    // Click inside the modal dialog
    fireEvent.mouseDown(modalButton);
    expect(onClose).not.toHaveBeenCalled();

    modal.remove();
  });

  it('closes on Escape when no modal dialog is open', () => {
    const onClose = vi.fn();
    render(
      <InputPopover
        activeTab="sticker"
        onClose={onClose}
        onEmojiSelect={vi.fn()}
        onGifSelect={vi.fn()}
        anchorRef={{ current: anchorEl }}
        gifEnabled={false}
        onTabChange={vi.fn()}
      />
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close on Escape when an aria-modal dialog is active', () => {
    const onClose = vi.fn();
    render(
      <InputPopover
        activeTab="sticker"
        onClose={onClose}
        onEmojiSelect={vi.fn()}
        onGifSelect={vi.fn()}
        anchorRef={{ current: anchorEl }}
        gifEnabled={false}
        onTabChange={vi.fn()}
      />
    );

    // Create an active modal in the DOM
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    modal.remove();
  });
});
