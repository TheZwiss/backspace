import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocialStore, type TaggedFriend, type TaggedFriendRequest, InstanceNotConnectedError, InstanceDisconnectedError } from '../../stores/socialStore';
import { ConnectInstanceModal } from '../modals/ConnectInstanceModal';
import { useDiscoverStore, type TaggedDiscoverUser } from '../../stores/discoverStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { useUIStore } from '../../stores/uiStore';
import { Avatar } from '../ui/Avatar';
import { MemberListToggleButton } from '../layout/MemberListToggleButton';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { getAvatarGradient } from '../../utils/gradients';
import { api } from '../../api/client';
import { Mascot } from '../ui/Mascot';
import { useActivityStore } from '../../stores/activityStore';
import { ActivityCard, hasRichActivity, getActivityAccentClass } from '../ui/ActivityCard';
import { getPrimaryActivity } from '@backspace/shared/src/activities.js';
import { parseFederatedUsername } from '../../utils/identity';
import { Username } from '../ui/Username';

type Tab = 'online' | 'all' | 'pending' | 'add' | 'activity';

interface FriendsPageProps {
  mobile?: boolean;
}

export function FriendsPage({ mobile }: FriendsPageProps) {
  const [activeTab, setActiveTab] = useState<Tab>('online');
  const [addUsername, setAddUsername] = useState('');
  const [addStatus, setAddStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const addToast = useUIStore((s) => s.addToast);
  const [connectModal, setConnectModal] = useState<{
    domain: string;
    isReconnect: boolean;
    username: string;
  } | null>(null);
  const navigate = useNavigate();
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);

  const {
    friends,
    requests,
    isLoading,
    loadFriends,
    loadRequests,
    sendFriendRequest,
    updateFriendRequest,
    cancelFriendRequest,
    removeFriend
  } = useSocialStore();

  useEffect(() => {
    loadFriends();
    loadRequests();
  }, [loadFriends, loadRequests]);

  const userActivities = useActivityStore((s) => s.userActivities);
  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);

  const onlineFriends = friends.filter(f => f.status !== 'offline');
  const pendingIncoming = requests.filter(r => r.status === 'pending' && r.user?.id === r.fromId);
  const pendingOutgoing = requests.filter(r => r.status === 'pending' && r.user?.id === r.toId);

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addUsername.trim()) return;

    try {
      await sendFriendRequest(addUsername.trim());
      setAddStatus({ type: 'success', message: `Success! Your friend request to ${addUsername} has been sent.` });
      setAddUsername('');
    } catch (err) {
      if (err instanceof InstanceNotConnectedError) {
        setConnectModal({ domain: err.domain, isReconnect: false, username: addUsername.trim() });
      } else if (err instanceof InstanceDisconnectedError) {
        setConnectModal({ domain: err.domain, isReconnect: true, username: addUsername.trim() });
      } else {
        setAddStatus({ type: 'error', message: (err as Error).message });
      }
    }
  };

  const handleAddFriendConnected = async (result: 'new' | 'reconnect') => {
    const username = connectModal?.username;
    const domain = connectModal?.domain;
    setConnectModal(null);
    if (!username) return;

    try {
      await sendFriendRequest(username);
      const verb = result === 'reconnect' ? 'Reconnected to' : 'Connected to';
      setAddStatus({ type: 'success', message: `${verb} ${domain} — friend request sent!` });
      setAddUsername('');
    } catch (err) {
      addToast((err as Error).message, 'warning');
    }
  };

  const handleOpenDm = async (friendId: string, instanceOrigin: string, homeUserId?: string) => {
    try {
      // Check if a DM already exists with this user (on any instance)
      const existing = useSpaceStore.getState().findExistingDmForUser({ id: friendId, homeUserId: homeUserId ?? undefined });
      if (existing) {
        useUIStore.getState().setShowDms(true);
        navigate(`/channels/@me/${existing.dm.id}`);
        return;
      }
      let client = api;
      if (instanceOrigin) {
        const instance = useInstanceStore.getState().instances.find(i => i.origin === instanceOrigin);
        if (instance?.api) client = instance.api;
      }
      const dmChannel = await client.dm.create({ userId: friendId });
      addDmChannel(dmChannel, instanceOrigin);
      navigate(`/channels/@me/${dmChannel.id}`);
    } catch (err) {
      console.error('Failed to open DM:', err);
    }
  };

  const renderTabContent = () => {
    if (isLoading && friends.length === 0 && requests.length === 0) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <LoadingSpinner />
        </div>
      );
    }

    switch (activeTab) {
      case 'online':
        return (
          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="text-xs font-bold text-txt-tertiary uppercase mb-4 tracking-wider px-2">
              Online — {onlineFriends.length}
            </h2>
            {onlineFriends.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full opacity-80">
                <Mascot state="idle" className="w-32 h-32 mb-4" />
                <p className="text-txt-tertiary text-sm">No one's online right now.</p>
              </div>
            ) : (
              onlineFriends.map(friend => (
                <FriendItem key={`${friend.id}:${friend._instanceOrigin}`} friend={friend} onRemove={() => removeFriend(friend.id)} onDm={() => handleOpenDm(friend.id, friend._instanceOrigin, friend.homeUserId ?? undefined)} />
              ))
            )}
          </div>
        );
      case 'all':
        return (
          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="text-xs font-bold text-txt-tertiary uppercase mb-4 tracking-wider px-2">
              All Friends — {friends.length}
            </h2>
            {friends.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full opacity-80">
                <Mascot state="lonely" className="w-32 h-32 mb-4" />
                <p className="text-txt-tertiary text-sm">No friends yet — add someone!</p>
              </div>
            ) : (
              friends.map(friend => (
                <FriendItem key={`${friend.id}:${friend._instanceOrigin}`} friend={friend} onRemove={() => removeFriend(friend.id)} onDm={() => handleOpenDm(friend.id, friend._instanceOrigin, friend.homeUserId ?? undefined)} />
              ))
            )}
          </div>
        );
      case 'pending':
        return (
          <div className="flex-1 overflow-y-auto p-4">
            <h2 className="text-xs font-bold text-txt-tertiary uppercase mb-4 tracking-wider px-2">
              Pending — {pendingIncoming.length + pendingOutgoing.length}
            </h2>
            {[...pendingIncoming, ...pendingOutgoing].length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full opacity-80">
                <Mascot state="sleeping" className="w-32 h-32 mb-4" />
                <p className="text-txt-tertiary text-sm">No pending requests — Nori is napping.</p>
              </div>
            ) : (
              <>
                {pendingIncoming.map(req => (
                  <RequestItem
                    key={`${req.id}:${req._instanceOrigin}`}
                    request={req}
                    type="incoming"
                    onAccept={() => updateFriendRequest(req.id, 'accepted')}
                    onDecline={() => updateFriendRequest(req.id, 'declined')}
                  />
                ))}
                {pendingOutgoing.map(req => (
                  <RequestItem
                    key={`${req.id}:${req._instanceOrigin}`}
                    request={req}
                    type="outgoing"
                    onCancel={() => cancelFriendRequest(req.id)}
                  />
                ))}
              </>
            )}
          </div>
        );
      case 'add':
        return (
          <AddFriendTab
            addUsername={addUsername}
            setAddUsername={setAddUsername}
            addStatus={addStatus}
            isLoading={isLoading}
            onSubmit={handleAddFriend}
            onOpenDm={handleOpenDm}
          />
        );
      case 'activity': {
        const activeFriends: TaggedFriend[] = [];
        const idleFriends: TaggedFriend[] = [];
        const offlineActivityFriends: TaggedFriend[] = [];
        for (const f of friends) {
          if (f.status === 'offline') {
            offlineActivityFriends.push(f);
            continue;
          }
          const acts = userActivities.get(f.homeUserId ?? f.id) ?? [];
          const primary = getPrimaryActivity(acts);
          if (primary && primary.type !== 'custom') {
            activeFriends.push(f);
          } else {
            idleFriends.push(f);
          }
        }

        const renderActivityFriend = (friend: TaggedFriend, isOffline = false) => {
          const { baseName, domain } = parseFederatedUsername(friend.username);
          const friendDisplayName = friend.displayName ?? baseName;
          const activities = userActivities.get(friend.homeUserId ?? friend.id) ?? [];
          const isRichActivity = !isOffline && hasRichActivity(activities);
          const primary = getPrimaryActivity(activities);
          const accentClass = primary ? getActivityAccentClass(primary.type) : '';

          const rowClass = isRichActivity
            ? `flex items-center gap-3 px-4 py-2.5 rounded-[10px] mb-1 cursor-pointer transition-colors glass-pill border-l-2 ${accentClass}`
            : 'flex items-center gap-3 px-4 py-2.5 rounded-[4px] hover:bg-interactive-hover cursor-pointer transition-colors active:bg-interactive-hover';

          return (
            <div
              key={friend.id}
              onClick={() => {
                if (mobile) {
                  pushMobileScreen('user-profile', { userId: friend.id });
                } else {
                  handleOpenDm(friend.id, friend._instanceOrigin ?? '', friend.homeUserId ?? undefined);
                }
              }}
              className={rowClass}
            >
              <Avatar
                src={friend.avatar}
                name={friendDisplayName}
                size={36}
                status={isOffline ? 'offline' : friend.status}
                className={isOffline ? 'opacity-60' : undefined}
                userId={friend.homeUserId ?? friend.id}
                avatarColor={friend.avatarColor}
              />
              <div className="flex-1 min-w-0">
                <Username
                  username={friendDisplayName}
                  className={`text-sm leading-[1.2] font-medium truncate ${isOffline ? 'text-txt-tertiary' : 'text-txt-primary'}`}
                />
                {domain && !isOffline && (
                  <div className="text-[10px] leading-[1.3] text-txt-tertiary truncate opacity-60">@{domain}</div>
                )}
                {!isOffline && (
                  <ActivityCard
                    activities={activities}
                    fallbackCustomStatus={friend.customStatus}
                  />
                )}
              </div>
            </div>
          );
        };

        return (
          <div className="flex-1 overflow-y-auto p-4">
            {activeFriends.length === 0 && idleFriends.length === 0 && offlineActivityFriends.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <Mascot state="sleeping" className="w-[100px] h-[100px]" />
                <div className="text-sm text-txt-tertiary mt-4 max-w-[240px]">
                  It's quiet for now... When friends start an activity, we'll show it here!
                </div>
              </div>
            ) : (
              <>
                {activeFriends.length > 0 && (
                  <div className="mb-4">
                    <h2 className="text-xs font-bold text-txt-tertiary uppercase mb-2 tracking-wider px-2">
                      Active — {activeFriends.length}
                    </h2>
                    {activeFriends.map(f => renderActivityFriend(f))}
                  </div>
                )}
                {idleFriends.length > 0 && (
                  <div className="mb-4">
                    <h2 className="text-xs font-bold text-txt-tertiary uppercase mb-2 tracking-wider px-2">
                      Online — {idleFriends.length}
                    </h2>
                    {idleFriends.map(f => renderActivityFriend(f))}
                  </div>
                )}
                {offlineActivityFriends.length > 0 && (
                  <div>
                    <h2 className="text-xs font-bold text-txt-tertiary uppercase mb-2 tracking-wider px-2">
                      Offline — {offlineActivityFriends.length}
                    </h2>
                    {offlineActivityFriends.map(f => renderActivityFriend(f, true))}
                  </div>
                )}
              </>
            )}
          </div>
        );
      }
    }
  };

  const popMobileScreen = useUIStore((s) => s.popMobileScreen);

  return (
    <div className="flex-1 flex flex-col bg-surface-chat h-full">
      {/* Header */}
      {mobile ? (
        <div className="h-12 px-3 flex items-center gap-2 border-b border-border-soft flex-shrink-0 z-10 bg-surface-base">
          <button onClick={popMobileScreen} className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 19.5L8.25 12l7.5-7.5" />
            </svg>
          </button>
          <span className="font-semibold text-sm text-txt-primary">Friends</span>
        </div>
      ) : (
        <div className="h-12 px-4 flex items-center shadow-header flex-shrink-0 z-10 bg-surface-chat">
          <div className="flex items-center gap-2 mr-4">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
            <span className="font-bold text-txt-primary">Friends</span>
          </div>
          <div className="w-[1px] h-6 bg-surface-elevated mx-2" />
          <div className="flex items-center gap-4 ml-2">
            <TabButton active={activeTab === 'online'} onClick={() => setActiveTab('online')}>Online</TabButton>
            <TabButton active={activeTab === 'all'} onClick={() => setActiveTab('all')}>All</TabButton>
            <TabButton active={activeTab === 'pending'} onClick={() => setActiveTab('pending')}>
              Pending
              {(pendingIncoming.length > 0) && (
                <span className="ml-2 px-1.5 py-0.5 bg-accent-rose text-white text-[10px] rounded-full leading-none">
                  {pendingIncoming.length}
                </span>
              )}
            </TabButton>
            <button
              onClick={() => setActiveTab('add')}
              className={`px-2 py-0.5 rounded text-[14px] font-medium transition-all ${
                activeTab === 'add' ? 'text-status-online bg-transparent' : 'bg-status-online text-[#13131a] hover:bg-status-online/90'
              }`}
            >
              Add Friend
            </button>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <MemberListToggleButton />
          </div>
        </div>
      )}

      {/* Mobile tab bar */}
      {mobile && (
        <div className="flex border-b border-border-soft">
          {(['online', 'all', 'pending', 'add', 'activity'] as Tab[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`flex-1 py-2.5 text-sm font-medium text-center border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-accent-primary text-txt-primary'
                  : 'border-transparent text-txt-secondary hover:text-txt-primary'
              }`}
            >
              {tab === 'add' ? 'Add Friend' : tab === 'activity' ? 'Activity' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'pending' && pendingIncoming.length > 0 && (
                <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-notification text-white rounded-full">
                  {pendingIncoming.length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {renderTabContent()}

      {connectModal && (
        <ConnectInstanceModal
          domain={connectModal.domain}
          targetDisplayName={connectModal.username}
          isReconnect={connectModal.isReconnect}
          onConnected={handleAddFriendConnected}
          onCancel={() => setConnectModal(null)}
        />
      )}
    </div>
  );
}

// ─── Add Friend Tab ─────────────────────────────────────────────────────────

function AddFriendTab({
  addUsername,
  setAddUsername,
  addStatus,
  isLoading,
  onSubmit,
  onOpenDm,
}: {
  addUsername: string;
  setAddUsername: (v: string) => void;
  addStatus: { type: 'success' | 'error'; message: string } | null;
  isLoading: boolean;
  onSubmit: (e: React.FormEvent) => void;
  onOpenDm: (userId: string, origin: string, homeUserId?: string) => void;
}) {
  const discoverUsers = useDiscoverStore((s) => s.users);
  const discoverLoading = useDiscoverStore((s) => s.isLoading);
  const discoverQuery = useDiscoverStore((s) => s.searchQuery);
  const setDiscoverQuery = useDiscoverStore((s) => s.setSearchQuery);
  const fetchUsers = useDiscoverStore((s) => s.fetchUsers);
  const updateRelationship = useDiscoverStore((s) => s.updateRelationship);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fetch discovery on mount
  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const handleDiscoverSearch = useCallback((value: string) => {
    setDiscoverQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchUsers(value || undefined);
    }, 300);
  }, [setDiscoverQuery, fetchUsers]);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="p-6 pb-4">
        <h2 className="text-base font-bold text-txt-primary uppercase mb-2">Add Friend</h2>
        <p className="text-sm text-txt-tertiary mb-4">You can add friends with their Backspace username.</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-2 mb-4">
          <input
            type="text"
            placeholder="Enter a username..."
            value={addUsername}
            onChange={(e) => setAddUsername(e.target.value)}
            className="input-search w-full px-4 py-3 rounded-lg"
          />
          <button
            type="submit"
            disabled={!addUsername.trim() || isLoading}
            className="w-full py-2.5 rounded-lg bg-accent-primary hover:bg-accent-primary-hover disabled:opacity-50 disabled:bg-accent-primary text-white text-sm font-medium transition-colors"
          >
            Send Friend Request
          </button>
        </form>
        {addStatus && (
          <div className={`text-sm p-3 rounded-lg border mb-4 ${addStatus.type === 'success' ? 'text-txt-positive border-status-online/20 bg-status-online/5' : 'text-txt-danger border-accent-rose/20 bg-accent-rose/5'}`}>
            {addStatus.message}
          </div>
        )}
      </div>

      {/* Discover People section */}
      <div className="px-6 pb-6">
        <div className="flex items-center gap-2 mb-4">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-5.5-2.5l7.51-3.49L17.5 6.5 9.99 9.99 6.5 17.5zm5.5-6.6c.61 0 1.1.49 1.1 1.1s-.49 1.1-1.1 1.1-1.1-.49-1.1-1.1.49-1.1 1.1-1.1z" />
          </svg>
          <span className="text-xs font-semibold uppercase tracking-wider text-txt-tertiary">Discover People</span>
        </div>

        {/* Discover search */}
        <div className="relative mb-4">
          <input
            type="text"
            placeholder="Search people..."
            value={discoverQuery}
            onChange={(e) => handleDiscoverSearch(e.target.value)}
            className="input-search w-full"
          />
          {discoverQuery && (
            <button
              onClick={() => handleDiscoverSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-txt-tertiary hover:text-txt-secondary"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          )}
        </div>

        {/* Grid */}
        {discoverLoading && discoverUsers.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <LoadingSpinner />
          </div>
        ) : discoverUsers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 opacity-60">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary mb-2">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
            </svg>
            <p className="text-txt-tertiary text-sm">
              {discoverQuery
                ? 'No users match your search.'
                : 'No discoverable users yet — invite people to join!'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {discoverUsers.map((user) => (
              <UserDiscoverCard
                key={`${user.id}:${user._instanceOrigin}`}
                user={user}
                onOpenDm={onOpenDm}
                onRelationshipChange={updateRelationship}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── User Discover Card ─────────────────────────────────────────────────────

function UserDiscoverCard({
  user,
  onOpenDm,
  onRelationshipChange,
}: {
  user: TaggedDiscoverUser;
  onOpenDm: (userId: string, origin: string, homeUserId?: string) => void;
  onRelationshipChange: (userId: string, origin: string, relationship: TaggedDiscoverUser['relationship'], requestId?: string) => void;
}) {
  const sendFriendRequest = useSocialStore((s) => s.sendFriendRequest);
  const updateFriendRequest = useSocialStore((s) => s.updateFriendRequest);
  const openModal = useUIStore((s) => s.openModal);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState('');
  const addToast = useUIStore((s) => s.addToast);
  const [connectModal, setConnectModal] = useState<{
    domain: string;
    isReconnect: boolean;
    username: string;
  } | null>(null);

  const displayName = user.displayName ?? user.username;
  const baseName = user.username.includes('@') ? user.username.split('@')[0]! : user.username;
  const gradient = getAvatarGradient(user.homeUserId ?? user.id, displayName, user.avatarColor);
  const originLabel = user._instanceOrigin
    ? (() => { try { return new URL(user._instanceOrigin).host; } catch { return user._instanceOrigin; } })()
    : null;

  const avatarUrl = user.avatar
    ? (user.avatar.startsWith('http') || user.avatar.startsWith('/') ? user.avatar : `/api/uploads/${user.avatar}`)
    : null;
  const bannerUrl = user.banner
    ? (user.banner.startsWith('http') || user.banner.startsWith('/') ? user.banner : `/api/uploads/${user.banner}`)
    : null;

  const handleSendRequest = async () => {
    setActionLoading(true);
    setError('');
    const username = user._instanceOrigin ? baseName + '@' + (originLabel ?? '') : baseName;
    try {
      const requestId = await sendFriendRequest(username);
      onRelationshipChange(user.id, user._instanceOrigin, 'outbound_pending', requestId);
    } catch (err) {
      if (err instanceof InstanceNotConnectedError) {
        setConnectModal({ domain: err.domain, isReconnect: false, username });
      } else if (err instanceof InstanceDisconnectedError) {
        setConnectModal({ domain: err.domain, isReconnect: true, username });
      } else {
        setError(err instanceof Error ? err.message : 'Failed to send request');
      }
    } finally {
      setActionLoading(false);
    }
  };

  const handleDiscoverConnected = async (result: 'new' | 'reconnect') => {
    const username = connectModal?.username;
    const domain = connectModal?.domain;
    setConnectModal(null);
    if (!username) return;

    setActionLoading(true);
    try {
      const requestId = await sendFriendRequest(username);
      onRelationshipChange(user.id, user._instanceOrigin, 'outbound_pending', requestId);
      const verb = result === 'reconnect' ? 'Reconnected to' : 'Connected to';
      addToast(`${verb} ${domain} — friend request sent!`, 'success');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send request');
    } finally {
      setActionLoading(false);
    }
  };

  const handleAccept = async () => {
    if (!user.requestId) return;
    setActionLoading(true);
    setError('');
    try {
      await updateFriendRequest(user.requestId, 'accepted');
      onRelationshipChange(user.id, user._instanceOrigin, 'friends');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept request');
    } finally {
      setActionLoading(false);
    }
  };

  const handleDecline = async () => {
    if (!user.requestId) return;
    setActionLoading(true);
    setError('');
    try {
      await updateFriendRequest(user.requestId, 'declined');
      onRelationshipChange(user.id, user._instanceOrigin, 'none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to decline request');
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancelRequest = async () => {
    if (!user.requestId) return;
    setActionLoading(true);
    setError('');
    try {
      const origin = user._instanceOrigin;
      const client = origin
        ? (useInstanceStore.getState().instances.find(i => i.origin === origin)?.api ?? api)
        : api;
      await client.social.cancelRequest(user.requestId);
      onRelationshipChange(user.id, user._instanceOrigin, 'none');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel request');
    } finally {
      setActionLoading(false);
    }
  };

  const handleOpenProfile = () => {
    openModal('userProfile', { userId: user.id, user, origin: user._instanceOrigin });
  };

  const handleMessage = () => {
    onOpenDm(user.id, user._instanceOrigin, user.homeUserId ?? undefined);
  };

  return (
    <div className="bg-surface-channel rounded-lg border border-border-soft hover:border-border-hard overflow-hidden flex flex-col transition-colors">
      {/* Banner area */}
      <div className="h-24 relative overflow-hidden">
        {bannerUrl ? (
          <img src={bannerUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0" style={{ background: gradient.gradient }} />
        )}
        <div
          className="absolute bottom-0 inset-x-0 h-12"
          style={{ background: 'linear-gradient(to top, rgba(20,20,26,0.9), transparent)' }}
        />
        {originLabel && (
          <div className="absolute top-2 right-2 z-[2]">
            <span className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold backdrop-blur-sm bg-black/30 text-txt-secondary">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" className="opacity-60">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
              </svg>
              {originLabel}
            </span>
          </div>
        )}
      </div>

      {/* Overlapping avatar */}
      <div className="relative px-4 -mt-7 z-10">
        <button onClick={handleOpenProfile} className="block">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-12 h-12 rounded-full object-cover ring-[3px] ring-surface-channel shadow-lg"
            />
          ) : (
            <div
              className="w-12 h-12 rounded-full ring-[3px] ring-surface-channel shadow-lg flex items-center justify-center text-lg font-bold text-white/90"
              style={{ background: gradient.gradient }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
        </button>
      </div>

      {/* Content */}
      <div className="px-4 pt-1.5 pb-3.5 flex flex-col flex-1">
        <button onClick={handleOpenProfile} className="text-left group">
          <h3 className="text-[14px] font-bold text-txt-primary truncate group-hover:underline">{displayName}</h3>
          <p className="text-[12px] text-txt-tertiary truncate">@{user.username}</p>
        </button>

        {user.bio && (
          <p className="text-[12px] text-txt-secondary line-clamp-2 mt-1.5 flex-1">{user.bio}</p>
        )}
        {!user.bio && <div className="flex-1" />}

        {/* Mutuals */}
        {(user.mutualFriendCount > 0 || user.mutualSpaceCount > 0) && (
          <div className="flex items-center gap-2.5 text-[11px] text-txt-tertiary mt-2 mb-2.5">
            {user.mutualFriendCount > 0 && (
              <span>{user.mutualFriendCount} mutual {user.mutualFriendCount === 1 ? 'friend' : 'friends'}</span>
            )}
            {user.mutualFriendCount > 0 && user.mutualSpaceCount > 0 && (
              <span className="text-txt-tertiary/40">·</span>
            )}
            {user.mutualSpaceCount > 0 && (
              <span>{user.mutualSpaceCount} mutual {user.mutualSpaceCount === 1 ? 'space' : 'spaces'}</span>
            )}
          </div>
        )}
        {user.mutualFriendCount === 0 && user.mutualSpaceCount === 0 && <div className="mt-2" />}

        {/* Error */}
        {error && (
          <div className="text-[11px] text-txt-danger mb-1.5 truncate">{error}</div>
        )}

        {/* Action button */}
        {user.relationship === 'none' && (
          <button
            onClick={handleSendRequest}
            disabled={actionLoading}
            className="w-full py-1.5 bg-accent-primary hover:bg-accent-primary-hover text-white text-[13px] font-medium rounded transition-colors disabled:opacity-50"
          >
            {actionLoading ? 'Sending...' : 'Send Friend Request'}
          </button>
        )}
        {user.relationship === 'outbound_pending' && (
          <button
            onClick={handleCancelRequest}
            disabled={actionLoading || !user.requestId}
            className="w-full py-1.5 bg-accent-amber/15 hover:bg-accent-amber/25 text-accent-amber text-[13px] font-medium rounded transition-colors disabled:opacity-50"
          >
            {actionLoading ? 'Cancelling...' : 'Request Pending'}
          </button>
        )}
        {user.relationship === 'inbound_pending' && (
          <div className="flex gap-2">
            <button
              onClick={handleAccept}
              disabled={actionLoading}
              className="flex-1 py-1.5 bg-status-online/20 hover:bg-status-online/30 text-status-online text-[13px] font-medium rounded transition-colors disabled:opacity-50"
            >
              Accept
            </button>
            <button
              onClick={handleDecline}
              disabled={actionLoading}
              className="flex-1 py-1.5 bg-accent-rose/15 hover:bg-accent-rose/25 text-accent-rose text-[13px] font-medium rounded transition-colors disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}
        {user.relationship === 'friends' && (
          <button
            onClick={handleMessage}
            className="w-full py-1.5 bg-accent-mint/15 hover:bg-accent-mint/25 text-accent-mint text-[13px] font-medium rounded transition-colors"
          >
            Message
          </button>
        )}
      </div>
      {connectModal && (
        <ConnectInstanceModal
          domain={connectModal.domain}
          targetDisplayName={user.displayName ?? baseName}
          isReconnect={connectModal.isReconnect}
          onConnected={handleDiscoverConnected}
          onCancel={() => setConnectModal(null)}
        />
      )}
    </div>
  );
}

// ─── Shared Components ──────────────────────────────────────────────────────

function TabButton({ children, active, onClick }: { children: React.ReactNode, active: boolean, onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 rounded-[4px] text-[16px] font-medium transition-colors ${
        active ? 'bg-interactive-selected text-white' : 'text-txt-tertiary hover:bg-interactive-hover hover:text-txt-secondary'
      }`}
    >
      {children}
    </button>
  );
}

function FriendItem({ friend, onRemove, onDm }: { friend: TaggedFriend, onRemove: () => void, onDm: () => void }) {
  const instanceLabel = friend._instanceOrigin ? (() => { try { return new URL(friend._instanceOrigin).host; } catch { return friend._instanceOrigin; } })() : '';
  return (
    <div className="flex items-center justify-between px-3 h-[62px] rounded-[8px] hover:bg-interactive-hover group transition-colors border-t border-interactive-muted mx-2">
      <div className="flex items-center gap-3">
        <Avatar src={friend.avatar} name={friend.displayName ?? friend.username} size={32} status={friend.status} userId={friend.homeUserId ?? friend.id} avatarColor={friend.avatarColor} />
        <div className="flex flex-col leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-txt-primary font-semibold text-[15px]">{friend.displayName ?? friend.username}</span>
            <span className="text-txt-tertiary text-[13px] opacity-0 group-hover:opacity-100 transition-opacity font-medium">@{friend.username}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[12px] text-txt-tertiary font-medium uppercase">{friend.status}</span>
            {instanceLabel && (
              <span className="text-[11px] text-txt-tertiary/60 font-medium">via {instanceLabel}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity pr-2">
        <button
          onClick={(e) => { e.stopPropagation(); onDm(); }}
          className="w-9 h-9 flex items-center justify-center bg-surface-base rounded-full text-txt-tertiary hover:text-txt-primary transition-colors"
          title="Message"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-5H6V7h12v2z" />
          </svg>
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="w-9 h-9 flex items-center justify-center bg-surface-base rounded-full text-txt-tertiary hover:text-txt-danger transition-colors"
          title="Remove Friend"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function RequestItem({ request, type, onAccept, onDecline, onCancel }: {
  request: TaggedFriendRequest;
  type: 'incoming' | 'outgoing';
  onAccept?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
}) {
  const user = request.user;
  if (!user) return null;
  const instanceLabel = request._instanceOrigin ? (() => { try { return new URL(request._instanceOrigin).host; } catch { return request._instanceOrigin; } })() : '';

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-interactive-hover group transition-colors border-t border-interactive-muted mx-2">
      <div className="flex items-center gap-3">
        <Avatar src={user.avatar} name={user.displayName ?? user.username} size={32} status={user.status as any} userId={user.homeUserId ?? user.id} avatarColor={user.avatarColor} />
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="text-txt-primary font-bold text-sm">{user.displayName ?? user.username}</span>
            <span className="text-txt-tertiary text-xs">@{user.username}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-txt-tertiary">{type === 'incoming' ? 'Incoming Friend Request' : 'Outgoing Friend Request'}</span>
            {instanceLabel && (
              <span className="text-[11px] text-txt-tertiary/60 font-medium">via {instanceLabel}</span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {type === 'incoming' ? (
          <>
            <button
              onClick={() => onAccept?.()}
              className="p-2 bg-surface-base rounded-full text-status-online hover:bg-status-online hover:text-white transition-all"
              title="Accept"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            </button>
            <button
              onClick={() => onDecline?.()}
              className="p-2 bg-surface-base rounded-full text-txt-danger hover:bg-accent-rose hover:text-white transition-all"
              title="Decline"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          </>
        ) : (
          <button
            onClick={() => onCancel?.()}
            className="p-2 bg-surface-base rounded-full text-txt-tertiary hover:text-txt-danger transition-all"
            title="Cancel Request"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
