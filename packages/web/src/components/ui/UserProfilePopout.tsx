import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';
import { getAvatarGradient } from '../../utils/gradients';

interface UserProfilePopoutProps {
  user: User;
  onClose: () => void;
  position?: { top: number; left: number };
}

export function UserProfilePopout({ user, onClose, position }: UserProfilePopoutProps) {
  const navigate = useNavigate();
  const addDmChannel = useServerStore((s) => s.addDmChannel);
  const displayName = user.displayName ?? user.username;

  const top = position
    ? Math.min(Math.max(8, position.top), window.innerHeight - 360)
    : undefined;
  const left = position
    ? Math.min(Math.max(8, position.left), window.innerWidth - 316)
    : undefined;

  const handleSendMessage = async () => {
    try {
      const channel = await api.dm.create({ userId: user.id });
      addDmChannel(channel);
      useUIStore.getState().setShowDms(true);
      onClose();
      navigate(`/channels/@me/${channel.id}`);
    } catch (err) {
      console.error('Failed to create DM channel:', err);
    }
  };

  return (
    <div
      className="fixed z-[200] w-[300px] rounded-[12px] overflow-hidden animate-fade-in select-none border border-white/[0.07]"
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
        className="h-[48px] rounded-t-[12px]"
        style={{
          background: getAvatarGradient(user.id, displayName).gradient,
          opacity: 0.6,
        }}
      />

      {/* Body */}
      <div className="px-4 pb-4">
        {/* Avatar — negative margin pulls it into the banner while staying in flow */}
        <div
          className="mt-[-28px] mb-3 w-fit rounded-full"
          style={{ border: '4px solid rgba(20,20,26,0.85)' }}
        >
          <Avatar
            src={user.avatar}
            name={displayName}
            size={56}
            status={user.status as 'online' | 'idle' | 'dnd' | 'offline' | null}
            userId={user.id}
          />
        </div>

        {/* Name & info — flows naturally after avatar */}
        <div>
          <div className="text-[16px] font-semibold text-txt-primary leading-tight">
            {displayName}
          </div>
          <div className="text-[13px] text-txt-tertiary">
            @{user.username}
          </div>
          {user.customStatus && (
            <div className="text-[13px] text-txt-secondary italic mt-1">
              {user.customStatus}
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="border-t border-white/[0.06] my-3" />

        {/* Member since */}
        <div>
          <span className="text-[11px] uppercase tracking-wide font-semibold text-txt-tertiary">
            Member Since
          </span>
          <span className="text-[12px] text-txt-secondary ml-2">
            {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </div>

        {/* Send Message button */}
        <button
          onClick={handleSendMessage}
          className="w-full mt-3 py-2 rounded-lg text-[13px] font-medium text-txt-primary bg-white/[0.06] hover:bg-white/[0.10] border border-white/[0.08] transition-colors"
        >
          Send Message
        </button>
      </div>
    </div>
  );
}
