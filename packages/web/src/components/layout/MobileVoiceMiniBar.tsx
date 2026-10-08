import React from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useActiveDmCall } from '../../hooks/useActiveDmCall';
import { handleDisconnectAction, reconnectVoice } from '../../utils/voiceActions';

/**
 * The bar above the bottom navigation while the user is in voice: a voice
 * channel or a DM call. Tapping it opens the call screen.
 */
export function MobileVoiceMiniBar() {
  const { t } = useTranslation(['voice', 'spaces']);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const mobileStack = useUIStore((s) => s.mobileStack);

  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const toggleMute = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const participants = useVoiceStore((s) => s.participants);
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const voiceConnectionStatus = useVoiceStore((s) => s.voiceConnectionStatus);
  const connectionError = useVoiceStore((s) => s.connectionError);

  const channels = useSpaceStore((s) => s.channels);
  const { title: dmCallTitle } = useActiveDmCall();

  if (!currentVoiceChannelId && !activeDmCall) return null;

  // Don't show mini-bar if voice full-screen is on top of the stack
  const topEntry = mobileStack.length > 0 ? mobileStack[mobileStack.length - 1] : undefined;
  const topScreen = topEntry?.screen ?? null;
  if (topScreen === 'voice-full') return null;

  // A DM call has no voice channel (the two are exclusive): it is named by
  // its conversation, and counted from the LiveKit room, since a call hosted
  // on another instance has no voice states here.
  const channel = currentVoiceChannelId ? channels.find(c => c.id === currentVoiceChannelId) : undefined;
  const channelName = currentVoiceChannelId
    ? channel?.name ?? t('voice:status.voiceCall')
    : dmCallTitle ?? t('voice:status.dmCall');
  const participantCount = currentVoiceChannelId
    ? voiceUsers.get(currentVoiceChannelId)?.length ?? 0
    : participants.length;

  // The desktop sidebar carries this state in VoiceControls, which is not
  // mounted on mobile. Without it a dropped session looks identical to a live
  // one here, down to the stale participant count.
  const isReconnecting = voiceConnectionStatus === 'reconnecting';
  const isDropped = voiceConnectionStatus === 'disconnected' && !!connectionError;
  const accentClass = isDropped
    ? 'text-accent-rose'
    : isReconnecting ? 'text-accent-amber' : 'text-accent-mint';


  return (
    <div className="glass-bubble mx-2 mb-1 rounded-2xl flex items-center gap-2 px-3 py-2 shrink-0">
      {/* Tap to expand */}
      <button
        onClick={() => pushMobileScreen('voice-full')}
        className="flex-1 flex items-center gap-2 min-w-0"
      >
        <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
          isDropped ? 'bg-accent-rose/20' : isReconnecting ? 'bg-accent-amber/20' : 'bg-accent-mint/20'
        }`}>
          <svg className={`w-4 h-4 ${accentClass}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className={`text-xs font-medium truncate ${accentClass}`}>{channelName}</p>
          {isReconnecting ? (
            <p className="text-[10px] text-txt-tertiary">{t('voice:status.reconnecting')}</p>
          ) : isDropped ? (
            <p className="text-[10px] text-txt-tertiary">{t('voice:status.disconnected')}</p>
          ) : participantCount > 0 ? (
            <p className="text-[10px] text-txt-tertiary">{t('spaces:main.voice.participants', { count: participantCount })}</p>
          ) : null}
        </div>
      </button>

      {isDropped && (
        <button
          onClick={(e) => { e.stopPropagation(); reconnectVoice(); }}
          className="px-2 h-8 rounded-full text-[11px] font-medium text-accent-primary hover:bg-interactive-hover transition-colors shrink-0"
        >
          {t('voice:status.retry')}
        </button>
      )}

      {/* Quick controls */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); toggleMute(); }}
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
            isMuted ? 'bg-accent-rose/20 text-accent-rose' : 'text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover'
          }`}
          aria-label={isMuted ? t('voice:controls.unmute') : t('voice:controls.mute')}
        >
          {isMuted ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z" />
            </svg>
          )}
        </button>

        <button
          onClick={(e) => { e.stopPropagation(); toggleDeafen(); }}
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
            isDeafened ? 'bg-accent-rose/20 text-accent-rose' : 'text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover'
          }`}
          aria-label={isDeafened ? t('voice:controls.undeafen') : t('voice:controls.deafen')}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            {isDeafened && <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />}
          </svg>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            handleDisconnectAction();
          }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-accent-rose/20 text-accent-rose hover:bg-accent-rose/30 transition-colors"
          aria-label={t('voice:mobileCall.disconnect')}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
