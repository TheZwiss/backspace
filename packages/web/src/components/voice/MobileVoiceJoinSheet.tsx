import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { VoiceUserRow } from './VoiceUserRow';

interface MobileVoiceJoinSheetProps {
  channelId: string;
  channelName: string;
  spaceId: string;
  onClose: () => void;
  onJoin: (channelId: string, preMuted: boolean) => void;
}

export function MobileVoiceJoinSheet({
  channelId,
  channelName,
  spaceId,
  onClose,
  onJoin,
}: MobileVoiceJoinSheetProps) {
  const [preMuted, setPreMuted] = useState(false);
  const [visible, setVisible] = useState(false);

  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const voiceUserStates = useVoiceStore((s) => s.voiceUserStates);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const spaceMutedUserIds = useVoiceStore((s) => s.spaceMutedUserIds);
  const spaceDeafenedUserIds = useVoiceStore((s) => s.spaceDeafenedUserIds);
  const permissionMutedUserIds = useVoiceStore((s) => s.permissionMutedUserIds);
  const speakingUserIds = useVoiceStore((s) => s.speakingUserIds);

  const members = useSpaceStore((s) => s.members);
  const channels = useSpaceStore((s) => s.channels);

  // Trigger slide-up animation on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setVisible(true);
      });
    });
  }, []);

  const userIds = useMemo(() => voiceUsers.get(channelId) || [], [voiceUsers, channelId]);

  const userCount = userIds.length;
  const userCountLabel = userCount === 1 ? '1 Person in Voice' : `${userCount} People in Voice`;

  // Determine if switching channels
  const isSwitching = currentVoiceChannelId !== null && currentVoiceChannelId !== channelId;
  const currentChannelName = useMemo(() => {
    if (!currentVoiceChannelId) return '';
    const ch = channels.find((c) => c.id === currentVoiceChannelId);
    return ch?.name || '';
  }, [currentVoiceChannelId, channels]);

  const handleJoin = useCallback(() => {
    onJoin(channelId, preMuted);
  }, [channelId, preMuted, onJoin]);

  const handleBackdropClick = useCallback(() => {
    onClose();
  }, [onClose]);

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-50"
        onClick={handleBackdropClick}
      />

      {/* Sheet container */}
      <div
        className={`glass-bubble fixed bottom-0 left-0 right-0 z-50 rounded-t-2xl transition-transform duration-300 ease-out ${
          visible ? 'translate-y-0' : 'translate-y-full'
        }`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {/* Drag handle */}
        <div className="w-10 h-1 rounded-full bg-white/20 mx-auto mt-3 mb-4" />

        {/* Header */}
        <div className="flex items-center justify-between px-5 mb-2">
          <h2 className="text-base font-bold text-txt-primary truncate">{channelName}</h2>
        </div>

        {/* User count */}
        {userCount > 0 && (
          <p className="text-sm text-txt-tertiary px-5 mb-3">{userCountLabel}</p>
        )}

        {/* Channel switch warning */}
        {isSwitching && (
          <div className="mx-5 mb-3 px-3 py-2 rounded-lg bg-accent-amber/10 text-accent-amber text-xs">
            You'll leave <span className="font-semibold">{currentChannelName}</span> and join{' '}
            <span className="font-semibold">{channelName}</span>
          </div>
        )}

        {/* User list */}
        {userCount > 0 && (
          <div className="max-h-60 overflow-y-auto px-5 mb-4">
            <div className="space-y-1">
              {userIds.map((userId) => {
                const member = members.find((m) => m.userId === userId);
                const displayName =
                  member?.user.displayName ?? member?.user.username ?? userId;
                const avatar = member?.user.avatar ?? null;
                const avatarColor = member?.user.avatarColor;
                const wsStatus = voiceUserStates.get(userId);
                const isMuted = wsStatus?.isMuted ?? false;
                const isDeafened = wsStatus?.isDeafened ?? false;
                const isCameraOn = wsStatus?.isCameraOn ?? false;
                const isScreenSharing = wsStatus?.isScreenSharing ?? false;
                const isSpaceMuted = spaceMutedUserIds.has(`${spaceId}:${userId}`);
                const isSpaceDeafened = spaceDeafenedUserIds.has(`${spaceId}:${userId}`);
                const isPermMuted = permissionMutedUserIds.has(`${spaceId}:${userId}`);

                return (
                  <div key={userId} className="py-1.5 rounded-lg">
                    <VoiceUserRow
                      userId={member?.user.homeUserId ?? userId}
                      displayName={displayName}
                      avatar={avatar}
                      avatarColor={avatarColor ?? undefined}
                      isMuted={isMuted}
                      isDeafened={isDeafened}
                      isCameraOn={isCameraOn}
                      isScreenSharing={isScreenSharing}
                      isServerMuted={isSpaceMuted}
                      isServerDeafened={isSpaceDeafened}
                      isPermissionMuted={isPermMuted}
                      isSpeaking={speakingUserIds.has(userId)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Empty state */}
        {userCount === 0 && (
          <div className="px-5 mb-4 py-6 text-center">
            <p className="text-sm text-txt-tertiary">No one is in this channel yet.</p>
            <p className="text-xs text-txt-tertiary/60 mt-1">Be the first to join!</p>
          </div>
        )}

        {/* Bottom action bar */}
        <div className="flex items-center justify-between px-6 py-4">
          {/* Mic toggle */}
          <button
            onClick={() => setPreMuted(!preMuted)}
            className="w-12 h-12 bg-surface-elevated rounded-full flex items-center justify-center text-txt-secondary active:scale-95 transition-transform"
            aria-label={preMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {preMuted ? (
              /* Mic off icon */
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-txt-danger">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                <line x1="3" y1="3" x2="21" y2="21" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
              </svg>
            ) : (
              /* Mic on icon */
              <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" className="text-txt-primary">
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
              </svg>
            )}
          </button>

          {/* Join Voice button */}
          <button
            onClick={handleJoin}
            className="bg-accent-mint text-black font-semibold rounded-full px-8 py-3 active:scale-95 transition-transform"
          >
            {isSwitching ? 'Switch Channel' : 'Join Voice'}
          </button>

          {/* Chat button — navigates to associated text channel (placeholder for future) */}
          <button
            onClick={onClose}
            className="w-12 h-12 bg-surface-elevated rounded-full flex items-center justify-center text-txt-secondary active:scale-95 transition-transform"
            aria-label="Close"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
}
