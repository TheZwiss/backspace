import React from 'react';
import type { ContextMenuItem } from '../../stores/contextMenuStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSpaceStore, getChannelOrigin } from '../../stores/spaceStore';
import { wsSend } from '../../hooks/useWebSocket';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';

/**
 * Build moderation context menu items for a voice user.
 * Called imperatively at right-click time (not during render).
 */
export function buildVoiceModMenuItems(targetUserId: string, channelId: string): ContextMenuItem[] {
  const { spacePermissions, currentSpaceId, channels, channelToSpaceMap } = useSpaceStore.getState();
  const { spaceMutedUserIds, spaceDeafenedUserIds } = useVoiceStore.getState();

  const myPerms = currentSpaceId ? spacePermissions.get(currentSpaceId) : undefined;
  const canMuteMembers = hasPermissionBit(myPerms, PermissionBits.MUTE_MEMBERS);
  const canDeafenMembers = hasPermissionBit(myPerms, PermissionBits.DEAFEN_MEMBERS);
  const canMoveMembers = hasPermissionBit(myPerms, PermissionBits.MOVE_MEMBERS);
  const canDisconnectMembers = hasPermissionBit(myPerms, PermissionBits.DISCONNECT_MEMBERS);

  if (!canMuteMembers && !canDeafenMembers && !canMoveMembers && !canDisconnectMembers) return [];

  const voiceOrigin = getChannelOrigin(channelId);
  const spaceId = channelToSpaceMap.get(channelId);
  const isSpaceMuted = spaceMutedUserIds.has(`${spaceId}:${targetUserId}`);
  const isSpaceDeafened = spaceDeafenedUserIds.has(`${spaceId}:${targetUserId}`);
  const otherVoiceChannels = channels.filter(c => c.type === 'voice' && c.id !== channelId);

  const items: ContextMenuItem[] = [];

  if (canMuteMembers) {
    items.push({
      key: 'space-mute',
      type: 'action',
      label: isSpaceMuted ? 'Space Unmute' : 'Space Mute',
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z' }),
        React.createElement('path', { d: 'M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z' }),
        ...(isSpaceMuted
          ? [React.createElement('line', { key: 'slash', x1: 3, y1: 3, x2: 21, y2: 21, stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' })]
          : []),
      ),
      onClick: () => wsSend({ type: 'voice_space_mute', userId: targetUserId, muted: !isSpaceMuted }, voiceOrigin),
    });
  }

  if (canDeafenMembers) {
    items.push({
      key: 'space-deafen',
      type: 'action',
      label: isSpaceDeafened ? 'Space Undeafen' : 'Space Deafen',
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M12 3c-4.97 0-9 4.03-9 9v7c0 1.1.9 2 2 2h2v-7H5v-2c0-3.87 3.13-7 7-7s7 3.13 7 7v2h-2v7h2c1.1 0 2-.9 2-2v-7c0-4.97-4.03-9-9-9z' }),
        ...(isSpaceDeafened
          ? [React.createElement('line', { key: 'slash', x1: 3, y1: 3, x2: 21, y2: 21, stroke: 'currentColor', strokeWidth: 2.5, strokeLinecap: 'round' })]
          : []),
      ),
      onClick: () => wsSend({ type: 'voice_space_deafen', userId: targetUserId, deafened: !isSpaceDeafened }, voiceOrigin),
    });
  }

  if (canDisconnectMembers) {
    items.push({ key: 'mod-sep', type: 'separator' });
    items.push({
      key: 'disconnect',
      type: 'action',
      label: 'Disconnect',
      danger: true,
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 010-1.36C3.36 8.68 7.42 7 12 7s8.64 1.68 11.71 4.72c.18.18.29.44.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.11-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z' }),
      ),
      onClick: () => wsSend({ type: 'voice_disconnect', userId: targetUserId }, voiceOrigin),
    });
  }

  if (canMoveMembers && otherVoiceChannels.length > 0) {
    items.push({ key: 'move-sep', type: 'separator' });
    items.push({
      key: 'move-to',
      type: 'submenu',
      label: 'Move to',
      icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0' },
        React.createElement('path', { d: 'M14 4l2.29 2.29-2.88 2.88 1.42 1.42 2.88-2.88L20 10V4h-6zM10 4H4v6l2.29-2.29 4.71 4.7V20h2v-8.41l-5.29-5.3L10 4z' }),
      ),
      children: otherVoiceChannels.map(ch => ({
        key: ch.id,
        type: 'action' as const,
        label: ch.name,
        icon: React.createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'currentColor', className: 'flex-shrink-0 text-txt-tertiary' },
          React.createElement('path', { d: 'M11 5L6 9H2V15H6L11 19V5ZM15.54 8.46C16.48 9.4 17 10.67 17 12S16.48 14.6 15.54 15.54L14.12 14.12C14.69 13.55 15 12.79 15 12S14.69 10.45 14.12 9.88L15.54 8.46Z' }),
        ),
        onClick: () => wsSend({ type: 'voice_move', userId: targetUserId, targetChannelId: ch.id }, voiceOrigin),
      })),
    });
  }

  return items;
}

// ── Shared custom menu item components ────────────────────────────────────

/**
 * Volume slider for a voice participant, used as a `custom` context menu item.
 * Must be a component (not a plain function) because it subscribes to store state.
 */
export function VolumeSliderItem({ userId }: { userId: string }) {
  const volume = useVoiceStore((s) => s.participantVolumes.get(userId) ?? 100);
  const setParticipantVolume = useVoiceStore((s) => s.setParticipantVolume);

  return (
    <div className="p-3">
      <div className="text-xs text-txt-tertiary mb-2 font-medium uppercase tracking-wider">
        User Volume
      </div>
      <div className="flex items-center gap-2">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
          <path d="M3 9v6h4l5 5V4L7 9H3z" />
        </svg>
        <input
          type="range"
          min="0"
          max="200"
          value={volume}
          onChange={(e) => setParticipantVolume(userId, parseInt(e.target.value))}
          className="flex-1 accent-accent-primary h-1"
        />
        <span className="text-xs text-txt-secondary min-w-[32px] text-right">
          {volume}%
        </span>
      </div>
    </div>
  );
}
