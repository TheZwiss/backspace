import React, { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { getAvatarGradient } from '../../utils/gradients';
import { parseFederatedUsername } from '../../utils/identity';

export function IncomingCallModal() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const setIncomingCall = useVoiceStore((s) => s.setIncomingCall);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss after 30 seconds
  useEffect(() => {
    if (incomingCall) {
      timerRef.current = setTimeout(() => {
        // Auto-reject after timeout
        wsSend({ type: 'dm_call_reject', dmChannelId: incomingCall.dmChannelId });
        setIncomingCall(null);
      }, 30000);
    }
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [incomingCall, setIncomingCall]);

  const dmChannels = useSpaceStore((s) => s.dmChannels);

  if (!incomingCall) return null;

  // Look up the caller in DM channel members for homeUserId
  const dmChannel = dmChannels.find(d => d.id === incomingCall.dmChannelId);
  const callerMember = dmChannel?.members.find(m => m.id === incomingCall.callerId);
  const callerAvatarId = callerMember?.homeUserId ?? incomingCall.callerId;
  const { baseName: callerBaseName } = parseFederatedUsername(incomingCall.callerName);

  const handleAccept = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    wsSend({ type: 'dm_call_accept', dmChannelId: incomingCall.dmChannelId });
  };

  const handleDecline = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    wsSend({ type: 'dm_call_reject', dmChannelId: incomingCall.dmChannelId });
    setIncomingCall(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Call card */}
      <div className="relative glass-modal rounded-lg w-[340px] overflow-hidden">
        {/* Ring animation background */}
        <div className="absolute inset-0 overflow-hidden">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200px] h-[200px] rounded-full bg-status-online/5 animate-ping" style={{ animationDuration: '2s' }} />
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[150px] h-[150px] rounded-full bg-status-online/10 animate-ping" style={{ animationDuration: '2s', animationDelay: '0.5s' }} />
        </div>

        {/* Content */}
        <div className="relative p-8 flex flex-col items-center gap-4">
          {/* Caller avatar */}
          <div className="relative">
            <div className="w-20 h-20 rounded-full flex items-center justify-center text-white text-3xl font-bold" style={{ background: getAvatarGradient(callerAvatarId, callerBaseName).gradient }}>
              {callerBaseName.charAt(0).toUpperCase()}
            </div>
            {/* Ringing phone icon */}
            <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-status-online flex items-center justify-center">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </div>
          </div>

          {/* Caller info */}
          <div className="text-center">
            <h3 className="text-[20px] font-bold text-txt-primary">{callerBaseName}</h3>
            <p className="text-[14px] text-txt-tertiary mt-1">Incoming Voice Call...</p>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-6 mt-2">
            {/* Decline */}
            <button
              onClick={handleDecline}
              className="w-14 h-14 rounded-full bg-accent-rose hover:bg-accent-rose/80 flex items-center justify-center transition-colors group"
              title="Decline"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="white" className="group-hover:scale-110 transition-transform">
                <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
              </svg>
            </button>

            {/* Accept */}
            <button
              onClick={handleAccept}
              className="w-14 h-14 rounded-full bg-status-online hover:bg-status-online/80 flex items-center justify-center transition-colors group"
              title="Accept"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="white" className="group-hover:scale-110 transition-transform">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
