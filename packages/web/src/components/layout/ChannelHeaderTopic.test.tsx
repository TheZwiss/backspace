import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChannelHeaderTopic } from './ChannelHeaderTopic';

const LONG_TOPIC = `Welcome to the channel.\nRules: ${'be kind and stay on topic, '.repeat(30)}the end.`;

describe('ChannelHeaderTopic', () => {
  it('shows the full topic on hover through the title', () => {
    render(<ChannelHeaderTopic channelName="general" topic={LONG_TOPIC} />);
    const trigger = screen.getByRole('button', { name: /Show full topic/ });
    expect(trigger).toHaveAttribute('title', LONG_TOPIC);
  });

  it('opens the whole topic, line breaks kept, in a dialog and closes it with Escape', async () => {
    const user = userEvent.setup();
    render(<ChannelHeaderTopic channelName="general" topic={LONG_TOPIC} />);
    expect(screen.queryByRole('heading', { name: '#general' })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Show full topic/ }));
    const heading = screen.getByRole('heading', { name: '#general' });
    const dialog = heading.parentElement?.parentElement;
    expect(dialog).toBeTruthy();
    const body = within(dialog as HTMLElement).getByText((_, el) => el?.tagName === 'P' && el.textContent === LONG_TOPIC);
    expect(body).toHaveClass('whitespace-pre-wrap');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('heading', { name: '#general' })).toBeNull();
  });

  it('is reachable from the keyboard', async () => {
    const user = userEvent.setup();
    render(<ChannelHeaderTopic channelName="general" topic="Short topic" />);
    await user.tab();
    expect(screen.getByRole('button', { name: /Show full topic/ })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('heading', { name: '#general' })).toBeInTheDocument();
  });
});
