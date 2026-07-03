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
    <div className="absolute bottom-full left-1 md:left-4 mb-1 px-3 flex items-center text-[12px] text-txt-secondary font-medium select-none pointer-events-none animate-typing-in motion-reduce:animate-none">
      <div className="flex items-center gap-2">
        <div className="flex gap-[2px] bg-surface-elevated/20 rounded-full px-2 py-1">
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '0ms', animationDuration: '0.8s' }} />
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '150ms', animationDuration: '0.8s' }} />
          <div className="w-[5px] h-[5px] bg-txt-message rounded-full animate-bounce" style={{ animationDelay: '300ms', animationDuration: '0.8s' }} />
        </div>
        <span className="truncate max-w-[400px]">
          <span className="font-bold">{text}</span>
        </span>
      </div>
    </div>
  );
}
