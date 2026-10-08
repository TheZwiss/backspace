import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';
import { useUIStore } from '../../stores/uiStore';

// A `fixed inset-0` overlay is sized to the nearest ancestor that sets
// `transform`, `filter` or `backdrop-filter`, not to the window. jsdom does
// no layout, so these tests check where the dialog lands in the document:
// outside whatever element it was mounted in.

function overlayOf(heading: HTMLElement): HTMLElement {
  const overlay = heading.closest('.fixed');
  if (!(overlay instanceof HTMLElement)) throw new Error('dialog has no fixed overlay');
  return overlay;
}

function backdropOf(overlay: HTMLElement): HTMLElement {
  const backdrop = overlay.querySelector(':scope > .bg-black\\/50');
  if (!(backdrop instanceof HTMLElement)) throw new Error('dialog has no backdrop');
  return backdrop;
}

beforeEach(() => {
  useUIStore.setState({ isMobile: false });
});

afterEach(() => {
  Reflect.deleteProperty(document, 'fullscreenElement');
});

describe('Modal', () => {
  it('renders at the document body, not inside the element that mounts it', () => {
    render(
      <nav data-testid="strip" style={{ width: 72, backdropFilter: 'blur(20px)' }}>
        <Modal isOpen onClose={() => {}} title="Notification settings">
          <p>Body</p>
        </Modal>
      </nav>,
    );
    const heading = screen.getByRole('heading', { name: 'Notification settings' });
    expect(screen.getByTestId('strip')).not.toContainElement(heading);
    expect(overlayOf(heading).parentElement).toBe(document.body);
  });

  it('renders nothing while closed', () => {
    render(
      <Modal isOpen={false} onClose={() => {}} title="Closed">
        <p>Body</p>
      </Modal>,
    );
    expect(screen.queryByRole('heading', { name: 'Closed' })).toBeNull();
    expect(screen.queryByText('Body')).toBeNull();
  });

  it('closes on a backdrop click and not on a click inside the dialog', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Dialog">
        <button type="button">Inside</button>
      </Modal>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Inside' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(backdropOf(overlayOf(screen.getByRole('heading', { name: 'Dialog' }))));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape while open', () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen onClose={onClose} title="Dialog">
        <p>Body</p>
      </Modal>,
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps focus on a field inside the portaled dialog', () => {
    render(
      <Modal isOpen onClose={() => {}} title="Dialog">
        <input aria-label="Name" autoFocus />
      </Modal>,
    );
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus();
  });

  it('appends a dialog opened from inside an open dialog after it', () => {
    function Outer() {
      const [innerOpen, setInnerOpen] = useState(false);
      return (
        <Modal isOpen onClose={() => {}} title="Outer">
          <button type="button" onClick={() => setInnerOpen(true)}>Open inner</button>
          <Modal isOpen={innerOpen} onClose={() => setInnerOpen(false)} title="Inner">
            <p>Inner body</p>
          </Modal>
        </Modal>
      );
    }
    render(<Outer />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }));
    const outer = overlayOf(screen.getByRole('heading', { name: 'Outer' }));
    const inner = overlayOf(screen.getByRole('heading', { name: 'Inner' }));
    expect(outer).not.toContainElement(inner);
    expect(inner.parentElement).toBe(document.body);
    // Both overlays share one z-index, so document order puts the inner on top.
    expect(outer.compareDocumentPosition(inner) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows the bottom sheet on mobile, also at the document body', () => {
    useUIStore.setState({ isMobile: true });
    render(
      <div data-testid="screen" style={{ transform: 'translateX(0)' }}>
        <Modal isOpen onClose={() => {}} title="Sheet" mobileStyle="sheet">
          <p>Body</p>
        </Modal>
      </div>,
    );
    const overlay = overlayOf(screen.getByRole('heading', { name: 'Sheet' }));
    expect(screen.getByTestId('screen')).not.toContainElement(overlay);
    expect(overlay.parentElement).toBe(document.body);
    expect(overlay).toHaveClass('items-end');
  });

  it('renders into the fullscreen element while one is active', () => {
    const stage = document.createElement('div');
    document.body.appendChild(stage);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => stage });
    try {
      render(
        <Modal isOpen onClose={() => {}} title="Over fullscreen">
          <p>Body</p>
        </Modal>,
      );
      expect(overlayOf(screen.getByRole('heading', { name: 'Over fullscreen' })).parentElement).toBe(stage);
    } finally {
      stage.remove();
    }
  });
});
