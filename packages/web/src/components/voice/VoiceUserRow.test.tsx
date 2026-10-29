import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceUserRow } from './VoiceUserRow';
import { useSoundboardPlaybackStore } from '../../stores/soundboardPlaybackStore';

const baseProps = {
  userId: 'user-1',
  displayName: 'Ada',
  avatar: null,
};

describe('VoiceUserRow', () => {
  it('prioritizes the blue soundboard ring over speaking green', () => {
    useSoundboardPlaybackStore.getState().setPlayback('user-1:Ada', 'user-1');
    const { container, unmount } = render(<VoiceUserRow {...baseProps} isSpeaking />);
    expect(container.querySelector('.ring-blue-500')).not.toBeNull();
    unmount();
    useSoundboardPlaybackStore.getState().setPlayback(null, null);
    const next = render(<VoiceUserRow {...baseProps} isSpeaking />);
    expect(next.container.querySelector('.ring-status-online')).not.toBeNull();
  });
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
