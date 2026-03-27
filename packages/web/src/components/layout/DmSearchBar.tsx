import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { User, DmChannel } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { useSpaceStore, getApiForOrigin, resolveUserOrigin } from '../../stores/spaceStore';
import { useAuthStore } from '../../stores/authStore';
import { useUIStore } from '../../stores/uiStore';
import { api } from '../../api/client';
import { isSelf, parseFederatedUsername } from '../../utils/identity';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';

const MAX_RECENT = 8;
const SEARCH_DEBOUNCE = 300;

interface DmItem {
  type: 'dm';
  dm: DmChannel;
  displayName: string;
  otherMembers: DmChannel['members'];
  isGroup: boolean;
}

interface UserItem {
  type: 'user';
  user: User;
}

type ResultItem = DmItem | UserItem;

export function DmSearchBar() {
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState('');
  const [userResults, setUserResults] = useState<User[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const dmChannels = useSpaceStore((s) => s.dmChannels);
  const addDmChannel = useSpaceStore((s) => s.addDmChannel);
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();

  const anchorRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const { style } = useFloatingPosition(anchorRef, floatingRef, {
    placement: 'bottom',
    offset: 4,
    enabled: active,
  });

  // Build filtered DM items
  const dmItems = useMemo((): DmItem[] => {
    const q = query.toLowerCase().trim();
    return dmChannels
      .map((dm): DmItem | null => {
        const otherMembers = dm.members.filter(m => !isSelf(m, user));
        if (otherMembers.length === 0) return null;
        const isGroup = !!dm.ownerId;
        const displayName = isGroup
          ? otherMembers.map(m => m.displayName ?? parseFederatedUsername(m.username).baseName).join(', ')
          : otherMembers[0]?.displayName ?? otherMembers[0]?.username ?? '';
        return { type: 'dm', dm, displayName, otherMembers, isGroup };
      })
      .filter((item): item is DmItem => {
        if (!item) return false;
        if (!q) return true;
        // Match against display name or any member username
        if (item.displayName.toLowerCase().includes(q)) return true;
        return item.otherMembers.some(m =>
          m.username.toLowerCase().includes(q) ||
          (m.displayName?.toLowerCase().includes(q) ?? false)
        );
      })
      .slice(0, MAX_RECENT);
  }, [dmChannels, query, user]);

  // De-duplicate user results against shown 1-on-1 DMs
  const filteredUserResults = useMemo((): UserItem[] => {
    const dmUserIds = new Set<string>();
    for (const item of dmItems) {
      if (!item.isGroup && item.otherMembers.length === 1) {
        const m = item.otherMembers[0]!;
        dmUserIds.add(m.homeUserId ?? m.id);
      }
    }
    return userResults
      .filter(u => {
        if (isSelf(u, user)) return false;
        const homeId = u.homeUserId ?? u.id;
        return !dmUserIds.has(homeId);
      })
      .map(u => ({ type: 'user' as const, user: u }));
  }, [userResults, dmItems, user]);

  // Flat unified list
  const allItems = useMemo((): ResultItem[] => {
    return [...dmItems, ...filteredUserResults];
  }, [dmItems, filteredUserResults]);

  // Clamp selectedIndex when items change
  useEffect(() => {
    setSelectedIndex(prev => Math.min(prev, Math.max(0, allItems.length - 1)));
  }, [allItems.length]);

  // Scroll selected item into view
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // Debounced user search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setUserResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    searchTimer.current = setTimeout(async () => {
      try {
        const users = await api.social.search(trimmed);
        setUserResults(users);
      } catch {
        setUserResults([]);
      } finally {
        setIsSearching(false);
      }
    }, SEARCH_DEBOUNCE);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query]);

  // Click outside handler
  useEffect(() => {
    if (!active) return;
    const handleClick = (e: MouseEvent) => {
      const anchor = anchorRef.current;
      const floating = floatingRef.current;
      if (anchor?.contains(e.target as Node)) return;
      if (floating?.contains(e.target as Node)) return;
      close();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [active]);

  const open = useCallback(() => {
    setActive(true);
    setQuery('');
    setUserResults([]);
    setError('');
    setSelectedIndex(0);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const close = useCallback(() => {
    setActive(false);
    setQuery('');
    setUserResults([]);
    setError('');
  }, []);

  const selectItem = useCallback(async (item: ResultItem) => {
    setError('');
    if (item.type === 'dm') {
      close();
      useUIStore.getState().setShowDms(true);
      navigate(`/channels/@me/${item.dm.id}`);
    } else {
      try {
        const existing = useSpaceStore.getState().findExistingDmForUser(item.user);
        if (existing) {
          close();
          useUIStore.getState().setShowDms(true);
          navigate(`/channels/@me/${existing.dm.id}`);
          return;
        }
        const origin = resolveUserOrigin(item.user);
        const dmApi = getApiForOrigin(origin);
        const channel = await dmApi.dm.create({ userId: item.user.id });
        addDmChannel(channel, origin);
        close();
        useUIStore.getState().setShowDms(true);
        navigate(`/channels/@me/${channel.id}`);
      } catch (err) {
        setError((err as Error).message || 'Failed to create DM');
      }
    }
  }, [close, navigate, addDmChannel]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => Math.min(prev + 1, allItems.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => Math.max(prev - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const item = allItems[selectedIndex];
      if (item) selectItem(item);
    }
  }, [close, allItems, selectedIndex, selectItem]);

  // Compute dropdown width to match anchor
  const [dropdownWidth, setDropdownWidth] = useState(0);
  useEffect(() => {
    if (!active || !anchorRef.current) return;
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setDropdownWidth(rect.width);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(anchorRef.current);
    return () => ro.disconnect();
  }, [active]);

  const showSections = allItems.length > 0 || isSearching || (query.trim().length >= 2 && !isSearching);

  const dropdown = active ? createPortal(
    <div
      ref={floatingRef}
      style={{ ...style, width: dropdownWidth > 0 ? dropdownWidth : undefined }}
      className="animate-fade-in"
    >
      <div className="glass rounded-lg shadow-xl max-h-[360px] overflow-y-auto scrollbar-thin py-1">
        {error && (
          <div className="px-3 py-2 text-txt-danger text-[13px]">{error}</div>
        )}

        {allItems.length === 0 && !isSearching && query.trim().length === 0 && dmItems.length === 0 && (
          <div className="px-3 py-4 text-center text-txt-tertiary text-[13px]">
            Search for a user to start chatting
          </div>
        )}

        {/* DM conversations section */}
        {dmItems.length > 0 && (
          <>
            {query.trim().length >= 2 && (
              <div className="px-3 pt-1.5 pb-1 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
                Conversations
              </div>
            )}
            {dmItems.map((item, i) => {
              const globalIndex = i;
              const isSelected = globalIndex === selectedIndex;
              return (
                <div
                  key={item.dm.id}
                  ref={isSelected ? selectedRef : undefined}
                  onClick={() => selectItem(item)}
                  className={`flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded cursor-pointer transition-colors ${
                    isSelected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
                  }`}
                >
                  {item.isGroup ? (
                    <div className="relative w-6 h-6 flex-shrink-0">
                      {item.otherMembers.slice(0, 2).map((m, idx) => (
                        <div
                          key={m.id}
                          className="absolute rounded-full overflow-hidden border-[1.5px] border-surface-channel"
                          style={{
                            width: 18, height: 18,
                            left: idx * 8,
                            top: idx * 4,
                            zIndex: 2 - idx,
                          }}
                        >
                          <Avatar src={m.avatar} name={m.displayName ?? parseFederatedUsername(m.username).baseName} size={18} userId={m.homeUserId ?? m.id} user={m} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Avatar
                      src={item.otherMembers[0]?.avatar}
                      name={item.otherMembers[0]?.displayName ?? parseFederatedUsername(item.otherMembers[0]?.username ?? '').baseName}
                      size={24}
                      status={item.otherMembers[0]?.status as 'online' | 'idle' | 'dnd' | 'offline' | undefined}
                      userId={item.otherMembers[0]?.homeUserId ?? item.otherMembers[0]?.id}
                      user={item.otherMembers[0]}
                    />
                  )}
                  <span className="text-[14px] text-txt-primary truncate">{item.displayName}</span>
                </div>
              );
            })}
          </>
        )}

        {/* Users section */}
        {(filteredUserResults.length > 0 || (isSearching && query.trim().length >= 2)) && (
          <>
            <div className="px-3 pt-1.5 pb-1 text-[11px] font-bold text-txt-tertiary uppercase tracking-wider">
              Users
            </div>
            {isSearching && filteredUserResults.length === 0 && (
              <div className="px-3 py-2 text-center text-txt-tertiary text-[13px]">Searching...</div>
            )}
            {filteredUserResults.map((item, i) => {
              const globalIndex = dmItems.length + i;
              const isSelected = globalIndex === selectedIndex;
              return (
                <div
                  key={item.user.id}
                  ref={isSelected ? selectedRef : undefined}
                  onClick={() => selectItem(item)}
                  className={`flex items-center gap-2.5 px-2 py-1.5 mx-1 rounded cursor-pointer transition-colors ${
                    isSelected ? 'bg-interactive-selected' : 'hover:bg-interactive-hover'
                  }`}
                >
                  <Avatar
                    src={item.user.avatar}
                    name={item.user.displayName ?? item.user.username}
                    size={24}
                    status={item.user.status as 'online' | 'idle' | 'dnd' | 'offline' | undefined}
                    userId={item.user.homeUserId ?? item.user.id}
                  />
                  <div className="flex-1 min-w-0 flex items-center gap-1.5">
                    <span className="text-[14px] text-txt-primary truncate">
                      {item.user.displayName ?? item.user.username}
                    </span>
                    {item.user.displayName && (
                      <span className="text-[12px] text-txt-tertiary truncate">
                        @{item.user.username}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </>
        )}

        {/* No results */}
        {!isSearching && query.trim().length >= 2 && allItems.length === 0 && (
          <div className="px-3 py-4 text-center text-txt-tertiary text-[13px]">No results found</div>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <div ref={anchorRef} className="flex-1 min-w-0">
      {active ? (
        <div className="flex-1 min-h-8 bg-surface-input rounded-[4px] flex items-center px-2 gap-1.5 border border-white/[0.06] shadow-input">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0016 9.5 6.5 6.5 0 109.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            placeholder="Search..."
            className="input-embedded flex-1 min-w-0 text-[13px] font-medium py-[5px]"
          />
        </div>
      ) : (
        <button
          onClick={open}
          className="w-full min-h-8 bg-surface-input text-txt-tertiary text-[13px] font-medium py-[5px] px-2 rounded-[4px] text-left border border-white/[0.06] shadow-input hover:border-white/[0.1] transition-colors"
        >
          Find or start a conversation
        </button>
      )}
      {dropdown}
    </div>
  );
}
