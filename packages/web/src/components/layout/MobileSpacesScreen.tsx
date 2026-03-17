import React, { useState, useMemo, useEffect } from 'react';
import { useUIStore } from '../../stores/uiStore';
import { useSpaceStore } from '../../stores/spaceStore';
import { useChatStore } from '../../stores/chatStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { useNavigate } from 'react-router-dom';
import { getSpaceGradient } from '../../utils/gradients';
import { resolveAssetUrl } from '../../utils/assetUrls';
import { hasPermissionBit, PermissionBits } from '../../utils/permissions';
import type { Channel } from '@backspace/shared';

export function MobileSpacesScreen() {
  const spaces = useSpaceStore((s) => s.spaces);
  const channels = useSpaceStore((s) => s.channels);
  const categories = useSpaceStore((s) => s.categories);
  const currentSpaceId = useSpaceStore((s) => s.currentSpaceId);
  const loadSpaceDetail = useSpaceStore((s) => s.loadSpaceDetail);
  const setCurrentSpace = useSpaceStore((s) => s.setCurrentSpace);
  const channelToSpaceMap = useSpaceStore((s) => s.channelToSpaceMap);
  const voiceChannelIds = useSpaceStore((s) => s.voiceChannelIds);
  const spacePermissions = useSpaceStore((s) => s.spacePermissions);
  const channelPermissions = useSpaceStore((s) => s.channelPermissions);

  const unreadChannels = useChatStore((s) => s.unreadChannels);
  const currentChannelId = useChatStore((s) => s.currentChannelId);

  const voiceUsers = useVoiceStore((s) => s.voiceUsers);
  const currentVoiceChannelId = useVoiceStore((s) => s.currentVoiceChannelId);
  const setCurrentVoiceChannel = useVoiceStore((s) => s.setCurrentVoiceChannel);

  const pushMobileScreen = useUIStore((s) => s.pushMobileScreen);
  const setMobileTab = useUIStore((s) => s.setMobileTab);
  const openModal = useUIStore((s) => s.openModal);
  const setLastChannel = useUIStore((s) => s.setLastChannel);

  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);

  // Local state
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(currentSpaceId);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [showAddSheet, setShowAddSheet] = useState(false);

  // Sync selected space with store's current space
  useEffect(() => {
    if (selectedSpaceId) {
      setCurrentSpace(selectedSpaceId);
      loadSpaceDetail(selectedSpaceId);
    }
  }, [selectedSpaceId, setCurrentSpace, loadSpaceDetail]);

  // Auto-select first space if none selected
  useEffect(() => {
    if (!selectedSpaceId && spaces.length > 0 && spaces[0]) {
      setSelectedSpaceId(spaces[0].id);
    }
  }, [selectedSpaceId, spaces]);

  // Check if loaded channels belong to selected space
  const spaceChannels = useMemo(() => {
    if (!selectedSpaceId) return [];
    return channels.filter(c => channelToSpaceMap.get(c.id) === selectedSpaceId);
  }, [channels, channelToSpaceMap, selectedSpaceId]);

  // Group channels by category
  const channelsByCategory = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const ch of spaceChannels) {
      if (!ch.categoryId) continue;
      let arr = map.get(ch.categoryId);
      if (!arr) { arr = []; map.set(ch.categoryId, arr); }
      arr.push(ch);
    }
    for (const [key, arr] of map) {
      map.set(key, arr.sort((a, b) => a.position - b.position));
    }
    return map;
  }, [spaceChannels]);

  const uncategorizedChannels = useMemo(() =>
    spaceChannels
      .filter(c => !c.categoryId)
      .sort((a, b) => a.position - b.position),
    [spaceChannels]
  );

  const sortedCategories = useMemo(() =>
    [...categories].sort((a, b) => a.position - b.position),
    [categories]
  );

  // Check if space has unread text channels
  const spaceHasUnread = (spaceId: string): boolean => {
    for (const chId of unreadChannels) {
      if (channelToSpaceMap.get(chId) === spaceId && !voiceChannelIds.has(chId)) {
        return true;
      }
    }
    return false;
  };

  const handleSpaceSelect = (spaceId: string) => {
    setSelectedSpaceId(spaceId);
    setCollapsedCategories(new Set());
  };

  const handleChannelTap = (channel: Channel) => {
    if (channel.type === 'voice') {
      setCurrentVoiceChannel(channel.id);
      return;
    }
    if (selectedSpaceId) {
      setLastChannel(selectedSpaceId, channel.id);
      navigate(`/channels/${selectedSpaceId}/${channel.id}`);
    }
    pushMobileScreen('channel-chat', {
      channelId: channel.id,
      spaceId: selectedSpaceId || '',
    });
  };

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      return next;
    });
  };

  const selectedSpace = spaces.find(s => s.id === selectedSpaceId);
  const myPerms = selectedSpaceId ? spacePermissions.get(selectedSpaceId) : undefined;
  const canInvite = hasPermissionBit(myPerms, PermissionBits.CREATE_INVITE);
  const canManageSpace = hasPermissionBit(myPerms, PermissionBits.MANAGE_SPACE);

  const renderChannelItem = (channel: Channel) => {
    const isVoice = channel.type === 'voice';
    const isActive = !isVoice && currentChannelId === channel.id;
    const isUnread = unreadChannels.has(channel.id) && !isActive;
    const isInVoice = currentVoiceChannelId === channel.id;
    const vUsers = voiceUsers.get(channel.id) || [];
    const canView = hasPermissionBit(channelPermissions.get(channel.id), PermissionBits.VIEW_CHANNEL);
    if (canView === false) return null;

    return (
      <button
        key={channel.id}
        onClick={() => handleChannelTap(channel)}
        className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-left transition-colors ${
          isActive ? 'bg-interactive-selected text-txt-primary' :
          isInVoice ? 'bg-accent-mint/10 text-accent-mint' :
          'text-txt-secondary hover:bg-interactive-hover hover:text-txt-primary'
        }`}
      >
        {isVoice ? (
          <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z" />
          </svg>
        ) : (
          <span className="text-sm shrink-0 opacity-60">#</span>
        )}
        <span className={`flex-1 text-sm truncate ${isUnread ? 'font-semibold text-txt-primary' : ''}`}>
          {channel.name}
        </span>
        {isUnread && <span className="w-2 h-2 rounded-full bg-txt-primary shrink-0" />}
        {isVoice && vUsers.length > 0 && (
          <span className="text-xs text-txt-tertiary">{vUsers.length}</span>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full">
      {/* Space strip */}
      <div className="w-[60px] shrink-0 glass-strip flex flex-col items-center py-2 gap-1.5 overflow-y-auto no-scrollbar">
        {/* Home / DMs button */}
        <button
          onClick={() => {
            setMobileTab('dms');
            navigate('/channels/@me');
          }}
          className="w-10 h-10 rounded-2xl bg-surface-elevated flex items-center justify-center text-txt-secondary hover:text-txt-primary hover:bg-accent-primary transition-all"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
          </svg>
        </button>

        <div className="w-8 h-px bg-border-soft my-0.5" />

        {/* Space icons */}
        {spaces.map(space => {
          const isSelected = space.id === selectedSpaceId;
          const hasUnread = spaceHasUnread(space.id);
          const iconUrl = space.icon
            ? resolveAssetUrl(space.icon, space._instanceOrigin) ?? `/api/uploads/${space.icon}`
            : null;
          const grad = getSpaceGradient(space.id, space.name, space.avatarColor);

          return (
            <div key={space.id} className="relative">
              {/* Unread / selected pill */}
              <div className="absolute -left-1 top-1/2 -translate-y-1/2 w-1 flex items-center">
                <div
                  className={`bg-white rounded-r-full transition-all duration-200 w-full ${
                    isSelected ? 'h-8' : hasUnread ? 'h-2' : 'h-0'
                  }`}
                />
              </div>
              <button
                onClick={() => handleSpaceSelect(space.id)}
                className={`w-10 h-10 rounded-2xl overflow-hidden flex items-center justify-center transition-all ${
                  isSelected ? 'rounded-xl ring-2 ring-accent-primary/50' : 'hover:rounded-xl'
                }`}
                style={!iconUrl ? { background: grad.gradient } : undefined}
              >
                {iconUrl ? (
                  <img src={iconUrl} alt={space.name} className="w-full h-full object-cover" />
                ) : (
                  <span className="text-[15px] font-bold text-white">
                    {space.name.charAt(0).toUpperCase()}
                  </span>
                )}
              </button>
            </div>
          );
        })}

        <div className="w-8 h-px bg-border-soft my-0.5" />

        {/* Add space button */}
        <button
          onClick={() => setShowAddSheet(true)}
          className="w-10 h-10 rounded-2xl bg-surface-elevated flex items-center justify-center text-accent-mint hover:bg-accent-mint/10 transition-colors"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
        </button>
      </div>

      {/* Channel list */}
      <div className="flex-1 flex flex-col min-w-0 bg-surface-channel">
        {/* Space header */}
        {selectedSpace && (
          <header className="h-12 flex items-center gap-2 px-3 border-b border-border-soft shrink-0">
            <h1 className="flex-1 text-sm font-semibold text-txt-primary truncate">
              {selectedSpace.name}
            </h1>
            {canInvite && (
              <button
                onClick={() => openModal('invite', { spaceId: selectedSpaceId })}
                className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18 7.5v3m0 0v3m0-3h3m-3 0h-3m-2.25-4.125a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zM3 19.235v-.11a6.375 6.375 0 0112.75 0v.109A12.318 12.318 0 019.374 21c-2.331 0-4.512-.645-6.374-1.766z" />
                </svg>
              </button>
            )}
            {canManageSpace && (
              <button
                onClick={() => openModal('spaceSettings', { spaceId: selectedSpaceId })}
                className="w-8 h-8 flex items-center justify-center text-txt-secondary hover:text-txt-primary"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            )}
          </header>
        )}

        {/* Channel list */}
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {/* Uncategorized channels */}
          {uncategorizedChannels.map(renderChannelItem)}

          {/* Categorized channels */}
          {sortedCategories.map(category => {
            const catChannels = channelsByCategory.get(category.id) || [];
            if (catChannels.length === 0) return null;
            const isCollapsed = collapsedCategories.has(category.id);

            return (
              <div key={category.id} className="mt-3">
                <button
                  onClick={() => toggleCategory(category.id)}
                  className="flex items-center gap-1 px-1 py-1 w-full text-left"
                >
                  <svg
                    className={`w-3 h-3 text-txt-tertiary transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-txt-tertiary truncate">
                    {category.name}
                  </span>
                </button>
                {!isCollapsed && catChannels.map(renderChannelItem)}
              </div>
            );
          })}

          {/* Empty state */}
          {spaceChannels.length === 0 && selectedSpaceId && (
            <div className="flex items-center justify-center h-32 text-txt-tertiary text-sm">
              No channels yet
            </div>
          )}
        </div>
      </div>

      {/* Add Space bottom sheet */}
      {showAddSheet && (
        <>
          <div className="fixed inset-0 z-[300] bg-black/50" onClick={() => setShowAddSheet(false)} />
          <div
            className="fixed bottom-0 left-0 right-0 z-[301] rounded-t-2xl glass-bubble animate-slide-up-sheet"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="w-10 h-1 bg-txt-tertiary/30 rounded-full mx-auto mt-2 mb-1" />
            <div className="py-2">
              <button
                onClick={() => { setShowAddSheet(false); openModal('createSpace'); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-interactive-hover"
              >
                <svg className="w-5 h-5 text-accent-mint" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                </svg>
                <span className="text-sm text-txt-primary">Create Space</span>
              </button>
              <button
                onClick={() => { setShowAddSheet(false); openModal('joinSpace'); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-interactive-hover"
              >
                <svg className="w-5 h-5 text-accent-sky" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                </svg>
                <span className="text-sm text-txt-primary">Join Space</span>
              </button>
              <button
                onClick={() => { setShowAddSheet(false); pushMobileScreen('explore'); }}
                className="w-full flex items-center gap-3 px-5 py-3 text-left hover:bg-interactive-hover"
              >
                <svg className="w-5 h-5 text-accent-lavender" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 21a9.004 9.004 0 008.716-6.747M12 21a9.004 9.004 0 01-8.716-6.747M12 21c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3m0 0a8.997 8.997 0 017.843 4.582M12 3a8.997 8.997 0 00-7.843 4.582m15.686 0A11.953 11.953 0 0112 10.5c-2.998 0-5.74-1.1-7.843-2.918m15.686 0A8.959 8.959 0 0121 12c0 .778-.099 1.533-.284 2.253m0 0A17.919 17.919 0 0112 16.5c-3.162 0-6.133-.815-8.716-2.247m0 0A9.015 9.015 0 013 12c0-1.605.42-3.113 1.157-4.418" />
                </svg>
                <span className="text-sm text-txt-primary">Explore Spaces</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
