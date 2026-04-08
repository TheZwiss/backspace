import React, { useEffect, useRef } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { parseFederatedUsername } from '../../utils/identity';
import { Avatar } from '../ui/Avatar';

export function IncomingCallModal() {
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const setIncomingCall = useVoiceStore((s) => s.setIncomingCall);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-dismiss after 30 seconds
  useEffect(() => {
    if (incomingCall) {
      timerRef.current = setTimeout(() => {
        // Auto-reject after timeout
        const { callOrigin, federatedCallId } = useVoiceStore.getState();
        const origin = callOrigin || (incomingCall.dmChannelId ? getChannelOrigin(incomingCall.dmChannelId) : undefined);
        wsSend({ type: 'dm_call_reject', dmChannelId: incomingCall.dmChannelId, federatedCallId }, origin);
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
    const dmChannelId = incomingCall.dmChannelId;
    const { callOrigin, federatedCallId } = useVoiceStore.getState();
    const origin = callOrigin || (dmChannelId ? getChannelOrigin(dmChannelId) : undefined);
    wsSend({ type: 'dm_call_accept', dmChannelId, federatedCallId }, origin);
    // Connect directly within gesture context (required for iOS audio permission)
    const connectFn = useVoiceStore.getState().connectFn;
    if (connectFn) connectFn(dmChannelId || federatedCallId!, true);
  };

  const handleDecline = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const { callOrigin, federatedCallId } = useVoiceStore.getState();
    const dmChannelId = incomingCall.dmChannelId;
    const origin = callOrigin || (dmChannelId ? getChannelOrigin(dmChannelId) : undefined);
    wsSend({ type: 'dm_call_reject', dmChannelId, federatedCallId }, origin);
    setIncomingCall(null);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" />

      {/* Call card */}
      <div className="relative glass-modal call-refraction rounded-lg w-[340px] overflow-hidden animate-fade-in animate-slide-up">
        {/* Liquid ripple orbs — soft radial gradients with blur */}
        <div className="absolute inset-0 overflow-hidden pointer-events-none">
          {[0, 1.3, 2.6].map((delay, i) => (
            <div
              key={i}
              className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[180px] h-[180px] rounded-full blur-xl animate-call-ripple"
              style={{
                animationDelay: `${delay}s`,
                background: 'radial-gradient(circle, rgba(134,239,172,0.18) 0%, rgba(134,239,172,0.06) 35%, rgba(134,239,172,0.02) 55%, transparent 70%)',
              }}
            />
          ))}
        </div>

        {/* Content */}
        <div className="relative z-[2] p-8 flex flex-col items-center gap-4">
          {/* Caller avatar */}
          <div className="rounded-full animate-call-glow">
            <Avatar
              src={callerMember?.avatar}
              avatarColor={callerMember?.avatarColor}
              userId={callerAvatarId}
              name={callerBaseName}
              size={80}
            />
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
              className="w-14 h-14 rounded-full bg-accent-rose/20 border border-accent-rose/30 backdrop-blur-sm flex items-center justify-center transition-all duration-200 hover:bg-accent-rose/35 group"
              title="Decline"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" className="text-accent-rose group-hover:scale-110 transition-transform">
                <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
              </svg>
            </button>

            {/* Accept */}
            <button
              onClick={handleAccept}
              className="w-14 h-14 rounded-full bg-status-online/20 border border-status-online/30 backdrop-blur-sm flex items-center justify-center transition-all duration-200 hover:bg-status-online/35 animate-call-button-glow group"
              title="Accept"
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" className="text-status-online group-hover:scale-110 transition-transform">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
