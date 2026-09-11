import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { parseFederatedUsername } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { Avatar } from '../ui/Avatar';
import type { User } from '@backspace/shared';
import { SCENE_PALETTE as P } from '../telemetry/scene/palette';
import './IncomingCallModal.css';

/** The palette's hail colour, handed to the stylesheet as one custom property. */
const HAIL_STYLE = { '--hail': P.hail } as React.CSSProperties;

export function IncomingCallModal() {
  const { t } = useTranslation(['voice', 'common']);
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

  const _FALLBACK_USER = { id: '', username: '', createdAt: 0, isAdmin: false, replicatedInstances: [] } as unknown as User;
  // Look up caller member before the early return so useCanonicalUserView is always called
  const _rawCallerMember = (() => {
    if (!incomingCall) return null;
    const dmChannel = dmChannels.find(d => d.id === incomingCall.dmChannelId);
    return dmChannel?.members.find(m => m.id === incomingCall.callerId) ?? null;
  })();
  const _canonicalCaller = useCanonicalUserView((_rawCallerMember as User | null) ?? _FALLBACK_USER);
  const callerMember = _rawCallerMember ? _canonicalCaller : null;

  if (!incomingCall) return null;

  const callerAvatarId = callerMember?.homeUserId ?? incomingCall.callerId;
  const { baseName: callerBaseName } = parseFederatedUsername(incomingCall.callerName);

  const handleAccept = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const dmChannelId = incomingCall.dmChannelId;
    const { callOrigin, federatedCallId, setActiveDmCall, connectFn } = useVoiceStore.getState();
    const origin = callOrigin || (dmChannelId ? getChannelOrigin(dmChannelId) : undefined);
    const callDmId = dmChannelId || federatedCallId!;

    // Immediately transition to active call state — don't wait for server response.
    // The dm_call_accepted event races with connectFn's async AudioContext resume,
    // causing isLiveKitConnected to be false when it arrives → activeDmCall never set.
    setIncomingCall(null);
    setActiveDmCall({ dmChannelId: callDmId });

    wsSend({ type: 'dm_call_accept', dmChannelId, federatedCallId }, origin);
    // Connect directly within gesture context (required for iOS audio permission)
    if (connectFn) connectFn(callDmId, true);
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
      <div className="absolute inset-0 modal-scrim" />

      {/* The panel. Every layer is described in IncomingCallModal.css. */}
      <div className="hail glass-modal rounded-xl w-[340px] max-w-[calc(100%-32px)] animate-fade-in animate-slide-up" style={HAIL_STYLE}>
        {/* The ring: leaves the avatar, fades before the edge. */}
        <span className="hail__ring" aria-hidden="true" />

        <div className="hail__body">
          <div className="hail__source">
            <Avatar
              src={callerMember?.avatar}
              avatarColor={callerMember?.avatarColor}
              userId={callerAvatarId}
              name={callerBaseName}
              size={80}
            />
          </div>

          <div className="hail__caller">
            <h3 className="hail__name">{callerBaseName}</h3>
            <p className="hail__status">{t('voice:incomingCall.status')}</p>
          </div>

          <div className="hail__answers">
            <button type="button" onClick={handleDecline} className="hail__decline" title={t('common:actions.decline')}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08c-.18-.17-.29-.42-.29-.7 0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28-.79-.74-1.69-1.36-2.67-1.85-.33-.16-.56-.5-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z" />
              </svg>
            </button>

            <button type="button" onClick={handleAccept} className="hail__accept" title={t('common:actions.accept')}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
