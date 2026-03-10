import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { useSpaceStore, getApiForOrigin, resolveUserOrigin } from '../../stores/spaceStore';
import { useUIStore } from '../../stores/uiStore';
import { getAvatarGradient, adjustColor } from '../../utils/gradients';
import { parseFederatedUsername } from '../../utils/identity';
import { loadFederatedMutuals } from '../../utils/mutuals';

interface UserProfilePopoutProps {
  user: User;
  onClose: () => void;
  position?: { top: number; left: number };
}

export function UserProfilePopout({ user, onClose, position }: UserProfilePopoutProps) {
  const navigate = useNavigate();
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
  const openModal = useUIStore((s) => s.openModal);
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

  const top = position
    ? Math.min(Math.max(8, position.top), window.innerHeight - 460)
    : undefined;
  const left = position
    ? Math.min(Math.max(8, position.left), window.innerWidth - 356)
    : undefined;

  const handleSendMessage = async () => {
    try {
      const existing = useSpaceStore.getState().findExistingDmForUser(user);
      if (existing) {
        useUIStore.getState().setShowDms(true);
        onClose();
        navigate(`/channels/@me/${existing.dm.id}`);
        return;
      }
      const dmApi = getApiForOrigin(origin);
      const channel = await dmApi.dm.create({ userId: user.id });
      addDmChannel(channel, origin);
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

  // Banner display
  const bannerSrc = user.banner
    ? (user.banner.startsWith('http') ? user.banner : userApi.uploads.url(user.banner))
    : null;
  const bannerFallback = user.accentColor
    ? `linear-gradient(135deg, ${user.accentColor}, ${adjustColor(user.accentColor, -40)})`
    : getAvatarGradient(user.homeUserId ?? user.id, displayName, user.avatarColor).gradient;

  return (
    <div
      className="fixed z-[200] w-[340px] rounded-[12px] overflow-hidden animate-fade-in select-none border border-white/[0.07]"
      style={{
        ...(position
          ? { top, left }
          : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }),
        backdropFilter: 'blur(20px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
        backgroundColor: 'rgba(20,20,26,0.85)',
        boxShadow: '0 8px 32px rgba(0,0,0,0.45), 0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      {/* Banner */}
      <div
        className="h-[80px] rounded-t-[12px]"
        style={bannerSrc
          ? { backgroundImage: `url(${bannerSrc})`, backgroundSize: 'cover', backgroundPosition: 'center' }
          : { background: bannerFallback, opacity: 0.6 }
        }
      />

      {/* Body */}
      <div className="px-4 pb-4 relative">
        {/* Avatar */}
        <div
          className="mt-[-40px] mb-3 w-fit rounded-full"
          style={{ border: '4px solid rgba(20,20,26,0.85)' }}
        >
          <Avatar
            src={user.avatar}
            name={displayName}
            size={80}
            status={user.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
            userId={user.homeUserId ?? user.id}
          />
        </div>

        {/* Name & info */}
        <div>
          <Username
            username={user.displayName ?? baseName}
            className="text-[16px] font-semibold leading-tight"
          />
          <div className="text-[13px] text-txt-tertiary">
            {domain ? (
              <Username username={user.username} className="text-[13px] text-txt-tertiary" />
            ) : (
              <span>@{baseName}</span>
            )}
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
