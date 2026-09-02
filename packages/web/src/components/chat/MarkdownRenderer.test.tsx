import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MarkdownRenderer } from './MarkdownRenderer';

// MentionBadge reads the space and UI stores at render time. Only the mention
// case touches them; stub them so the rest of the file needs no app state.
vi.mock('../../stores/spaceStore', () => ({
  useSpaceStore: (selector: (s: unknown) => unknown) =>
    selector({ members: [], spaces: [], currentSpaceId: null, userViews: new Map() }),
  getApiForOrigin: vi.fn(),
  resolveUserOrigin: vi.fn(),
}));
vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: unknown) => unknown) =>
    selector({ openUserProfile: vi.fn() }),
}));
vi.mock('../../api/client', () => ({
  api: {},
  createApiClient: vi.fn(),
}));

// One message exercising every block the renderer overrides: inline code, a
// link, a blockquote, a GFM table, a highlighted fence and a bare fence.
const MIXED = [
  'Here is `inline code` and a [link](https://example.com).',
  '',
  '> a quoted line',
  '',
  '| Col A | Col B |',
  '| ----- | ----- |',
  '| a1 | b1 |',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '```',
  'plain fenced text',
  '```',
].join('\n');

describe('MarkdownRenderer', () => {
  it('renders every element of a mixed markdown message', () => {
    const { container } = render(<MarkdownRenderer content={MIXED} />);

    // Link: the `a` override, reached through urlTransform.
    const link = container.querySelector('a[href="https://example.com"]');
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe('link');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');

    // Inline code: a <code> that is not inside a <pre>.
    const inlineCodes = Array.from(container.querySelectorAll('code')).filter(
      (el) => el.closest('pre') === null,
    );
    expect(inlineCodes.map((el) => el.textContent)).toEqual(['inline code']);

    // Blockquote.
    const quote = container.querySelector('blockquote');
    expect(quote).not.toBeNull();
    expect(quote!.textContent).toContain('a quoted line');

    // GFM table: remark-gfm plus the table/thead/tbody/tr/th/td overrides.
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(Array.from(table!.querySelectorAll('th')).map((el) => el.textContent))
      .toEqual(['Col A', 'Col B']);
    expect(Array.from(table!.querySelectorAll('td')).map((el) => el.textContent))
      .toEqual(['a1', 'b1']);

    // Two fenced blocks, each its own <pre>.
    const pres = Array.from(container.querySelectorAll('pre'));
    expect(pres).toHaveLength(2);

    // Highlighted fence: prism-react-renderer emits token spans, no <code>.
    const [highlighted, bare] = pres as [HTMLElement, HTMLElement];
    expect(highlighted.textContent).toBe('const answer = 42;');
    expect(highlighted.querySelectorAll('span').length).toBeGreaterThan(1);

    // Bare fence: the remark plugin tags it `language-text`, which renders a
    // plain <code> inside the <pre> with no highlighting.
    const bareCode = bare.querySelector('code');
    expect(bareCode).not.toBeNull();
    expect(bareCode!.textContent).toBe('plain fenced text');
    expect(bareCode!.querySelector('span')).toBeNull();
  });

  it('renders emphasis, strikethrough and headings through the overrides', () => {
    const { container } = render(
      <MarkdownRenderer content={'# Title\n\n**bold** _italic_ ~~struck~~'} />,
    );

    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelector('em')!.textContent).toBe('italic');
    expect(container.querySelector('del')!.textContent).toBe('struck');
    // h1 is overridden to a div, so no heading element may appear.
    expect(container.querySelector('h1')).toBeNull();
    expect(container.textContent).toContain('Title');
  });

  it('turns a mention token into a badge rather than a link', () => {
    const { container } = render(<MarkdownRenderer content={'hi <@U1> there'} />);

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('@Unknown User');
  });

  it('leaves mention tokens inside code spans alone', () => {
    const { container } = render(<MarkdownRenderer content={'`<@U1>`'} />);

    const code = container.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.textContent).toBe('<@U1>');
  });
});
