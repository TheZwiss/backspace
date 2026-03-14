import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';
import { isDmChannel, getChannelOrigin, getApiForOrigin } from '../../stores/spaceStore';
import { Avatar } from '../ui/Avatar';
import type { MessageWithUser, DmMessageWithUser } from '@backspace/shared';

type AnyMessage = MessageWithUser | DmMessageWithUser;

interface SearchPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  channelId: string;
  isDm: boolean;
  onJumpToMessage: (messageId: string) => void;
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = date.toDateString() === yesterday.toDateString();
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Today at ${time}`;
  if (isYesterday) return `Yesterday at ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim() || !text) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-accent-primary/30 text-txt-primary rounded-sm px-0.5">{part}</mark>
      : part
  );
}

export function SearchPopover({ open, onClose, anchorRef, channelId, isDm, onJumpToMessage }: SearchPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'bottom',
    offset: 8,
    enabled: open,
  });

  const [query, setQuery] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [hasFilter, setHasFilter] = useState('');
  const [beforeFilter, setBeforeFilter] = useState('');
  const [afterFilter, setAfterFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [results, setResults] = useState<AnyMessage[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [offset, setOffset] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Reset state when channel changes or popover opens
  useEffect(() => {
    if (open) {
      setQuery('');
      setFromFilter('');
      setHasFilter('');
      setBeforeFilter('');
      setAfterFilter('');
      setResults([]);
      setTotalCount(0);
      setOffset(0);
      setShowFilters(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open, channelId]);

  // Click-outside handler
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  // Escape handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const doSearch = useCallback(async (searchOffset = 0) => {
    const trimmed = query.trim();
    if (!trimmed && !fromFilter && !hasFilter && !beforeFilter && !afterFilter) {
      setResults([]);
      setTotalCount(0);
      return;
    }

    setIsSearching(true);
    try {
      const origin = getChannelOrigin(channelId);
      const client = getApiForOrigin(origin);
      const params = {
        q: trimmed || undefined,
        from: fromFilter || undefined,
        has: hasFilter || undefined,
        before: beforeFilter || undefined,
        after: afterFilter || undefined,
        offset: searchOffset,
        limit: 25,
      };

      const data = isDm
        ? await client.search.dm(channelId, params)
        : await client.search.channel(channelId, params);

      if (searchOffset === 0) {
        setResults(data.results as AnyMessage[]);
      } else {
        setResults(prev => [...prev, ...(data.results as AnyMessage[])]);
      }
      setTotalCount(data.totalCount);
      setOffset(searchOffset + data.results.length);
    } catch (err) {
      console.error('Search failed:', err);
    } finally {
      setIsSearching(false);
    }
  }, [query, fromFilter, hasFilter, beforeFilter, afterFilter, channelId, isDm]);

  // Debounced search on query/filter change
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      doSearch(0);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [doSearch]);

  const handleLoadMore = () => {
    doSearch(offset);
  };

  if (!open) return null;

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="w-[420px] max-h-[500px] glass rounded-lg shadow-xl flex flex-col animate-fade-in"
    >
      {/* Search input */}
      <div className="p-3 border-b border-white/[0.07]">
        <div className="flex items-center gap-2 bg-surface-input rounded-lg px-3 py-2 border border-white/[0.06] shadow-input">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary flex-shrink-0">
            <path d="M21.707 20.293l-5.395-5.395A7.457 7.457 0 0018 10.5 7.5 7.5 0 1010.5 18c1.575 0 3.027-.486 4.228-1.31l5.476 5.476a.997.997 0 001.414 0l.089-.089a1 1 0 000-1.414l.001-.37zM10.5 16a5.5 5.5 0 110-11 5.5 5.5 0 010 11z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search messages..."
            className="input-embedded flex-1 text-[14px]"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-txt-tertiary hover:text-txt-primary transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
              </svg>
            </button>
          )}
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters(!showFilters)}
          className="mt-2 text-[12px] text-txt-tertiary hover:text-txt-secondary transition-colors flex items-center gap-1"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" className={`transition-transform ${showFilters ? 'rotate-90' : ''}`}>
            <path d="M10 17l5-5-5-5v10z" />
          </svg>
          Filters
          {(fromFilter || hasFilter || beforeFilter || afterFilter) && (
            <span className="w-1.5 h-1.5 rounded-full bg-accent-primary" />
          )}
        </button>

        {/* Filters row */}
        {showFilters && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-txt-tertiary font-medium mb-1 block">From</label>
              <input
                type="text"
                value={fromFilter}
                onChange={(e) => setFromFilter(e.target.value)}
                placeholder="username"
                className="input-search w-full px-2 py-1 text-[13px]"
              />
            </div>
            <div>
              <label className="text-[11px] text-txt-tertiary font-medium mb-1 block">Has</label>
              <select
                value={hasFilter}
                onChange={(e) => setHasFilter(e.target.value)}
                className="input-search w-full px-2 py-1 text-[13px] appearance-none cursor-pointer"
              >
                <option value="">Any</option>
                <option value="file">File</option>
                <option value="image">Image</option>
                <option value="link">Link</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] text-txt-tertiary font-medium mb-1 block">Before</label>
              <input
                type="date"
                value={beforeFilter}
                onChange={(e) => setBeforeFilter(e.target.value)}
                className="input-search w-full px-2 py-1 text-[13px]"
              />
            </div>
            <div>
              <label className="text-[11px] text-txt-tertiary font-medium mb-1 block">After</label>
              <input
                type="date"
                value={afterFilter}
                onChange={(e) => setAfterFilter(e.target.value)}
                className="input-search w-full px-2 py-1 text-[13px]"
              />
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden min-h-0">
        {isSearching && results.length === 0 && (
          <div className="flex items-center justify-center py-8">
            <div className="w-5 h-5 border-2 border-txt-tertiary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!isSearching && results.length === 0 && (query || fromFilter || hasFilter || beforeFilter || afterFilter) && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" className="text-txt-tertiary/50 mb-2">
              <path d="M21.707 20.293l-5.395-5.395A7.457 7.457 0 0018 10.5 7.5 7.5 0 1010.5 18c1.575 0 3.027-.486 4.228-1.31l5.476 5.476a.997.997 0 001.414 0l.089-.089a1 1 0 000-1.414l.001-.37zM10.5 16a5.5 5.5 0 110-11 5.5 5.5 0 010 11z" />
            </svg>
            <span className="text-txt-tertiary text-[13px]">No results found</span>
          </div>
        )}

        {!query && !fromFilter && !hasFilter && !beforeFilter && !afterFilter && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 px-4 text-center">
            <span className="text-txt-tertiary text-[13px]">Type to search messages in this channel</span>
          </div>
        )}

        {results.length > 0 && (
          <>
            <div className="px-3 py-2 text-[11px] text-txt-tertiary font-medium">
              {totalCount} result{totalCount !== 1 ? 's' : ''}
            </div>
            {results.map((msg) => (
              <button
                key={msg.id}
                onClick={() => onJumpToMessage(msg.id)}
                className="w-full px-3 py-2.5 hover:bg-interactive-hover transition-colors text-left flex items-start gap-2.5 group/result"
              >
                <div className="flex-shrink-0 mt-0.5">
                  <Avatar
                    src={msg.user?.avatar}
                    name={msg.user?.displayName ?? msg.user?.username ?? '?'}
                    size={28}
                    user={msg.user ?? undefined}
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[13px] font-semibold text-txt-primary truncate">
                      {msg.user?.displayName ?? msg.user?.username ?? 'Unknown'}
                    </span>
                    <span className="text-[10px] text-txt-tertiary flex-shrink-0">
                      {formatTime(msg.createdAt)}
                    </span>
                  </div>
                  <div className="text-[13px] text-txt-secondary leading-[1.4] line-clamp-2 mt-0.5">
                    {highlightMatch(msg.content ?? '', query)}
                  </div>
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div className="flex items-center gap-1 mt-1 text-[11px] text-txt-tertiary">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M16.5 6v11.5c0 2.21-1.79 4-4 4s-4-1.79-4-4V5c0-1.38 1.12-2.5 2.5-2.5s2.5 1.12 2.5 2.5v10.5c0 .55-.45 1-1 1s-1-.45-1-1V6H9v9.5c0 1.38 1.12 2.5 2.5 2.5s2.5-1.12 2.5-2.5V5c0-2.21-1.79-4-4-4S6 2.79 6 5v12.5c0 3.04 2.46 5.5 5.5 5.5s5.5-2.46 5.5-5.5V6h-1.5z" />
                      </svg>
                      {msg.attachments.length} attachment{msg.attachments.length !== 1 ? 's' : ''}
                    </div>
                  )}
                </div>
              </button>
            ))}
            {results.length < totalCount && (
              <div className="px-3 py-2 border-t border-white/[0.07]">
                <button
                  onClick={handleLoadMore}
                  disabled={isSearching}
                  className="w-full py-1.5 text-[13px] text-accent-primary hover:text-accent-primary-hover transition-colors font-medium disabled:opacity-50"
                >
                  {isSearching ? 'Loading...' : `Load more (${totalCount - results.length} remaining)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
