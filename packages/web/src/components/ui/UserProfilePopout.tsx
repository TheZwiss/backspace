import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { useSpaceStore, getApiForOrigin, resolveUserOrigin } from '../../stores/spaceStore';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/uiStore';
import { getAvatarGradient, adjustColor, mutedGradient } from '../../utils/gradients';
import { parseFederatedUsername } from '../../utils/identity';
import { useCanonicalUserView } from '../../utils/userViewLookup';
import { loadFederatedMutuals } from '../../utils/mutuals';
import { computeFloatingPosition, type AnchorRect, type Placement } from '../../hooks/useFloatingPosition';

/** Gap between the card and the element it was opened from. */
const ANCHOR_OFFSET = 8;

interface UserProfilePopoutProps {
  user: User;
  onClose: () => void;
  /** Rect of the element the card was opened from. */
  anchor: AnchorRect;
  placement?: Placement;
}

export function UserProfilePopout({ user: propUser, onClose, anchor, placement = 'right' }: UserProfilePopoutProps) {
  const navigate = useNavigate();
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
  const openModal = useUIStore((s) => s.openModal);
  // Resolve to the best-known view of this user from the userViews cache.
  // The prop frequently arrives as a federated stub (when the carrying DM
  // came from a sibling instance that won the populateFromReady dedup race);
  // routing through the cache surfaces the home view when one is loaded.
  // Identity fields (id, homeUserId, homeInstance) are preserved across
  // canonicalization, so write-payload code paths below remain correct.
  const user = useCanonicalUserView(propUser);
  const { baseName, domain } = parseFederatedUsername(user.username);
  const displayName = user.displayName ?? baseName;

  const origin = resolveUserOrigin(user);
  const userApi = getApiForOrigin(origin);

  const [mutualCounts, setMutualCounts] = useState<{ friends: number; spaces: number } | null>(null);

  useEffect(() => {
    loadFederatedMutuals(user.id, user.homeUserId)
      .then((data) => setMutualCounts({ friends: data.mutualFriends.length, spaces: data.mutualSpaces.length }))
      .catch(() => {});
  }, [user.id, user.homeUserId]);

  // Placed off the card's *measured* size rather than a guessed height: the card
  // grows with the bio, the custom status and the mutuals row, so any constant
  // here would cut tall cards off at the bottom of the viewport.
  const cardRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;

    const place = () => {
      const { width, height } = card.getBoundingClientRect();
      // 'start': the card's top edge lines up with the row it came from, the
      // way it always has — centring a tall card on a 32px avatar would drag it
      // up over unrelated content.
      const next = computeFloatingPosition(anchor, width, height, placement, ANCHOR_OFFSET, 'start');
      setPlaced((prev) =>
        prev && prev.top === next.top && prev.left === next.left
          ? prev
          : { top: next.top, left: next.left },
      );
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(card);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [anchor, placement]);

  const handleSendMessage = async () => {
    try {
      const existing = useSpaceStore.getState().findExistingDmForUser(user);
      if (existing) {
        useUIStore.getState().setShowDms(true);
        onClose();
        navigate(`/channels/@me/${existing.dm.id}`);
        return;
      }
      const channel = await api.dm.create({
        userId: user.homeInstance ? undefined : user.id,
        homeUserId: user.homeUserId ?? undefined,
        homeInstance: user.homeInstance ?? undefined,
      });
      addDmChannel(channel);
      useUIStore.getState().setShowDms(true);
      onClose();
      navigate(`/channels/@me/${channel.id}`);
    } catch (err) {
      console.error('Failed to create DM channel:', err);
    }
  };

  const handleViewFullProfile = () => {
    onClose();
    openModal('userProfile', { userId: user.id, user, origin });
  };

  const handleAvatarClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    handleViewFullProfile();
  };

  // Banner display
  const bannerSrc = user.banner
    ? (user.banner.startsWith('http') || user.banner.startsWith('/') ? user.banner : userApi.uploads.url(user.banner))
    : null;
  const bannerFallback = user.accentColor
    ? mutedGradient(user.accentColor, adjustColor(user.accentColor, -40))
    : (() => {
        const g = getAvatarGradient(user.homeUserId ?? user.id, displayName, user.avatarColor);
        return mutedGradient(g.from, g.to);
      })();

  // Parked off-screen for the one layout pass before the card knows how tall it
  // is; `useLayoutEffect` places it before the browser paints, so it never
  // renders visibly in the wrong spot.
  const cardStyle = placed ?? { top: -9999, left: -9999 };

  return (
    <div
      ref={cardRef}
      data-user-profile-popout
      className="fixed z-[200] w-[340px] rounded-[12px] overflow-hidden animate-fade-in select-none glass-modal"
      style={cardStyle}
    >
      {/* Banner */}
      <div
        className="h-[80px] rounded-t-[12px]"
        style={bannerSrc
          ? { backgroundImage: `url(${bannerSrc})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : { background: bannerFallback }
        }
      />

      {/* Body */}
      <div className="px-4 pb-4 relative">
        {/* Avatar */}
        {/* The picture escalates to the full profile — the card is a preview, and
            clicking the face is the obvious way to ask for the whole thing. It
            deliberately does NOT reopen the card (see issue #37). */}
        <Avatar
          src={user.avatar}
          name={displayName}
          size={80}
          status={user.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
          userId={user.homeUserId ?? user.id}
          user={user}
          onClick={handleAvatarClick}
          ring={{ width: 4, color: 'rgba(20,20,26,0.85)' }}
          className="mt-[-44px] mb-3"
        />

        {/* Name & info */}
        <div>
          <Username
            username={user.displayName ?? baseName}
            className="text-[16px] font-semibold leading-tight"
          />
          <div className="text-[13px] text-txt-tertiary">
            <Username username={user.username} showAt className="text-[13px] text-txt-tertiary" />
          </div>
          {user.customStatus && (
            <div className="text-[13px] text-txt-secondary italic mt-1">
              {user.customStatus}
            </div>
          )}
        </div>

        {/* Bio */}
        {user.bio && (
          <>
            <div className="border-t border-white/[0.06] my-3" />
            <div>
              <span className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary">
                About Me
              </span>
              <div className="text-[13px] text-txt-secondary mt-1 whitespace-pre-wrap break-words leading-relaxed [&_strong]:font-semibold [&_strong]:text-txt-primary [&_em]:italic [&_a]:text-accent-primary [&_a]:underline">
                <ReactMarkdown
                  allowedElements={['p', 'strong', 'em', 'a', 'br']}
                  unwrapDisallowed
                  components={{
                    a: ({ href, children }) => (
                      <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
                    ),
                  }}
                >
                  {user.bio}
                </ReactMarkdown>
              </div>
            </div>
          </>
        )}

        <div className="border-t border-white/[0.06] my-3" />

        {/* Member since + Mutuals */}
        <div className="space-y-1.5">
          <div>
            <span className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary">
              Member Since
            </span>
            <span className="text-[12px] text-txt-secondary ml-2">
              {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          {mutualCounts && (mutualCounts.friends > 0 || mutualCounts.spaces > 0) && (
            <div className="text-[12px] text-txt-tertiary">
              {mutualCounts.friends > 0 && (
                <span>{mutualCounts.friends} mutual friend{mutualCounts.friends !== 1 ? 's' : ''}</span>
              )}
              {mutualCounts.friends > 0 && mutualCounts.spaces > 0 && (
                <span className="mx-1">&middot;</span>
              )}
              {mutualCounts.spaces > 0 && (
                <span>{mutualCounts.spaces} mutual space{mutualCounts.spaces !== 1 ? 's' : ''}</span>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <button
          onClick={handleSendMessage}
          className="w-full mt-3 py-2 rounded-lg text-[13px] font-medium text-txt-primary bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] transition-colors"
        >
          Send Message
        </button>
        <button
          onClick={handleViewFullProfile}
          className="w-full mt-1.5 py-2 rounded-lg text-[13px] font-medium text-txt-tertiary hover:text-txt-secondary bg-transparent hover:bg-white/[0.04] transition-colors"
        >
          View Full Profile
        </button>
      </div>
    </div>
  );
}
