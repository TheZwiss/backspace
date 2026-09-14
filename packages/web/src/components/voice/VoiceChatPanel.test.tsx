import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceChatPanel } from './VoiceChatPanel';

vi.mock('../chat/MessageList', () => ({
  MessageList: () => <div data-testid="message-list" />,
}));

vi.mock('../chat/MessageInput', () => ({
  MessageInput: () => <div data-testid="message-input" />,
}));

describe('VoiceChatPanel', () => {
  it('establishes the positioning boundary for its floating composer', () => {
    render(<VoiceChatPanel channelId="voice-1" channelName="Voice" />);

    const panel = screen.getByTestId('voice-chat-panel');
    expect(panel).toHaveClass('relative', 'w-[340px]', 'overflow-hidden');
    expect(screen.getByTestId('message-input')).toBeInTheDocument();
  });
});
