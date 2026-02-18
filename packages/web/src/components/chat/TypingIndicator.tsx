import React, { useMemo } from 'react';
import { useChatStore } from '../../stores/chatStore';
import { useAuthStore } from '../../stores/authStore';

interface TypingIndicatorProps {
  channelId: string;
}

export function TypingIndicator({ channelId }: TypingIndicatorProps) {
  const typingUsersRaw = useChatStore((s) => s.typingUsers.get(channelId));
  const currentUserId = useAuthStore((s) => s.user?.id);

  // Filter out current user and expired entries
  const others = useMemo(() => {
    if (!typingUsersRaw || typingUsersRaw.length === 0) return [];
    const now = Date.now();
    return typingUsersRaw
      .filter(t => now - t.timestamp < 5000 && t.userId !== currentUserId);
  }, [typingUsersRaw, currentUserId]);

  if (others.length === 0) return null;

  let text = '';
  if (others.length === 1) {
    text = `${others[0]!.username} is typing`;
  } else if (others.length === 2) {
    text = `${others[0]!.username} and ${others[1]!.username} are typing`;
  } else {
    text = 'Several people are typing';
  }

  return (
    <div className="h-6 px-4 flex items-center text-xs text-discord-text-muted">
      <div className="flex items-center gap-1">
        <span className="flex gap-0.5">
          <span className="w-1 h-1 bg-discord-text-muted rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
          <span className="w-1 h-1 bg-discord-text-muted rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
          <span className="w-1 h-1 bg-discord-text-muted rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
        </span>
        <span className="font-medium">{text}</span>
        <span>...</span>
      </div>
    </div>
  );
}
