import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HubUpdateDot } from './HubUpdateDot';

describe('HubUpdateDot', () => {
  it('is an image named for what it means', () => {
    render(<HubUpdateDot />);
    expect(screen.getByRole('img', { name: 'Backspace was updated' })).toBeInTheDocument();
  });

  it('is the brand primary 8px dot, not the red "needs you" dot', () => {
    render(<HubUpdateDot />);
    const dot = screen.getByRole('img', { name: 'Backspace was updated' });
    expect(dot).toHaveClass('w-2', 'h-2', 'rounded-full', 'bg-accent-primary', 'flex-shrink-0');
    expect(dot).not.toHaveClass('bg-notification');
  });

  it('adds a positioning class without dropping its own', () => {
    render(<HubUpdateDot className="ml-auto" />);
    const dot = screen.getByRole('img', { name: 'Backspace was updated' });
    expect(dot).toHaveClass('ml-auto', 'w-2', 'h-2', 'bg-accent-primary');
  });
});
