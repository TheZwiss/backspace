import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { api } from '../../api/client';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useSocialStore } from '../../stores/socialStore';
import { getAvatarGradient, adjustColor } from '../../utils/gradients';
import { parseFederatedUsername } from '../../utils/identity';

type Tab = 'about' | 'friends' | 'spaces';

interface MutualSpace {
  id: string;
  name: string;
  icon: string | null;
}

export function UserProfileModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const navigate = useNavigate();
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
  const friends = useSocialStore((s) => s.friends);
  const sendFriendRequest = useSocialStore((s) => s.sendFriendRequest);
  const removeFriend = useSocialStore((s) => s.removeFriend);

  const [user, setUser] = useState<User | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('about');
  const [mutualFriends, setMutualFriends] = useState<User[]>([]);
  const [mutualSpaces, setMutualSpaces] = useState<MutualSpace[]>([]);
  const [loadingMutuals, setLoadingMutuals] = useState(false);
  const [friendActionLoading, setFriendActionLoading] = useState(false);

  const isOpen = activeModal === 'userProfile';
  const userId = modalData?.userId as string | undefined;

  // Determine friendship status
  const isFriend = user ? friends.some((f) => f.id === user.id) : false;

  const loadUser = useCallback(async (id: string) => {
    try {
      const u = await api.users.get(id);
      setUser(u);
    } catch {
      // User not found
    }
  }, []);

  const loadMutuals = useCallback(async (id: string) => {
    setLoadingMutuals(true);
    try {
      const data = await api.users.getMutuals(id);
      setMutualFriends(data.mutualFriends);
      setMutualSpaces(data.mutualSpaces);
    } catch {
      setMutualFriends([]);
      setMutualSpaces([]);
    } finally {
      setLoadingMutuals(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && userId) {
      setActiveTab('about');
      loadUser(userId);
      loadMutuals(userId);
    }
  }, [isOpen, userId, loadUser, loadMutuals]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setUser(null);
      setMutualFriends([]);
      setMutualSpaces([]);
    }
  }, [isOpen]);

  // Escape to close
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeModal();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, closeModal]);

  if (!isOpen || !user) return null;

  const { baseName, domain } = parseFederatedUsername(user.username);
  const displayName = user.displayName ?? baseName;

  // Banner
  const bannerSrc = user.banner
    ? (user.banner.startsWith('http') ? user.banner : api.uploads.url(user.banner))
    : null;
  const bannerFallback = user.accentColor
    ? `linear-gradient(135deg, ${user.accentColor}, ${adjustColor(user.accentColor, -40)})`
    : getAvatarGradient(user.homeUserId ?? user.id, displayName).gradient;

  const handleSendMessage = async () => {
    try {
      const existing = useSpaceStore.getState().findExistingDmForUser(user);
      if (existing) {
        useUIStore.getState().setShowDms(true);
        closeModal();
        navigate(`/channels/@me/${existing.dm.id}`);
        return;
      }
      const channel = await api.dm.create({ userId: user.id });
      addDmChannel(channel);
      useUIStore.getState().setShowDms(true);
      closeModal();
      navigate(`/channels/@me/${channel.id}`);
    } catch (err) {
      console.error('Failed to create DM channel:', err);
    }
  };

  const handleFriendAction = async () => {
    setFriendActionLoading(true);
    try {
      if (isFriend) {
        await removeFriend(user.id);
      } else {
        await sendFriendRequest(user.username);
      }
    } catch {
      // Silently fail
    } finally {
      setFriendActionLoading(false);
    }
  };

  const handleViewFriend = (friendId: string) => {
    loadUser(friendId);
    loadMutuals(friendId);
    setActiveTab('about');
    // Update modal data so re-opening preserves context
    useUIStore.getState().openModal('userProfile', { userId: friendId });
  };

  const handleGoToSpace = (spaceId: string) => {
    closeModal();
    navigate(`/channels/${spaceId}`);
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'about', label: 'About' },
    { key: 'friends', label: 'Mutual Friends', count: mutualFriends.length },
    { key: 'spaces', label: 'Mutual Spaces', count: mutualSpaces.length },
  ];

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center animate-fade-in">
      <div className="absolute inset-0 bg-surface-overlay" onClick={closeModal} />
      <div className="relative max-w-lg w-full mx-4 max-h-[calc(100vh-2rem)] flex flex-col bg-surface-elevated rounded-lg shadow-xl animate-slide-up overflow-hidden">
        {/* Banner */}
        <div
          className="h-[100px] flex-shrink-0 relative"
          style={bannerSrc
            ? { backgroundImage: `url(${bannerSrc})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { background: bannerFallback, opacity: 0.6 }
          }
        >
          {/* Close button */}
          <button
            onClick={closeModal}
            className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/40 hover:bg-black/60 flex items-center justify-center transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="white">
              <path d="M18.4 4L12 10.4L5.6 4L4 5.6L10.4 12L4 18.4L5.6 20L12 13.6L18.4 20L20 18.4L13.6 12L20 5.6L18.4 4Z" />
            </svg>
          </button>
        </div>

        {/* Header (avatar + name) */}
        <div className="px-5 flex-shrink-0">
          <div
            className="mt-[-48px] mb-2 w-fit rounded-full"
            style={{ border: '4px solid var(--color-surface-elevated, #1e1e2a)' }}
          >
            <Avatar
              src={user.avatar}
              name={displayName}
              size={96}
              status={user.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
              userId={user.homeUserId ?? user.id}
            />
          </div>

          <div className="mb-3">
            <Username
              username={displayName}
              className="text-[20px] font-bold leading-tight"
              style={user.accentColor ? { color: user.accentColor } : undefined}
            />
            <div className="text-[14px] text-txt-tertiary mt-0.5">
              {domain ? (
                <Username username={user.username} className="text-[14px] text-txt-tertiary" />
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
        </div>

        {/* Tab bar */}
        <div className="px-5 flex-shrink-0 border-b border-white/[0.06]">
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`px-3 py-2 text-[13px] font-medium rounded-t-lg transition-colors relative ${
                  activeTab === tab.key
                    ? 'text-txt-primary'
                    : 'text-txt-tertiary hover:text-txt-secondary'
                }`}
              >
                {tab.label}
                {tab.count !== undefined && !loadingMutuals && (
                  <span className="ml-1 text-[11px] text-txt-tertiary">({tab.count})</span>
                )}
                {activeTab === tab.key && (
                  <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-accent-primary rounded-full" />
                )}
              </button>
            ))}
          </div>
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin p-5 min-h-[200px]">
          {activeTab === 'about' && (
            <div className="space-y-4">
              {/* Bio */}
              {user.bio && (
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
              )}

              {/* Member Since */}
              <div>
                <span className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary">
                  Member Since
                </span>
                <div className="text-[13px] text-txt-secondary mt-1">
                  {new Date(user.createdAt).toLocaleDateString(undefined, {
                    month: 'long',
                    day: 'numeric',
                    year: 'numeric',
                  })}
                </div>
              </div>

              {/* Accent color */}
              {user.accentColor && (
                <div>
                  <span className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary">
                    Accent Color
                  </span>
                  <div className="flex items-center gap-2 mt-1">
                    <div
                      className="w-5 h-5 rounded-full border border-white/10"
                      style={{ backgroundColor: user.accentColor }}
                    />
                    <span className="text-[12px] text-txt-tertiary font-mono">
                      {user.accentColor}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {activeTab === 'friends' && (
            <div>
              {loadingMutuals ? (
                <div className="flex items-center justify-center py-8">
                  <svg className="animate-spin w-5 h-5 text-txt-tertiary" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              ) : mutualFriends.length === 0 ? (
                <div className="text-center py-8 text-txt-tertiary text-[13px]">
                  No mutual friends
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {mutualFriends.map((friend) => {
                    const fname = friend.displayName ?? parseFederatedUsername(friend.username).baseName;
                    return (
                      <button
                        key={friend.id}
                        onClick={() => handleViewFriend(friend.id)}
                        className="flex items-center gap-2.5 p-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.04] transition-colors text-left"
                      >
                        <Avatar
                          src={friend.avatar}
                          name={fname}
                          size={40}
                          status={friend.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
                          userId={friend.homeUserId ?? friend.id}
                        />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-txt-primary truncate">
                            {fname}
                          </div>
                          <div className="text-[11px] text-txt-tertiary capitalize">
                            {friend.status}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'spaces' && (
            <div>
              {loadingMutuals ? (
                <div className="flex items-center justify-center py-8">
                  <svg className="animate-spin w-5 h-5 text-txt-tertiary" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
              ) : mutualSpaces.length === 0 ? (
                <div className="text-center py-8 text-txt-tertiary text-[13px]">
                  No mutual spaces
                </div>
              ) : (
                <div className="space-y-1">
                  {mutualSpaces.map((space) => (
                    <button
                      key={space.id}
                      onClick={() => handleGoToSpace(space.id)}
                      className="flex items-center gap-3 w-full p-2.5 rounded-lg hover:bg-white/[0.06] transition-colors text-left"
                    >
                      {space.icon ? (
                        <img
                          src={space.icon.startsWith('http') ? space.icon : api.uploads.url(space.icon)}
                          alt={space.name}
                          className="w-8 h-8 rounded-lg object-cover"
                        />
                      ) : (
                        <div className="w-8 h-8 rounded-lg bg-white/[0.06] flex items-center justify-center text-[13px] font-semibold text-txt-secondary">
                          {space.name.charAt(0).toUpperCase()}
                        </div>
                      )}
                      <span className="text-[13px] font-medium text-txt-primary truncate">
                        {space.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex-shrink-0 px-5 py-3 border-t border-white/[0.06] flex gap-2">
          <button
            onClick={handleSendMessage}
            className="flex-1 py-2 rounded-lg text-[13px] font-medium text-white bg-accent-primary hover:bg-accent-primary/80 transition-colors"
          >
            Send Message
          </button>
          <button
            onClick={handleFriendAction}
            disabled={friendActionLoading}
            className={`flex-1 py-2 rounded-lg text-[13px] font-medium border transition-colors disabled:opacity-50 ${
              isFriend
                ? 'text-txt-danger border-txt-danger/30 hover:bg-txt-danger/10'
                : 'text-txt-primary border-white/[0.08] bg-white/[0.06] hover:bg-white/[0.10]'
            }`}
          >
            {friendActionLoading ? '...' : isFriend ? 'Remove Friend' : 'Add Friend'}
          </button>
        </div>
      </div>
    </div>
  );
}
