import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { MemberWithUser } from '@backspace/shared';
import { MentionTextarea } from './MentionTextarea';
import { composerMentions } from './composerMentions';

it('anchors the popup at the typed @ after a displayed mention and mirrors native scrolling', () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mentionAnchorRef = createRef<HTMLSpanElement>();
  const value = '<@long-user-id> hello\n@al';
  const members = [{ userId: 'long-user-id', user: { username: 'alice' } }] as MemberWithUser[];
  const model = composerMentions({ value, members, roles: [] });
  const { container } = render(<MentionTextarea model={model} textareaRef={textareaRef}
    mentionAnchorRef={mentionAnchorRef} mentionStart={value.lastIndexOf('@')} onChange={vi.fn()} />);
  const anchor = mentionAnchorRef.current!;
  expect(anchor.parentElement?.textContent).toBe(' hello\n@al');
  expect(anchor.previousSibling?.textContent).toBe(' hello\n');
  expect(anchor.nextSibling?.textContent).toBe('@al');
  expect(textareaRef.current?.value).toBe('@alice hello\n@al');
  expect(container.querySelector('.text-accent-primary')).toHaveTextContent('@alice');
  fireEvent.scroll(textareaRef.current!, { target: { scrollTop: 22 } });
  expect(anchor.parentElement?.parentElement?.style.transform).toBe('translateY(-22px)');
});
