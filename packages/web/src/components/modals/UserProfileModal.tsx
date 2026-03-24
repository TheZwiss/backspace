import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { Username } from '../ui/Username';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore, getApiForOrigin, resolveUserOrigin } from '../../stores/spaceStore';
import { useSocialStore, type TaggedFriend, type TaggedFriendRequest, InstanceNotConnectedError, InstanceDisconnectedError } from '../../stores/socialStore';
import { ConnectInstanceModal } from './ConnectInstanceModal';
import { useAuthStore } from '../../stores/authStore';
import { getAvatarGradient, getSpaceGradient, adjustColor, mutedGradient } from '../../utils/gradients';
import { parseFederatedUsername, isSelf, canonicalUserMatch } from '../../utils/identity';
import { loadFederatedMutuals, type TaggedMutualFriend, type MutualSpace } from '../../utils/mutuals';

type Tab = 'about' | 'friends' | 'spaces';

type FriendshipStatus =
  | { state: 'self' }
  | { state: 'friends'; friend: TaggedFriend }
  | { state: 'outbound_pending'; request: TaggedFriendRequest }
  | { state: 'inbound_pending'; request: TaggedFriendRequest }
  | { state: 'none' };

function getFriendshipStatus(
  viewedUser: User,
  currentUser: User | null,
  friends: TaggedFriend[],
  requests: TaggedFriendRequest[],
): FriendshipStatus {
  if (!currentUser) return { state: 'none' };
  if (isSelf(viewedUser, currentUser)) return { state: 'self' };

  const friend = friends.find(f => canonicalUserMatch(f, viewedUser));
  if (friend) return { state: 'friends', friend };

  const request = requests.find(r =>
    r.user && canonicalUserMatch(r.user, viewedUser)
  );
  if (request?.user) {
    // request.user is the OTHER party. If their ID === toId, then I am fromId (outbound)
    const isOutbound = request.user.id === request.toId;
    return isOutbound
      ? { state: 'outbound_pending', request }
      : { state: 'inbound_pending', request };
  }

  return { state: 'none' };
}

