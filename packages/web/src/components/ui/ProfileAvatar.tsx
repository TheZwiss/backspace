import React from 'react';
import type { User } from '@backspace/shared';
import { Avatar } from './Avatar';
import { useUIStore } from '../../stores/uiStore';
import type { Placement } from '../../hooks/useFloatingPosition';

type AvatarProps = React.ComponentProps<typeof Avatar>;

interface ProfileAvatarProps extends Omit<AvatarProps, 'onClick' | 'user'> {
  /** Undefined while the user record is still resolving — the avatar then stays
   *  presentational rather than offering a click that opens nothing. */
  user?: User;
  /** Preferred side for the card; it flips automatically when there's no room. */
  placement?: Placement;
}

/**
 * An avatar that opens the profile card for the user it depicts.
 *
 * This is deliberately a separate component from `Avatar`: `Avatar` takes a
 * `user` for the gradient, colour and status dot, and plenty of avatars carry
 * one without being a profile trigger — the picture inside the profile card
 * itself, the settings preview, rows inside modals. Folding the behaviour into
 * `Avatar` made every one of those a trigger by accident, which is what let the
 * profile card re-anchor to its own picture and walk across the screen.
 */
export function ProfileAvatar({ user, placement = 'right', ...avatarProps }: ProfileAvatarProps) {
  const openUserProfile = useUIStore((s) => s.openUserProfile);

  const handleClick = user
    ? (e: React.MouseEvent) => {
        // Rows that hold an avatar usually have their own click target (open the
        // DM, select the member). Opening the profile is the more specific intent.
        e.stopPropagation();
        openUserProfile(user, e.currentTarget.getBoundingClientRect(), placement);
      }
    : undefined;

  return <Avatar {...avatarProps} user={user} onClick={handleClick} />;
}
