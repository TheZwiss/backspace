import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useVoiceStore } from '../../stores/voiceStore';
import { useUIStore } from '../../stores/uiStore';
import { useChatStore } from '../../stores/chatStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { MessageList } from '../chat/MessageList';
import { MessageInput } from '../chat/MessageInput';
import { TransferIndicator } from './TransferIndicator';
import { userDisplayName } from '../../utils/identity';
import { formatDmHeaderName, formatDmInputLabel, isDeletedPartnerDm } from '../../utils/dmFormatters';
import { DmDeletedNotice } from '../chat/DmDeletedNotice';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { canStartDmCall, startDmCall, cancelOutgoingDmCall } from '../../utils/voiceActions';
import type { User } from '@backspace/shared';

const FALLBACK_USER = { id: '', username: '', createdAt: 0, isAdmin: false, replicatedInstances: [] } as unknown as User;

interface MobileChatScreenProps {
  params?: Record<string, string>;
}

export function MobileChatScreen({ params }: MobileChatScreenProps) {
  const { t } = useTranslation(['mobile', 'spaces', 'dm', 'common']);
  const outgoingCall = useVoiceStore((s) => s.outgoingCall);
  const activeDmCall = useVoiceStore((s) => s.activeDmCall);
  const canStartCall = useVoiceStore(canStartDmCall);
  const popMobileScreen = useUIStore((s) => s.popMobileScreen);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const channelId = params?.channelId;
  const spaceId = params?.spaceId;
  const isDm = spaceId === '@me';

  const loadMessages = useChatStore((s) => s.loadMessages);
  const setCurrentChannel = useChatStore((s) => s.setCurrentChannel);
  const channels = useSpaceStore((s) => s.channels);
  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const authUser = useAuthStore((s) => s.user);

  useEffect(() => {
    if (!channelId) return;
    setCurrentChannel(channelId);
    loadMessages(channelId);
  }, [channelId, setCurrentChannel, loadMessages]);

  // Resolve the "main other member" of a 1:1 DM up-front so we can route it
  // through useCanonicalUserView (hook, must run unconditionally). Group DMs
  // don't get the cache treatment in the header — the comma-joined title falls
  // back to per-member parseFederatedUsername normalization, matching the
  // pattern in MobileDmsScreen.
  const dm = isDm && channelId ? dmChannels.find(d => d.id === channelId) : undefined;
  const otherMembers = dm ? dm.members.filter(m => m.id !== authUser?.id) : [];
  const isGroup = !!dm?.ownerId;
  const rawMainOther = !isGroup ? otherMembers[0] : undefined;
  const canonicalMainOther = useCanonicalUserView((rawMainOther as unknown as User) ?? FALLBACK_USER);
  const dmPartnerDeleted = dm ? isDeletedPartnerDm(dm, authUser) : false;
  // The header call button has four states, in this order of precedence:
  // in a call with this DM (opens the call screen), ringing this DM (cancels),
  // idle (starts a call), and busy (disabled: `canStartDmCall` refuses while
  // any DM call rings or runs, including one ringing in from this DM).
  const callState: 'inCall' | 'ringing' | 'idle' | 'busy' =
    !!channelId && activeDmCall?.dmChannelId === channelId ? 'inCall'
      : !!channelId && outgoingCall?.dmChannelId === channelId ? 'ringing'
        : canStartCall ? 'idle' : 'busy';
  const handleCall = () => {
    if (!channelId || !dm || dmPartnerDeleted) return;
    if (callState === 'inCall') pushMobileScreen('voice-full');
    else if (callState === 'ringing') cancelOutgoingDmCall(channelId);
    else startDmCall(channelId);
  };
  const callLabel = callState === 'inCall'
    ? t('mobile:chat.openCall')
    : callState === 'ringing' ? t('mobile:chat.cancelCall') : t('spaces:main.dm.startVoiceCall');
  const callChipClass = callState === 'inCall'
    ? 'bg-accent-mint/20 text-accent-mint group-hover:bg-accent-mint/30'
    : callState === 'ringing'
      ? 'bg-accent-rose/20 text-accent-rose group-hover:bg-accent-rose/30'
      : callState === 'idle' ? 'text-txt-secondary group-hover:text-txt-primary' : 'text-txt-tertiary/60';

  // Resolve channel/DM name. Group DMs route through `formatDmHeaderName` so
  // a renamed group shows `dm.name` (previously this surface silently dropped
  // it and always rendered the joined-names fallback). 1-on-1 DMs keep the
  // canonical-view lookup so replicated aliases still surface the home
  // account's displayName.
  let channelName: string;
  let inputPlaceholder: string | undefined;
  if (isDm) {
    channelName = t('spaces:main.dm.fallbackName');
    if (dm && isGroup) {
      channelName = formatDmHeaderName(dm, authUser);
      inputPlaceholder = t('spaces:main.dm.composerPlaceholder', { target: formatDmInputLabel(dm, authUser) });
    } else if (dm && rawMainOther) {
      channelName = userDisplayName(canonicalMainOther);
      // Use the canonical `channelName` directly so header + placeholder stay
      // aligned even when the raw partner and canonical view disagree.
      inputPlaceholder = t('spaces:main.dm.composerPlaceholder', { target: `@${channelName}` });
    }
  } else {
    const ch = channelId ? channels.find(c => c.id === channelId) : undefined;
    channelName = ch?.name || t('mobile:chat.unknownChannel');
  }

  return (
    <div className="flex flex-col h-full bg-surface-chat">
      {/* Header */}
      <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft bg-surface-base shrink-0">
        <button
          type="button"
          onClick={popMobileScreen}
          className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
          aria-label={t('common:actions.back')}
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h1 className="text-sm font-semibold text-txt-primary truncate">
            {isDm ? channelName : `# ${channelName}`}
          </h1>
        </div>
        <TransferIndicator />
        {/* DM call button. The 44px button is the tap target; what is drawn is
            the inner 32px chip, so the header keeps one icon rhythm (-mx-1.5
            gives the extra tap area back to the gaps). Idle and busy are bare
            icons like the other header actions; ringing and in-call get the
            round tinted chip the voice mini bar uses for its call controls. */}
        {dm && !dmPartnerDeleted && (
          <button
            type="button"
            onClick={handleCall}
            disabled={callState === 'busy'}
            className="group w-11 h-11 -mx-1.5 shrink-0 flex items-center justify-center rounded-full disabled:cursor-not-allowed"
            aria-label={callLabel}
          >
            <span className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${callChipClass}`}>
              <svg className={`w-5 h-5 ${callState === 'ringing' ? 'rotate-[135deg]' : ''}`} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
              </svg>
            </span>
          </button>
        )}
        {/* Members button — shown for space channels AND group DMs. 1-on-1
            DMs have no roster, so it stays hidden there. Tapping a space-
            channel button pushes the regular `members` screen; tapping a
            group-DM button pushes the new `group-dm-info` screen so the user
            lands on the full info + management surface. */}
        {(!isDm || isGroup) && (
          <button
            onClick={() => {
              if (isDm && isGroup && channelId) {
                pushMobileScreen('group-dm-info', { channelId });
              } else {
                pushMobileScreen('members');
              }
            }}
            type="button"
            className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
            aria-label={isDm && isGroup ? t('dm:groupInfo.title') : t('common:labels.members')}
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
            </svg>
          </button>
        )}
      </header>

      {/* Messages + floating composer.
          Mirrors the desktop pattern in `MainContent.tsx`: a single relative
          flex-1 region holds both `<MessageList>` (filling the area) and
          `<MessageInput>` (floating glass-bubble at the bottom). The bubble
          is `position: absolute` and is positioned from `MessageInput.tsx`
          via the `useVisualViewportInset` hook so it lifts above the iOS
          soft keyboard when one is open and rests above the home-indicator
          safe-area when not. MessageList content carries `pb-20` so the last
          message can scroll fully into view above the bubble.
          TypingIndicator is rendered inside MessageInput itself (anchored
          `absolute bottom-full` to the bubble), so we don't render it here. */}
      <div className="relative flex-1 min-h-0 flex flex-col overflow-hidden">
        {channelId && <MessageList channelId={channelId} />}
        {channelId && (dmPartnerDeleted
          ? <DmDeletedNotice />
          : <MessageInput channelId={channelId} channelName={channelName} placeholder={inputPlaceholder} />)}
      </div>
    </div>
  );
}
