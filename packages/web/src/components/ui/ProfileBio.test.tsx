import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ProfileBio } from './ProfileBio';
import { loadDiscordEmojiAliases } from '../../utils/emojiShortcodes';

// A bio renders newlines the way a chat message does: the container is
// `whitespace-pre-wrap` and paragraphs carry no margin, so
//   - a single newline stays inside its paragraph and breaks the line,
//   - a blank line (or several) splits paragraphs, and the one newline
//     react-markdown leaves between them is the only gap: one empty line.
// jsdom has no layout, so these tests pin the structure that produces that
// spacing. Paragraph margins or a second separator would stack a gap on top.

function paragraphs(container: HTMLElement): HTMLParagraphElement[] {
  return Array.from(container.querySelectorAll('p'));
}

/** The nodes between the first and second paragraph. */
function separatorBetweenParagraphs(container: HTMLElement): string[] {
  const [first] = paragraphs(container);
  const nodes: string[] = [];
  let node = first?.nextSibling ?? null;
  while (node && node.nodeName !== 'P') {
    nodes.push(node.nodeType === Node.TEXT_NODE ? JSON.stringify(node.textContent) : node.nodeName);
    node = node.nextSibling;
  }
  return nodes;
}

describe('ProfileBio', () => {
  it('keeps a single newline inside the paragraph as a line break', () => {
    const { container } = render(<ProfileBio bio={'line one\nline two'} />);

    const ps = paragraphs(container);
    expect(ps).toHaveLength(1);
    expect(ps[0]!.textContent).toBe('line one\nline two');
    expect(container.firstElementChild!.className).toContain('whitespace-pre-wrap');
  });

  it('separates paragraphs by exactly one newline and no margins', () => {
    const { container } = render(<ProfileBio bio={'line one\n\nline two'} />);

    const ps = paragraphs(container);
    expect(ps.map((p) => p.textContent)).toEqual(['line one', 'line two']);
    expect(separatorBetweenParagraphs(container)).toEqual([JSON.stringify('\n')]);
    for (const p of ps) expect(p.getAttribute('class')).toBeNull();
    expect(container.firstElementChild!.className).not.toMatch(/\[&_p\]|space-y|gap-/);
  });

  it('renders several blank lines the same as one', () => {
    const one = render(<ProfileBio bio={'line one\n\nline two'} />).container.innerHTML;
    const many = render(<ProfileBio bio={'line one\n\n\n\n\nline two'} />).container.innerHTML;

    expect(many).toBe(one);
  });

  it('renders Discord shortcode names once they are loaded (issue #252)', async () => {
    await loadDiscordEmojiAliases();
    const { container } = render(<ProfileBio bio={'est.:cross: :heart_on_fire:\n\n-Catholic :cross: :flag_va: :orthodox_cross:'} />);
    expect(paragraphs(container).map((p) => p.textContent)).toEqual([
      'est.✝️ ❤️‍🔥',
      '-Catholic ✝️ 🇻🇦 ☦️',
    ]);
  });

  it('turns a bare URL into a link and leaves its text unconverted, as chat does', () => {
    const { container } = render(<ProfileBio bio={'blog https://x.com/:smile:/y :smile:'} />);
    const link = container.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://x.com/:smile:/y');
    expect(link.textContent).toBe('https://x.com/:smile:/y');
    expect(container.textContent).toBe('blog https://x.com/:smile:/y 😄');
  });
});
