import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { highlightMatch } from './searchHighlight';

function renderResult(text: string, query: string) {
  const { container } = render(<div>{highlightMatch(text, query)}</div>);
  return {
    text: container.textContent,
    marks: Array.from(container.querySelectorAll('mark')).map((mark) => mark.textContent),
  };
}

describe('highlightMatch', () => {
  it('shows shortcodes as emoji', () => {
    expect(renderResult('party :tada: tonight', '').text).toBe('party 🎉 tonight');
  });

  it('highlights plain text matches case-insensitively, as before', () => {
    expect(renderResult('Party :tada: party', 'party')).toEqual({ text: 'Party 🎉 party', marks: ['Party', 'party'] });
  });

  it('highlights the emoji a :shortcode: query came from', () => {
    expect(renderResult('party :tada: tonight', ':tada:')).toEqual({ text: 'party 🎉 tonight', marks: ['🎉'] });
  });

  it('highlights the whole emoji when the query matches part of its shortcode', () => {
    expect(renderResult('party :tada: tonight', 'tada')).toEqual({ text: 'party 🎉 tonight', marks: ['🎉'] });
  });

  it('splits a match that runs from text into an emoji', () => {
    expect(renderResult('party :tada:', 'y :ta')).toEqual({ text: 'party 🎉', marks: ['y ', '🎉'] });
  });

  it('leaves shortcodes in code spans as written', () => {
    expect(renderResult('use `:smile:` now', 'smile')).toEqual({ text: 'use `:smile:` now', marks: ['smile'] });
  });
});
