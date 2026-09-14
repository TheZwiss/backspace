import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceUserRow } from './VoiceUserRow';

const baseProps = {
  userId: 'user-1',
  displayName: 'Ada',
  avatar: null,
};

describe('VoiceUserRow', () => {
  it('shows an unobtrusive connection warning beside the participant', () => {
    render(
      <VoiceUserRow
        {...baseProps}
        connectionWarning="Ada has an unstable connection"
      />,
    );

    const warning = screen.getByLabelText('Ada has an unstable connection');
    expect(warning).toHaveAttribute('title', 'Ada has an unstable connection');
    expect(warning).toHaveClass('text-status-idle');
  });

  it('does not reserve status space when the connection is healthy', () => {
    const { container } = render(<VoiceUserRow {...baseProps} />);

    expect(container.querySelector('[aria-label*="connection"]')).toBeNull();
  });
});
