import React, { useEffect, useId, useRef } from 'react';
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

/**
 * The instrument band along the top of the comm panel. One uneven run of slot
 * indicators across the whole bezel, anchored by a level readout at the
 * centre, over a recessed bezel with a rail hairline lit only where the key
 * reaches it. The slots are wide and low, and the run starts well inboard of
 * the corner, so no three of them can ever read as a window's traffic lights.
 * Two sets of slots sit on the same spots: the standby set in `console` (sky)
 * and the hail set in `hail` (peach toward coral) whose opacity the stylesheet
 * animates. Every colour is a palette entry; every slot blooms with its own
 * gradient, so no filter is needed.
 */
function ConsoleStrip({ uid }: { uid: string }) {
  const bezel = `hail-bezel-${uid}`;
  const rail = `hail-rail-${uid}`;
  const standby = `hail-standby-${uid}`;
  const warm = `hail-warm-${uid}`;
  // x, width, and whether the slot warms with the hail. Widths in two sizes,
  // gaps that never repeat, and two slots that stay on standby so the warming
  // reads as some of the board, not the whole row.
  const slots: ReadonlyArray<readonly [number, number, boolean]> = [
    [58, 8, true],
    [78, 14, true],
    [104, 8, false],
    [124, 8, true],
    [200, 14, true],
    [226, 8, true],
    [246, 8, false],
    [280, 14, true],
  ];
  const drawSlots = (fill: string, gradient: string, className?: string) => (
    <g className={className}>
      {slots.map(([x, w, warms]) =>
        className && !warms ? null : (
          <g key={x}>
            <ellipse cx={x + w / 2} cy={13} rx={w * 1.1} ry={7} fill={`url(#${gradient})`} />
            <rect x={x} y={11.5} width={w} height={3} rx={1.5} fill={fill} />
            {/* the key on the upper edge of the dome */}
            <rect x={x + 1.5} y={11.9} width={w * 0.45} height={0.8} rx={0.4} fill={P.star} opacity="0.7" />
          </g>
        ),
      )}
    </g>
  );
  return (
    <svg className="hail__console" viewBox="0 0 340 26" preserveAspectRatio="xMinYMin meet" aria-hidden="true" focusable="false">
      <defs>
        {/* The bezel: recessed, so it shades from the top lip down into the deck. */}
        <linearGradient id={bezel} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={P.void} stopOpacity="0.55" />
          <stop offset="1" stopColor={P.void} stopOpacity="0" />
        </linearGradient>
        {/* The rail: a hairline that is lit from the left, where the key is. */}
        <linearGradient id={rail} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={P.star} stopOpacity="0.28" />
          <stop offset="0.3" stopColor={P.dust} stopOpacity="0.14" />
          <stop offset="0.75" stopColor={P.dust} stopOpacity="0.05" />
          <stop offset="1" stopColor={P.seat} stopOpacity="0.12" />
        </linearGradient>
        {/* Bloom for each set: the slot's own colour, falling to nothing. */}
        <radialGradient id={standby}>
          <stop offset="0" stopColor={P.console} stopOpacity="0.55" />
          <stop offset="0.4" stopColor={P.console} stopOpacity="0.16" />
          <stop offset="1" stopColor={P.console} stopOpacity="0" />
        </radialGradient>
        <radialGradient id={warm}>
          <stop offset="0" stopColor={P.hail} stopOpacity="0.65" />
          <stop offset="0.4" stopColor={P.hail} stopOpacity="0.2" />
          <stop offset="1" stopColor={P.hail} stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="340" height="26" fill={`url(#${bezel})`} />
      <rect x="0" y="25" width="340" height="1" fill={`url(#${rail})`} />
      {/* The level readout, centred over the source: five ticks at different
          heights, the shape of a signal that has just started arriving. */}
      <g fill={P.console} opacity="0.55">
        <rect x="160" y="15" width="1.5" height="4" rx="0.5" />
        <rect x="164" y="13" width="1.5" height="6" rx="0.5" />
        <rect x="168" y="10" width="1.5" height="9" rx="0.5" />
        <rect x="172" y="12" width="1.5" height="7" rx="0.5" />
        <rect x="176" y="16" width="1.5" height="3" rx="0.5" />
      </g>
      {drawSlots(P.console, standby)}
      {drawSlots(P.hail, warm, 'hail__console-warm')}
    </svg>
  );
}

export function IncomingCallModal() {
  const { t } = useTranslation(['voice', 'common']);
  const incomingCall = useVoiceStore((s) => s.incomingCall);
  const setIncomingCall = useVoiceStore((s) => s.setIncomingCall);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // React's ids carry colons, which are not safe inside url(#…) references.
  const uid = useId().replace(/:/g, '');

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

      {/* The comm panel. Every layer is described in IncomingCallModal.css. */}
      <div className="hail glass-modal rounded-xl w-[340px] max-w-[calc(100%-32px)] animate-fade-in animate-slide-up">
        <div className="hail__deck" aria-hidden="true" />
        <div className="hail__grain" aria-hidden="true" />
        <ConsoleStrip uid={uid} />
        <div className="hail__signal" aria-hidden="true">
          <span className="hail__bloom" />
          <span className="hail__ring hail__ring--a" />
          <span className="hail__ring hail__ring--b" />
        </div>
        <div className="hail__scrim" aria-hidden="true" />

        <div className="hail__body">
          {/* The source: the caller, in the port. */}
          <div className="hail__port">
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
