import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { MessageWithUser, User } from '@backspace/shared';

/**
 * Shared fixtures for the MessageList tests. jsdom has no layout, so these
 * give the scroll container and the message rows a geometry that responds to
 * scrolling, and a ResizeObserver that reports a size change only to the
 * observers whose box it changed, as a browser does.
 */

export const CHANNEL = 'chan-1';

export function user(id: string, username: string): User {
  return { id, username, displayName: null, avatar: null, createdAt: 1 } as unknown as User;
}

export const me = user('me', 'jannis');
export const mira = user('u-mira', 'mira');

export function msg(id: string, content: string, extra: Partial<MessageWithUser> = {}): MessageWithUser {
  return {
    id,
    channelId: CHANNEL,
    userId: mira.id,
    replyToId: null,
    content,
    editedAt: null,
    createdAt: 1_700_000_000_000 + Number(id) * 60_000,
    user: mira,
    attachments: [],
    embeds: [],
    reactions: [],
    ...extra,
  };
}

export const ROW_HEIGHT = 40;

export interface ScrollLayout {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  /** Top of each message row in content coordinates, by message id. */
  rowY: Record<string, number>;
}

/**
 * The list's scroll container (the `.overflow-y-auto` element) sits at the
 * viewport top; a row's viewport top is its content position minus the
 * scroll offset. Setting scrollTop clamps to the scrollable range.
 */
export function stubScrollLayout(layout: ScrollLayout): void {
  const isList = (el: Element) => el.classList.contains('overflow-y-auto');
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return isList(this) ? layout.scrollHeight : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return isList(this) ? layout.clientHeight : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return isList(this) ? layout.scrollTop : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    if (isList(this)) layout.scrollTop = Math.max(0, Math.min(value, layout.scrollHeight - layout.clientHeight));
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.id.startsWith('msg-')) {
      const y = layout.rowY[this.id.slice(4)];
      if (y !== undefined) return new DOMRect(0, y - layout.scrollTop, 600, ROW_HEIGHT);
      return new DOMRect(0, -100_000, 600, ROW_HEIGHT);
    }
    if (isList(this)) return new DOMRect(0, 0, 600, layout.clientHeight);
    return new DOMRect(0, 0, 600, 0);
  });
}

/** Rows stacked from `firstY`, one per id, `ROW_HEIGHT` apart. */
export function stackRows(ids: readonly string[], firstY = 0): Record<string, number> {
  const rows: Record<string, number> = {};
  ids.forEach((id, i) => { rows[id] = firstY + i * ROW_HEIGHT; });
  return rows;
}

export class BoxResizeObserver {
  static all: BoxResizeObserver[] = [];
  readonly targets = new Map<Element, ResizeObserverBoxOptions>();
  constructor(readonly callback: ResizeObserverCallback) { BoxResizeObserver.all.push(this); }
  observe(target: Element, options?: ResizeObserverOptions): void {
    this.targets.set(target, options?.box ?? 'content-box');
  }
  unobserve(target: Element): void { this.targets.delete(target); }
  disconnect(): void { this.targets.clear(); }
}

/**
 * A size change of `target`. `content` changes every box; `padding` changes
 * only the border box, so observers watching the content box are not told.
 */
export function resizeElement(target: Element, what: 'content' | 'padding'): void {
  act(() => {
    for (const observer of BoxResizeObserver.all) {
      const box = observer.targets.get(target);
      if (box === undefined) continue;
      if (what === 'padding' && box === 'content-box') continue;
      observer.callback([{ target } as ResizeObserverEntry], observer as unknown as ResizeObserver);
    }
  });
}

export function installBoxResizeObserver(): void {
  BoxResizeObserver.all = [];
  vi.stubGlobal('ResizeObserver', BoxResizeObserver);
}
