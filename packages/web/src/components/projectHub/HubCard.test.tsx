import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HubCard, type HubAccent } from './HubCard';

const ACCENTS: HubAccent[] = ['lavender', 'mint', 'peach', 'sky', 'amber', 'rose', 'coral'];

describe('HubCard', () => {
  it('names the card after its title and renders body and action area', () => {
    render(
      <HubCard accent="sky" icon={<svg data-testid="icon" />} title="Insights" body="Public numbers.">
        <a href="https://example.org">Open insights</a>
      </HubCard>,
    );
    const card = screen.getByRole('article', { name: 'Insights' });
    expect(card).toHaveTextContent('Public numbers.');
    expect(screen.getByRole('heading', { name: 'Insights' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open insights' })).toBeInTheDocument();
    expect(screen.getByTestId('icon')).toBeInTheDocument();
  });

  it.each(ACCENTS)('colours only the icon tile with the %s accent token', (accent) => {
    render(<HubCard accent={accent} icon={<svg data-testid="icon" />} title="Card" />);
    const tile = screen.getByTestId('icon').parentElement as HTMLElement;
    expect(tile).toHaveClass(`bg-accent-${accent}/15`, `text-accent-${accent}`);
    const card = screen.getByRole('article', { name: 'Card' });
    expect(card.className).not.toMatch(/accent-/);
  });

  it('is a matte surface, never glass', () => {
    render(<HubCard accent="mint" icon={<svg />} title="Card" />);
    const card = screen.getByRole('article', { name: 'Card' });
    expect(card.className).toMatch(/\bbg-surface-/);
    expect(card.className).not.toMatch(/glass/);
  });

  it('renders no empty body or action containers when they are omitted', () => {
    render(<HubCard accent="mint" icon={<svg />} title="Card" />);
    const card = screen.getByRole('article', { name: 'Card' });
    expect(card.querySelector('[data-hub-card-body]')).toBeNull();
    expect(card.querySelector('[data-hub-card-actions]')).toBeNull();
  });
});
