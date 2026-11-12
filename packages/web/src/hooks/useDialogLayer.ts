import { useLayoutEffect, useRef, type RefObject } from 'react';
import { registerBackDismissOnMobile } from '../utils/overlayBack';

interface DialogOptions {
  open?: boolean;
  dismissible?: boolean;
  onClose: () => void;
  label?: string;
  document?: Document;
}

interface DialogLayer {
  element: HTMLElement;
  close: () => void;
  dismissible: () => boolean;
}

interface HiddenElement {
  element: HTMLElement;
  inert: boolean;
  inertAttribute: string | null;
  ariaHidden: string | null;
}

const managers = new WeakMap<Document, ReturnType<typeof createManager>>();
let headingSequence = 0;
const focusableSelector = 'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';

function focusableElements(root: HTMLElement): HTMLElement[] {
  const view = root.ownerDocument.defaultView;
  return [...root.querySelectorAll<HTMLElement>(focusableSelector)].filter(element => {
    const style = view?.getComputedStyle(element);
    return element.tabIndex >= 0 && !element.closest('[inert],[aria-hidden="true"]')
      && style?.visibility !== 'hidden' && element.getClientRects().length > 0;
  });
}

function createManager(doc: Document) {
  const layers = new Set<DialogLayer>();
  let hidden: HiddenElement[] = [];
  const top = (): DialogLayer | undefined => [...layers].filter(layer => layer.element.isConnected).sort((a, b) => {
    if (a.element.contains(b.element)) return -1;
    if (b.element.contains(a.element)) return 1;
    const z = (element: HTMLElement) => Number.parseInt(doc.defaultView?.getComputedStyle(element).zIndex ?? '0', 10) || 0;
    const difference = z(a.element) - z(b.element);
    if (difference) return difference;
    return a.element.compareDocumentPosition(b.element) & 4 ? -1 : 1;
  }).at(-1);
  const portals = (active: DialogLayer) => [...doc.querySelectorAll<HTMLElement>('[role="menu"],[role="listbox"],[data-dialog-portal]')].filter(element => {
    const container = element.parentElement;
    if ((container !== doc.body && container !== doc.fullscreenElement)
      || element.closest('[inert]') || element.getClientRects().length === 0) return false;
    const portalZ = Number.parseInt(doc.defaultView?.getComputedStyle(element).zIndex ?? '0', 10) || 0;
    const activeZ = Number.parseInt(doc.defaultView?.getComputedStyle(active.element).zIndex ?? '0', 10) || 0;
    return portalZ > activeZ || (portalZ === activeZ
      && !!(active.element.compareDocumentPosition(element) & 4));
  });

  const restoreBackground = () => {
    for (const item of hidden) {
      item.element.inert = item.inert;
      if (item.inertAttribute === null) item.element.removeAttribute('inert');
      else item.element.setAttribute('inert', item.inertAttribute);
      if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
      else item.element.setAttribute('aria-hidden', item.ariaHidden);
    }
    hidden = [];
  };
  const focus = (layer: DialogLayer) => (focusableElements(layer.element)[0] ?? layer.element).focus({ preventScroll: true });
  const refresh = () => {
    restoreBackground();
    const active = top();
    if (!active) return;
    const floating = portals(active);
    if (![active.element, ...floating].some(root => root.contains(doc.activeElement))) focus(active);
    for (let current: Element | null = active.element; current?.parentElement; current = current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || sibling.namespaceURI !== 'http://www.w3.org/1999/xhtml'
          || floating.some(portal => sibling === portal || sibling.contains(portal))) continue;
        const element = sibling as HTMLElement;
        hidden.push({ element, inert: element.inert, inertAttribute: element.getAttribute('inert'), ariaHidden: element.getAttribute('aria-hidden') });
        element.inert = true;
        element.setAttribute('inert', '');
        element.setAttribute('aria-hidden', 'true');
      }
      if (current.parentElement === doc.body || current.parentElement === doc.fullscreenElement) break;
    }
  };
  const keydown = (event: KeyboardEvent) => {
    const active = top();
    if (!active) return;
    const floating = portals(active);
    if (event.key === 'Escape') {
      if (floating.length) return;
      // An element marked data-owns-escape (an inline editor with something to
      // abandon) consumes the key itself, so the dialog must not take it first.
      if (event.target instanceof Element && event.target.closest('[data-owns-escape]')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (active.dismissible()) active.close();
    } else if (event.key === 'Tab') {
      const controls = [active.element, ...floating].flatMap(focusableElements);
      const first = controls[0];
      const last = controls.at(-1);
      const outside = ![active.element, ...floating].some(root => root.contains(doc.activeElement));
      if (!first || outside || doc.activeElement === active.element || (event.shiftKey ? doc.activeElement === first : doc.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last ?? active.element : first ?? active.element).focus();
      }
    }
  };
  const focusin = (event: FocusEvent) => {
    const active = top();
    if (active && ![active.element, ...portals(active)].some(root => root.contains(event.target as Node))) focus(active);
  };
  doc.addEventListener('keydown', keydown, true);
  doc.addEventListener('focusin', focusin, true);
  return {
    add(layer: DialogLayer) { layers.add(layer); refresh(); },
    remove(layer: DialogLayer, previousFocus: HTMLElement | null) {
      const wasTop = top() === layer;
      layers.delete(layer);
      refresh();
      if (wasTop && previousFocus?.isConnected && !previousFocus.closest('[inert]') && (!top() || top()?.element.contains(previousFocus))) previousFocus.focus({ preventScroll: true });
      if (!layers.size) {
        restoreBackground();
        doc.removeEventListener('keydown', keydown, true);
        doc.removeEventListener('focusin', focusin, true);
        managers.delete(doc);
      }
    },
  };
}

/** Own focus and dismissal only while this is the top dialog in its document. */
export function useDialogLayer(ref: RefObject<HTMLElement>, options: DialogOptions): void {
  const current = useRef(options);
  current.current = options;
  const previousFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const open = options.open ?? true;
  if (open && !wasOpen.current) previousFocus.current = (options.document ?? document).activeElement as HTMLElement | null;
  wasOpen.current = open;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const doc = element.ownerDocument;
    const manager = managers.get(doc) ?? createManager(doc);
    managers.set(doc, manager);
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'true');
    element.tabIndex = -1;
    const label = current.current.label;
    if (label) element.setAttribute('aria-label', label);
    const name = () => {
      if (current.current.label) { element.setAttribute('aria-label', current.current.label); return; }
      const heading = element.querySelector<HTMLElement>('h1,h2,h3');
      if (heading) {
        if (!heading.id) heading.id = `dialog-heading-${++headingSequence}`;
        element.setAttribute('aria-labelledby', heading.id);
      }
    };
    name();
    const observer = new MutationObserver(name);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    const layer: DialogLayer = { element, close: () => current.current.onClose(), dismissible: () => current.current.dismissible !== false };
    manager.add(layer);
    // On a phone the system Back closes the dialog instead of leaving the screen under it
    const unregisterBack = layer.dismissible()
      ? registerBackDismissOnMobile(() => { if (layer.dismissible()) layer.close(); })
      : null;
    return () => { unregisterBack?.(); observer.disconnect(); manager.remove(layer, previousFocus.current); };
  }, [open, ref]);
}
