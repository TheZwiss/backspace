import React from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';

export function MobileVoiceMiniBar() {
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const mobileStack = useUIStore((s) => s.mobileStack);

  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const isMuted = useVoiceStore((s) => s.isMuted);
  const isDeafened = useVoiceStore((s) => s.isDeafened);
  const toggleMute = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const leaveVoice = useVoiceStore((s) => s.leaveVoice);

  const channels = useSpaceStore((s) => s.channels);
  const dmChannels = useSpaceStore((s) => s.dmChannels);

  if (!currentVoiceChannelId) return null;

  // Don't show mini-bar if voice full-screen is on top of the stack
  const topEntry = mobileStack.length > 0 ? mobileStack[mobileStack.length - 1] : undefined;
  const topScreen = topEntry?.screen ?? null;
  if (topScreen === 'voice-full') return null;

  // Resolve channel name
  const isDmCall = currentVoiceChannelId.startsWith('dm-');
  let channelName = 'Voice Call';
  if (isDmCall) {
    const dmId = currentVoiceChannelId.replace('dm-', '');
    const dm = dmChannels.find(d => d.id === dmId);
    if (dm) channelName = 'DM Call';
  } else {
    const ch = channels.find(c => c.id === currentVoiceChannelId);
    if (ch) channelName = ch.name;
  }

  const participantCount = voiceUsers.get(currentVoiceChannelId)?.length ?? 0;

  return (
    <div className="glass-bubble mx-2 mb-1 rounded-2xl flex items-center gap-2 px-3 py-2 shrink-0">
      {/* Tap to expand */}
      <button
        onClick={() => pushMobileScreen('voice-full')}
        className="flex-1 flex items-center gap-2 min-w-0"
      >
        <div className="w-8 h-8 rounded-full bg-accent-mint/20 flex items-center justify-center shrink-0">
          <svg className="w-4 h-4 text-accent-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
          </svg>
        </div>
        <div className="min-w-0">
          <p className="text-xs font-medium text-accent-mint truncate">{channelName}</p>
          {participantCount > 0 && (
            <p className="text-[10px] text-txt-tertiary">{participantCount} connected</p>
          )}
        </div>
      </button>

      {/* Quick controls */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={(e) => { e.stopPropagation(); toggleMute(); }}
          className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
            isMuted ? 'bg-accent-rose/20 text-accent-rose' : 'text-txt-secondary hover:text-txt-primary hover:bg-interactive-hover'
          }`}
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
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
            {isDeafened && <path strokeLinecap="round" strokeLinejoin="round" d="M3 3l18 18" />}
          </svg>
        </button>

        <button
          onClick={(e) => {
            e.stopPropagation();
            const { activeDmCall, disconnectFn } = useVoiceStore.getState();
            if (activeDmCall) {
              wsSend({ type: 'dm_call_end', dmChannelId: activeDmCall.dmChannelId }, getChannelOrigin(activeDmCall.dmChannelId));
              useVoiceStore.getState().setActiveDmCall(null);
            } else if (currentVoiceChannelId) {
              wsSend({ type: 'voice_leave' }, getChannelOrigin(currentVoiceChannelId));
              leaveVoice();
            }
            if (disconnectFn) disconnectFn();
          }}
          className="w-8 h-8 rounded-full flex items-center justify-center bg-accent-rose/20 text-accent-rose hover:bg-accent-rose/30 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
          </svg>
        </button>
      </div>
    </div>
  );
}
