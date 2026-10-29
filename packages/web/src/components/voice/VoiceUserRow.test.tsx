import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { VoiceUserRow } from './VoiceUserRow';
import { useSoundboardPlaybackStore } from '../../stores/soundboardPlaybackStore';

const baseProps = {
  userId: 'user-1',
  displayName: 'Ada',
  avatar: null,
};

describe('VoiceUserRow', () => {
  it('prioritizes the blue soundboard ring over speaking green', () => {
    useSoundboardPlaybackStore.getState().setPlaybacks([{ identity: 'user-1:Ada', userId: 'user-1' }]);
    const { container, unmount } = render(<VoiceUserRow {...baseProps} isSpeaking />);
    expect(container.querySelector('.ring-blue-500')).not.toBeNull();
    unmount();
    useSoundboardPlaybackStore.getState().setPlaybacks([]);
    const next = render(<VoiceUserRow {...baseProps} isSpeaking />);
    expect(next.container.querySelector('.ring-status-online')).not.toBeNull();
  });
  it('marks multiple participants blue and clears only the sender who finished', () => {
    useSoundboardPlaybackStore.getState().setPlaybacks([{ identity: 'user-1:Ada', userId: 'user-1' }, { identity: 'user-2:Bob', userId: 'user-2' }]);
    const view = render(<><VoiceUserRow {...baseProps} isSpeaking /><VoiceUserRow userId="user-2" displayName="Bob" avatar={null} /></>);
    expect(view.container.querySelectorAll('.ring-blue-500')).toHaveLength(2);
    act(() => useSoundboardPlaybackStore.getState().setPlaybacks([{ identity: 'user-2:Bob', userId: 'user-2' }]));
    expect(view.container.querySelectorAll('.ring-blue-500')).toHaveLength(1);
    expect(view.container.querySelectorAll('.ring-status-online')).toHaveLength(1);
    act(() => useSoundboardPlaybackStore.getState().setPlaybacks([]));
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