export function UserProfileModal() {
  const activeModal = useUIStore((s) => s.activeModal);
  const modalData = useUIStore((s) => s.modalData);
  const closeModal = useUIStore((s) => s.closeModal);
  const addToast = useUIStore((s) => s.addToast);
  const navigate = useNavigate();
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
  const friends = useSocialStore((s) => s.friends);
  const requests = useSocialStore((s) => s.requests);
  const sendFriendRequest = useSocialStore((s) => s.sendFriendRequest);
  const removeFriend = useSocialStore((s) => s.removeFriend);
  const updateFriendRequest = useSocialStore((s) => s.updateFriendRequest);
  const cancelFriendRequest = useSocialStore((s) => s.cancelFriendRequest);
  const currentUser = useAuthStore((s) => s.user);

  const [user, setUser] = useState<User | null>(null);
  const [userOrigin, setUserOrigin] = useState('');
  const [activeTab, setActiveTab] = useState<Tab>('about');
  const [mutualFriends, setMutualFriends] = useState<TaggedMutualFriend[]>([]);
  const [mutualSpaces, setMutualSpaces] = useState<MutualSpace[]>([]);
  const [loadingMutuals, setLoadingMutuals] = useState(false);
  const [friendActionLoading, setFriendActionLoading] = useState(false);
  const [connectModal, setConnectModal] = useState<{
    domain: string;
    isReconnect: boolean;
  } | null>(null);

  const isOpen = activeModal === 'userProfile';
  const userId = modalData?.userId as string | undefined;
  const passedUser = modalData?.user as User | undefined;
  const passedOrigin = (modalData?.origin as string | undefined) ?? '';

  // Determine friendship status (federation-safe canonical matching)
  const friendship: FriendshipStatus = user
    ? getFriendshipStatus(user, currentUser, friends, requests)
    : { state: 'none' };

  const loadUser = useCallback(async (id: string, origin: string) => {
    try {
      const targetApi = getApiForOrigin(origin);
      const u = await targetApi.users.get(id);
      setUser(u);
    } catch {
      // User not found
    }
  }, []);

  const loadMutuals = useCallback(async (id: string, targetUser?: User) => {
    setLoadingMutuals(true);
    try {
      const data = await loadFederatedMutuals(id, targetUser?.homeUserId);
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
      const origin = passedOrigin || (passedUser ? resolveUserOrigin(passedUser) : '');
      setUserOrigin(origin);
      // Use the passed user directly (avoids 404 for federated users on local API)
      if (passedUser) {
        setUser(passedUser);
      } else {
        loadUser(userId, origin);
      }
      loadMutuals(userId, passedUser);
    }
  }, [isOpen, userId, passedUser, passedOrigin, loadUser, loadMutuals]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setUser(null);
      setUserOrigin('');
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

  // Banner — use correct API client for remote users
  const profileApi = getApiForOrigin(userOrigin);
  const bannerSrc = user.banner
    ? (user.banner.startsWith('http') ? user.banner : profileApi.uploads.url(user.banner))
    : null;
  const bannerFallback = user.accentColor
    ? mutedGradient(user.accentColor, adjustColor(user.accentColor, -40))
    : (() => {
        const g = getAvatarGradient(user.homeUserId ?? user.id, displayName, user.avatarColor);
        return mutedGradient(g.from, g.to);
      })();

  const handleSendMessage = async () => {
    try {
      const existing = useSpaceStore.getState().findExistingDmForUser(user);
      if (existing) {
        useUIStore.getState().setShowDms(true);
        closeModal();
        navigate(`/channels/@me/${existing.dm.id}`);
        return;
      }
      const dmApi = getApiForOrigin(userOrigin);
      const channel = await dmApi.dm.create({ userId: user.id });
      addDmChannel(channel, userOrigin);
      useUIStore.getState().setShowDms(true);
      closeModal();
      navigate(`/channels/@me/${channel.id}`);
    } catch (err) {
      console.error('Failed to create DM channel:', err);
    }
  };

  const handleAddFriend = async () => {
    setFriendActionLoading(true);
    try {
      await sendFriendRequest(user.username);
    } catch (err) {
      if (err instanceof InstanceNotConnectedError) {
        setConnectModal({ domain: err.domain, isReconnect: false });
      } else if (err instanceof InstanceDisconnectedError) {
        setConnectModal({ domain: err.domain, isReconnect: true });
      }
      // Other errors: socialStore already sets its own error state
    } finally {
      setFriendActionLoading(false);
    }
  };

  const handleConnected = async (result: 'new' | 'reconnect') => {
    const domain = connectModal?.domain; // capture before clearing
    setConnectModal(null);
    // Retry the friend request now that we're connected
    setFriendActionLoading(true);
    try {
      await sendFriendRequest(user.username);
      const verb = result === 'reconnect' ? 'Reconnected to' : 'Connected to';
      addToast(`${verb} ${domain} — friend request sent to ${user.displayName ?? parseFederatedUsername(user.username).baseName}`, 'success');
    } catch (err) {
      // Connection succeeded but friend request failed — still valuable
      addToast((err as Error).message, 'warning');
    } finally {
      setFriendActionLoading(false);
    }
  };

  const handleRemoveFriend = async () => {
    if (friendship.state !== 'friends') return;
    setFriendActionLoading(true);
    try { await removeFriend(friendship.friend.id); }
    catch (err) { addToast((err as Error).message, 'warning'); }
    finally { setFriendActionLoading(false); }
  };

  const handleCancelRequest = async () => {
    if (friendship.state !== 'outbound_pending') return;
    setFriendActionLoading(true);
    try { await cancelFriendRequest(friendship.request.id); }
    catch (err) { addToast((err as Error).message, 'warning'); }
    finally { setFriendActionLoading(false); }
  };

  const handleAcceptRequest = async () => {
    if (friendship.state !== 'inbound_pending') return;
    setFriendActionLoading(true);
    try { await updateFriendRequest(friendship.request.id, 'accepted'); }
    catch (err) { addToast((err as Error).message, 'warning'); }
    finally { setFriendActionLoading(false); }
  };

  const handleDeclineRequest = async () => {
    if (friendship.state !== 'inbound_pending') return;
    setFriendActionLoading(true);
    try { await updateFriendRequest(friendship.request.id, 'declined'); }
    catch (err) { addToast((err as Error).message, 'warning'); }
    finally { setFriendActionLoading(false); }
  };

  const handleViewFriend = (friend: TaggedMutualFriend) => {
    const friendOrigin = friend._instanceOrigin || resolveUserOrigin(friend);
    setUserOrigin(friendOrigin);
    setUser(friend);
    loadMutuals(friend.id, friend);
    setActiveTab('about');
    // Update modal data so re-opening preserves context
    useUIStore.getState().openModal('userProfile', { userId: friend.id, user: friend, origin: friendOrigin });
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
      <div className="absolute inset-0 bg-black/50" onClick={closeModal} />
      <div className="relative max-w-lg w-full mx-4 max-h-[calc(100vh-2rem)] flex flex-col glass-modal rounded-lg animate-slide-up overflow-hidden">
        {/* Banner */}
        <div
          className="h-[100px] flex-shrink-0 relative"
          style={bannerSrc
            ? { backgroundImage: `url(${bannerSrc})`, backgroundSize: 'cover', backgroundPosition: 'center' }
            : { background: bannerFallback }
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
        <div className="px-5 flex-shrink-0 relative">
          <Avatar
            src={user.avatar}
            name={displayName}
            size={96}
            status={user.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
            userId={user.homeUserId ?? user.id}
            user={user}
            ring={{ width: 4, color: 'rgba(20,20,26,0.82)' }}
            className="mt-[-52px] mb-2"
          />

          <div className="mb-3">
            <Username
              username={displayName}
              className="text-[20px] font-bold leading-tight"
            />
            <div className="text-[14px] text-txt-tertiary mt-0.5">
              <Username username={user.username} showAt className="text-[14px] text-txt-tertiary" />
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
                        onClick={() => handleViewFriend(friend)}
                        className="flex items-center gap-2.5 p-2.5 rounded-lg bg-white/[0.03] hover:bg-white/[0.06] border border-white/[0.04] transition-colors text-left"
                      >
                        <Avatar
                          src={friend.avatar}
                          name={fname}
                          size={40}
                          status={friend.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
                          userId={friend.homeUserId ?? friend.id}
                          avatarColor={friend.avatarColor}
                        />
                        <div className="min-w-0">
                          <div className="text-[13px] font-medium text-txt-primary truncate">
                            {fname}
                          </div>
                          <div className="text-[11px] text-txt-tertiary capitalize">
                            {friend.status}
                          </div>
                          {friend._instanceOrigin && (
                            <div className="flex items-center gap-1 text-[10px] text-txt-tertiary/70 truncate">
                              <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                              </svg>
                              <span className="truncate">{(() => { try { return new URL(friend._instanceOrigin).host; } catch { return '?'; } })()}</span>
                            </div>
                          )}
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
                  {mutualSpaces.map((space) => {
                    const spaceApi = getApiForOrigin(space._instanceOrigin);
                    return (
                    <button
                      key={`${space.id}:${space._instanceOrigin}`}
                      onClick={() => handleGoToSpace(space.id)}
                      className="flex items-center gap-3 w-full p-2.5 rounded-lg hover:bg-white/[0.06] transition-colors text-left"
                    >
                      <div className="relative shrink-0">
                        {space.icon ? (
                          <img
                            src={space.icon.startsWith('http') ? space.icon : spaceApi.uploads.url(space.icon)}
                            alt={space.name}
                            className="w-8 h-8 rounded-lg object-cover"
                          />
                        ) : (
                          <div
                            className="w-8 h-8 rounded-lg flex items-center justify-center text-[13px] font-semibold text-white"
                            style={{ background: getSpaceGradient(space.id, space.name, space.avatarColor).gradient }}
                          >
                            {space.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        {space._instanceOrigin && (
                          <div className="absolute -bottom-0.5 -right-0.5 w-[14px] h-[14px] rounded-full bg-[#1a1a23] flex items-center justify-center">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/80">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                            </svg>
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex flex-col">
                        <span className="text-[13px] font-medium text-txt-primary truncate">
                          {space.name}
                        </span>
                        {space._instanceOrigin && (
                          <span className="text-[10px] text-txt-tertiary/70 truncate flex items-center gap-1">
                            <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                            </svg>
                            {(() => { try { return new URL(space._instanceOrigin).host; } catch { return '?'; } })()}
                          </span>
                        )}
                      </div>
                    </button>
                    );
                  })}
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

          {friendship.state === 'none' && (
            <button onClick={handleAddFriend} disabled={friendActionLoading}
              className="flex-1 py-2 rounded-lg text-[13px] font-medium text-txt-primary border border-white/[0.08] bg-white/[0.06] hover:bg-white/[0.10] transition-colors disabled:opacity-50">
              {friendActionLoading ? '...' : 'Add Friend'}
            </button>
          )}

          {friendship.state === 'outbound_pending' && (
            <button onClick={handleCancelRequest} disabled={friendActionLoading}
              className="flex-1 py-2 rounded-lg text-[13px] font-medium text-amber-400 border border-amber-400/30 hover:bg-amber-400/10 transition-colors disabled:opacity-50">
              {friendActionLoading ? '...' : 'Cancel Request'}
            </button>
          )}

          {friendship.state === 'inbound_pending' && (
            <>
              <button onClick={handleAcceptRequest} disabled={friendActionLoading}
                className="flex-1 py-2 rounded-lg text-[13px] font-medium text-white bg-accent-primary hover:bg-accent-primary/80 transition-colors disabled:opacity-50">
                {friendActionLoading ? '...' : 'Accept'}
              </button>
              <button onClick={handleDeclineRequest} disabled={friendActionLoading}
                className="py-2 px-3 rounded-lg text-[13px] font-medium text-txt-tertiary border border-white/[0.06] hover:bg-white/[0.06] transition-colors disabled:opacity-50">
                {friendActionLoading ? '...' : 'Ignore'}
              </button>
            </>
          )}

          {friendship.state === 'friends' && (
            <button onClick={handleRemoveFriend} disabled={friendActionLoading}
              className="flex-1 py-2 rounded-lg text-[13px] font-medium text-txt-danger border border-txt-danger/30 hover:bg-txt-danger/10 transition-colors disabled:opacity-50">
              {friendActionLoading ? '...' : 'Remove Friend'}
            </button>
          )}
        </div>
      </div>

      {connectModal && user && (
        <ConnectInstanceModal
          domain={connectModal.domain}
          targetDisplayName={user.displayName ?? parseFederatedUsername(user.username).baseName}
          isReconnect={connectModal.isReconnect}
          onConnected={handleConnected}
          onCancel={() => setConnectModal(null)}
        />
      )}
    </div>
  );
}
