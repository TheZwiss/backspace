import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocialStore } from '../../stores/socialStore';
import { useServerStore } from '../../stores/serverStore';
import { Avatar } from '../ui/Avatar';
import { MemberListToggleButton } from '../layout/MemberListToggleButton';
import { LoadingSpinner } from '../ui/LoadingSpinner';
import { api } from '../../api/client';
import type { Friend, FriendRequest } from '@backspace/shared';

type Tab = 'online' | 'all' | 'pending' | 'add';

export function FriendsPage() {
  const [activeTab, setActiveTab] = useState<Tab>('online');
  const [addUsername, setAddUsername] = useState('');
  const [addStatus, setAddStatus] = useState<{ type: 'success' | 'error', message: string } | null>(null);
  const navigate = useNavigate();
  const addDmChannel = useServerStore((s) => s.addDmChannel);

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
      setAddStatus({ type: 'error', message: (err as Error).message });
    }
  };

  const handleOpenDm = async (friendId: string) => {
    try {
      const dmChannel = await api.dm.create({ userId: friendId });
      addDmChannel(dmChannel);
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
              <div className="flex flex-col items-center justify-center h-full opacity-60">
                <img src="/friends-empty.svg" alt="" className="w-64 h-64 mb-4" onError={(e) => (e.target as any).style.display='none'} />
                <p className="text-txt-tertiary">No one's around to play with Wumpus.</p>
              </div>
            ) : (
              onlineFriends.map(friend => (
                <FriendItem key={friend.id} friend={friend} onRemove={() => removeFriend(friend.id)} onDm={() => handleOpenDm(friend.id)} />
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
              <div className="flex flex-col items-center justify-center h-full opacity-60">
                <p className="text-txt-tertiary">Wumpus is waiting on friends. You can add them!</p>
              </div>
            ) : (
              friends.map(friend => (
                <FriendItem key={friend.id} friend={friend} onRemove={() => removeFriend(friend.id)} onDm={() => handleOpenDm(friend.id)} />
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
              <div className="flex flex-col items-center justify-center h-full opacity-60">
                <p className="text-txt-tertiary">There are no pending friend requests. Here's Wumpus for now!</p>
              </div>
            ) : (
              <>
                {pendingIncoming.map(req => (
                  <RequestItem
                    key={req.id}
                    request={req}
                    type="incoming"
                    onAccept={() => updateFriendRequest(req.id, 'accepted')}
                    onDecline={() => updateFriendRequest(req.id, 'declined')}
                  />
                ))}
                {pendingOutgoing.map(req => (
                  <RequestItem
                    key={req.id}
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
          <div className="flex-1 p-8">
            <h2 className="text-base font-bold text-txt-primary uppercase mb-2">Add Friend</h2>
            <p className="text-sm text-txt-tertiary mb-4">You can add friends with their Backspace username.</p>
            <form onSubmit={handleAddFriend} className="relative mb-8">
              <input
                type="text"
                placeholder="You can add a friend with their username"
                value={addUsername}
                onChange={(e) => setAddUsername(e.target.value)}
                className="w-full bg-surface-base text-txt-primary px-4 py-3 rounded-lg border border-transparent focus:border-txt-link outline-none transition-all placeholder:text-txt-tertiary/50"
              />
              <button
                type="submit"
                disabled={!addUsername.trim() || isLoading}
                className="absolute right-2 top-1.5 px-4 py-1.5 bg-accent-primary hover:bg-accent-primary-hover disabled:opacity-50 disabled:bg-accent-primary text-white text-sm font-medium rounded transition-colors"
              >
                Send Friend Request
              </button>
            </form>
            {addStatus && (
              <div className={`text-sm p-3 rounded-lg border ${addStatus.type === 'success' ? 'text-txt-positive border-status-online/20 bg-status-online/5' : 'text-txt-danger border-accent-rose/20 bg-accent-rose/5'}`}>
                {addStatus.message}
              </div>
            )}
          </div>
        );
    }
  };

  return (
    <div className="flex-1 flex flex-col bg-surface-chat h-full">
      {/* Header */}
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

      {renderTabContent()}
    </div>
  );
}

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

function FriendItem({ friend, onRemove, onDm }: { friend: Friend, onRemove: () => void, onDm: () => void }) {
  return (
    <div className="flex items-center justify-between px-3 h-[62px] rounded-[8px] hover:bg-interactive-hover group transition-colors border-t border-interactive-muted mx-2">
      <div className="flex items-center gap-3">
        <Avatar src={friend.avatar} name={friend.displayName ?? friend.username} size={32} status={friend.status} userId={friend.id} />
        <div className="flex flex-col leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-txt-primary font-semibold text-[15px]">{friend.displayName ?? friend.username}</span>
            <span className="text-txt-tertiary text-[13px] opacity-0 group-hover:opacity-100 transition-opacity font-medium">@{friend.username}</span>
          </div>
          <span className="text-[12px] text-txt-tertiary font-medium uppercase">{friend.status}</span>
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
  request: FriendRequest;
  type: 'incoming' | 'outgoing';
  onAccept?: () => void;
  onDecline?: () => void;
  onCancel?: () => void;
}) {
  const user = request.user;
  if (!user) return null;

  return (
    <div className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-interactive-hover group transition-colors border-t border-interactive-muted mx-2">
      <div className="flex items-center gap-3">
        <Avatar src={user.avatar} name={user.displayName ?? user.username} size={32} status={user.status as any} userId={user.id} />
        <div className="flex flex-col">
          <div className="flex items-center gap-1.5">
            <span className="text-txt-primary font-bold text-sm">{user.displayName ?? user.username}</span>
            <span className="text-txt-tertiary text-xs">@{user.username}</span>
          </div>
          <span className="text-xs text-txt-tertiary">{type === 'incoming' ? 'Incoming Friend Request' : 'Outgoing Friend Request'}</span>
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
