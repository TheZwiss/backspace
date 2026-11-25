import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { MentionTextarea } from './MentionTextarea';
import { composerMentions } from './composerMentions';
import type { BotCommandListing, BotCommandOption } from '@backspace/shared';
import { ARG_SEPARATOR, HEAD_GAP, VALUE_GAP, argumentFrames } from '../../utils/commandArgs';

it('anchors the popup at the typed @ after a displayed mention and mirrors native scrolling', () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mentionAnchorRef = createRef<HTMLSpanElement>();
  const value = '<@long-user-id> hello\n@al';
  const model = composerMentions(value, (userId) => (userId === 'long-user-id' ? 'alice' : null));
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

it('draws command arguments as capsules without changing the mirrored text', () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mentionAnchorRef = createRef<HTMLSpanElement>();
  const option = (name: string, type: BotCommandOption['type']): BotCommandOption => ({ name, description: name, type, required: false });
  const poke = { name: 'poke', options: [option('who', 'user'), option('times', 'integer')] } as BotCommandListing;
  const value = '/poke' + HEAD_GAP + 'who:' + VALUE_GAP + '<@u1>' + ARG_SEPARATOR + 'times:' + VALUE_GAP;
  const model = composerMentions(value, (userId) => (userId === 'u1' ? 'Bob Smith' : null));
  const units = model.parts.filter((p) => p.mention).map((p) => ({ start: p.start, end: p.start + p.text.length }));
  const { container } = render(<MentionTextarea model={model} textareaRef={textareaRef} mentionAnchorRef={mentionAnchorRef}
    frames={argumentFrames(model.text, poke, units)} onChange={vi.fn()} />);
  // The mirror holds exactly the textarea's text, so the caret and the painted text stay together.
  const mirror = container.querySelector('[aria-hidden="true"] > div')!;
  expect(mirror.textContent).toBe(model.text + '​');
  // The mention sits in its value's one frame, which an end cap closes; the empty value gets a slot.
  const mention = container.querySelector('.text-accent-primary')!;
  expect(mention.textContent).toBe('@Bob Smith');
  const frame = mention.parentElement!;
  // The thin space after the colon pads the name; the en space is the value's.
  expect(frame.textContent).toBe('\u2002@Bob Smith');
  const cap = frame.lastElementChild as HTMLElement;
  expect(cap.className).toContain('after:w-[var(--cap)]');
  // With the composer's spacing the ends get their full size.
  expect(cap.style.getPropertyValue('--cap')).toBe('0.400em');
  expect(container.querySelectorAll('[class*="after:w-[var(--cap)]"]')).toHaveLength(1);
  expect(container.querySelectorAll('[class*="after:border-dashed"]')).toHaveLength(1);
});

it('keeps capsules apart when the spaces between them are plain', () => {
  const textareaRef = createRef<HTMLTextAreaElement>();
  const mentionAnchorRef = createRef<HTMLSpanElement>();
  const option = (name: string, type: BotCommandOption['type']): BotCommandOption => ({ name, description: name, type, required: false });
  const poke = { name: 'poke', options: [option('who', 'user'), option('times', 'integer')] } as BotCommandListing;
  const model = composerMentions('/poke who:Bob times:3', () => null);
  const { container } = render(<MentionTextarea model={model} textareaRef={textareaRef} mentionAnchorRef={mentionAnchorRef}
    frames={argumentFrames(model.text, poke)} onChange={vi.fn()} />);
  // A plain space (about 0.28em) between `Bob` and `times`: both ends shrink to fit with a gap left.
  const [whoCap] = [...container.querySelectorAll<HTMLElement>('[class*="after:w-[var(--cap)]"]')];
  const timesName = [...container.querySelectorAll<HTMLElement>('span')].find((el) => el.textContent === 'times:')!;
  const cap = parseFloat(whoCap!.style.getPropertyValue('--cap'));
  const reach = parseFloat(timesName.style.getPropertyValue('--reach'));
  expect(cap + reach).toBeLessThan(0.28 - 0.1);
  expect(cap).toBeGreaterThan(0);
});
