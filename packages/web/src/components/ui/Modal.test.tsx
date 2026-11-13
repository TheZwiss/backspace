import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { Modal } from './Modal';
import { useUIStore } from '../../stores/uiStore';
import { useDialogLayer } from '../../hooks/useDialogLayer';

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

  it('makes background inert and restores its exact prior attributes', () => {
    const background = document.createElement('main');
    background.setAttribute('inert', '');
    background.setAttribute('aria-hidden', 'false');
    document.body.appendChild(background);
    const view = render(<Modal isOpen onClose={() => {}} title="Dialog"><button>Inside</button></Modal>);
    const overlay = overlayOf(screen.getByRole('heading', { name: 'Dialog' }));
    expect(background).toHaveAttribute('inert');
    expect(background).toHaveAttribute('aria-hidden', 'true');
    view.unmount();
    expect(background).toHaveAttribute('inert', '');
    expect(background).toHaveAttribute('aria-hidden', 'false');
    background.remove();
    expect(overlay).not.toBeInTheDocument();
  });

  it('cleans up correctly when mounted under StrictMode', () => {
    const background = document.createElement('main');
    document.body.appendChild(background);
    const view = render(<React.StrictMode><Modal isOpen onClose={() => {}} title="Strict dialog"><button>Inside</button></Modal></React.StrictMode>);
    expect(background).toHaveAttribute('inert');
    view.unmount();
    expect(background).not.toHaveAttribute('inert');
    expect(background).not.toHaveAttribute('aria-hidden');
    background.remove();
    fireEvent.keyDown(document, { key: 'Escape' });
  });

  it('returns focus to its opener after closing', () => {
    function Example() {
      const [open, setOpen] = useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button><Modal isOpen={open} onClose={() => setOpen(false)} title="Dialog"><button>Inside</button></Modal></>;
    }
    render(<Example />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(opener).toHaveFocus();
  });

  it('traps focus in the top nested dialog and Escape closes only that layer', () => {
    const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([{ width: 20, height: 20 } as DOMRect]);
    function Example() {
      const [inner, setInner] = useState(false);
      return <Modal isOpen onClose={() => {}} title="Outer"><button onClick={() => setInner(true)}>Open inner</button><Modal isOpen={inner} onClose={() => setInner(false)} title="Inner"><button>Inner action</button></Modal></Modal>;
    }
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }));
    const inner = overlayOf(screen.getByRole('heading', { name: 'Inner' }));
    const action = within(inner).getByRole('button', { name: 'Inner action' });
    action.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(within(inner).getByRole('button', { name: /close/i })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('heading', { name: 'Inner' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Outer' })).toBeInTheDocument();
    rects.mockRestore();
  });

  it('blocks Escape on a non-dismissible top dialog without closing its parent', () => {
    function Child({ onClose }: { onClose: () => void }) {
      const ref = React.useRef<HTMLDivElement>(null);
      useDialogLayer(ref, { onClose, dismissible: false });
      return <div ref={ref}><button>Busy</button></div>;
    }
    function Example() {
      const [inner, setInner] = useState(false);
      return <Modal isOpen onClose={() => {}} title="Outer"><button onClick={() => setInner(true)}>Open busy</button>{inner && <Child onClose={() => setInner(false)} />}</Modal>;
    }
    render(<Example />);
    fireEvent.click(screen.getByRole('button', { name: 'Open busy' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[aria-label="Outer"]')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Busy' })).toBeInTheDocument();
  });

  it('allows focus and keyboard interaction in a portaled menu', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.style.zIndex = '201';
    menu.innerHTML = '<button role="menuitem">Menu item</button>';
    Object.defineProperty(menu, 'getClientRects', { value: () => [{ width: 20, height: 20 }] });
    Object.defineProperty(menu.firstElementChild, 'getClientRects', { value: () => [{ width: 20, height: 20 }] });
    document.body.appendChild(menu);
    const close = vi.fn();
    const view = render(<Modal isOpen onClose={close} title="Dialog"><button>Inside</button></Modal>);
    const item = within(menu).getByRole('menuitem');
    item.focus();
    expect(item).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    view.unmount();
    menu.remove();
  });

  it('inerts an earlier equal-z menu when a modal opens and lets Escape close the modal', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.style.zIndex = '200';
    menu.innerHTML = '<button role="menuitem">Earlier item</button>';
    Object.defineProperty(menu, 'getClientRects', { value: () => [{ width: 20, height: 20 }] });
    document.body.appendChild(menu);
    const menuItem = menu.querySelector('button')!;
    menuItem.focus();

    const originalGetComputedStyle = window.getComputedStyle.bind(window);
    const getComputedStyle = vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
      const style = originalGetComputedStyle(element);
      if (element === menu || (element instanceof HTMLElement && element.getAttribute('aria-label') === 'Dialog')) {
        return { zIndex: '200', visibility: style.visibility } as CSSStyleDeclaration;
      }
      return style;
    });

    function Example() {
      const [open, setOpen] = useState(true);
      return <Modal isOpen={open} onClose={() => setOpen(false)} title="Dialog"><button>Inside</button></Modal>;
    }
    const view = render(<Example />);
    const dialog = document.querySelector<HTMLElement>('[aria-label="Dialog"]')!;
    expect(menu).toHaveAttribute('inert');
    expect(dialog).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(document.querySelector('[aria-label="Dialog"]')).toBeNull();
    expect(menuItem).not.toHaveAttribute('inert');
    view.unmount();
    getComputedStyle.mockRestore();
    menu.remove();
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
    const outer = document.querySelector<HTMLElement>('[aria-label="Outer"]')!;
    const outerHeading = outer.querySelector('h2')!;
    const inner = overlayOf(screen.getByRole('heading', { name: 'Inner' }));
    expect(outerHeading).not.toContainElement(inner);
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
