import { Tooltip } from '../ui/Tooltip';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { useUIStore } from '../../stores/uiStore';

interface VoiceChatPanelProps {
  channelId: string;
  channelName: string;
}

export function VoiceChatPanel({ channelId, channelName }: VoiceChatPanelProps) {
  const { t } = useTranslation(['voice', 'common']);
  const toggleVoiceChat = useUIStore((s) => s.toggleVoiceChat);
  const voiceChatFocus = useUIStore((s) => s.voiceChatFocus);
  const toggleVoiceChatFocus = useUIStore((s) => s.toggleVoiceChatFocus);

  return (
    <div
      data-testid="voice-chat-panel"
      className={`relative min-h-0 overflow-hidden bg-surface-chat flex flex-col ${
        voiceChatFocus
          ? 'flex-1 min-w-0'
          : 'w-[340px] min-w-[280px] max-w-[42%] flex-shrink-0 border-l border-border-soft'
      }`}
    >
      {/* Chat header */}
      <div className="h-12 px-4 flex items-center justify-between shadow-header flex-shrink-0">
        <span className="font-bold text-txt-primary text-ui-lead">{t('voice:chatPanel.title')}</span>
        <div className="flex items-center gap-1">
          <Tooltip content={voiceChatFocus ? t('voice:chatPanel.collapse') : t('voice:chatPanel.expand')} position="top"><button data-icon-motion="expand" aria-label={voiceChatFocus ? t('voice:chatPanel.collapse') : t('voice:chatPanel.expand')}
            onClick={toggleVoiceChatFocus}
            aria-pressed={voiceChatFocus}
            className={`w-7 h-7 flex items-center justify-center transition-colors rounded ${
              voiceChatFocus
                ? 'text-txt-primary bg-interactive-hover'
                : 'text-txt-tertiary hover:text-txt-primary'
            }`}

          >
            {voiceChatFocus ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z" />
              </svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
              </svg>
            )}
          </button></Tooltip>
          <Tooltip content={t('voice:chatPanel.close')} position="top"><button data-icon-motion="press" aria-label={t('voice:chatPanel.close')}
            onClick={toggleVoiceChat}
            className="w-7 h-7 flex items-center justify-center text-txt-tertiary hover:text-txt-primary transition-colors rounded"

          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button></Tooltip>
        </div>
      </div>

      {/* Messages */}
      <MessageList channelId={channelId} />

      {/* Input */}
      <MessageInput channelId={channelId} channelName={channelName} />
    </div>
  );
}
