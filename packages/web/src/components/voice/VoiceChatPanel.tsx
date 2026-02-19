import React from 'react';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { TypingIndicator } from '../chat/TypingIndicator';
import { useUIStore } from '../../stores/uiStore';

interface VoiceChatPanelProps {
  channelId: string;
  channelName: string;
}

export function VoiceChatPanel({ channelId, channelName }: VoiceChatPanelProps) {
  const toggleVoiceChat = useUIStore((s) => s.toggleVoiceChat);

  return (
    <div className="w-[340px] flex-shrink-0 bg-discord-bg-primary flex flex-col border-l border-[#2b2d31]">
      {/* Chat header */}
      <div className="h-12 px-4 flex items-center justify-between shadow-header flex-shrink-0">
        <span className="font-bold text-discord-text-primary text-[16px]">Chat</span>
        <button
          onClick={toggleVoiceChat}
          className="w-7 h-7 flex items-center justify-center text-discord-text-muted hover:text-discord-text-primary transition-colors rounded"
          title="Close Chat"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
          </svg>
        </button>
      </div>

      {/* Messages */}
      <MessageList channelId={channelId} />

      {/* Typing indicator */}
      <TypingIndicator channelId={channelId} />

      {/* Input */}
      <MessageInput channelId={channelId} channelName={channelName} />
    </div>
  );
}
