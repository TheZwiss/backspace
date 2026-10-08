import { createPortal } from 'react-dom';
import { useUIStore } from '../../stores/uiStore';
import { usePortalContainer } from '../../hooks/usePortalContainer';
import { UserProfilePopout } from './UserProfilePopout';

/**
 * The desktop profile card opened through `openUserProfile`, with the
 * click-away backdrop behind it. Both portal through `usePortalContainer()`
 * like every overlay, so a card opened from inside an open `Modal` (the
 * Members tab of Group DM Settings) is appended after that dialog and draws
 * above it. Rendered in place, it would sit in the app root, which comes
 * before every portaled dialog in the document.
 */
export function UserProfilePopoutLayer() {
  const popout = useUIStore((s) => s.userProfilePopout);
  const closeUserProfile = useUIStore((s) => s.closeUserProfile);
  const portalContainer = usePortalContainer();

  if (!popout.user || !popout.anchor) return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[145]"
        onClick={closeUserProfile}
      />
      <UserProfilePopout
        user={popout.user}
        origin={popout.origin}
        onClose={closeUserProfile}
        anchor={popout.anchor}
        placement={popout.placement}
        member={popout.member}
      />
    </>,
    portalContainer,
  );
}
