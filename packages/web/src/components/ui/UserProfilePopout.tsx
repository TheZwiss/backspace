import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { User } from '@backspace/shared';
import { Avatar } from '../ui/Avatar';
import { api } from '../../api/client';
import { useServerStore } from '../../stores/serverStore';
import { useUIStore } from '../../stores/uiStore';

interface UserProfilePopoutProps {
  user: User;
  onClose: () => void;
  position?: { top: number; left: number };
}

export function UserProfilePopout({ user, onClose, position }: UserProfilePopoutProps) {
  const navigate = useNavigate();
  const addDmChannel = useServerStore((s) => s.addDmChannel);
  const displayName = user.displayName ?? user.username;

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
      className="fixed z-50 w-[300px] bg-discord-bg-floating rounded-[8px] shadow-elevation-high overflow-hidden animate-fade-in select-none"
      style={position ? { top: position.top, left: position.left } : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}
    >
      {/* Banner */}
      <div className="h-[60px] bg-discord-blurple" />
      
      {/* Avatar Container */}
      <div className="px-4 pb-4 relative">
        <div className="absolute -top-8 left-4 rounded-full border-[6px] border-discord-bg-floating bg-discord-bg-floating">
          <Avatar 
            src={user.avatar} 
            name={displayName} 
            size={80} 
            status={user.status as any} 
          />
        </div>
        
        {/* Content */}
        <div className="mt-12 bg-discord-bg-tertiary rounded-[8px] p-3">
          <div className="text-[20px] font-bold text-discord-text-header leading-tight mb-1">
            {displayName}
          </div>
          <div className="text-[14px] text-discord-text-normal font-medium mb-3">
            @{user.username}
          </div>
          
          <div className="w-full h-[1px] bg-discord-modifier-accent mb-3" />
          
          <div className="mb-3">
            <div className="text-[12px] font-bold text-discord-text-header uppercase mb-1">Backspace Member Since</div>
            <div className="text-[12px] text-discord-text-normal font-medium">
              {new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </div>
          </div>

          {user.customStatus && (
            <div className="mb-3">
              <div className="text-[12px] font-bold text-discord-text-header uppercase mb-1">Status</div>
              <div className="text-[14px] text-discord-text-normal">{user.customStatus}</div>
            </div>
          )}
        </div>
      </div>
      
      {/* Footer / Actions */}
      <div className="px-4 pb-4">
        <button 
          onClick={handleSendMessage}
          className="w-full py-2 bg-discord-blurple hover:bg-discord-blurple-hover text-white text-[14px] font-medium rounded-[4px] transition-colors"
        >
          Send Message
        </button>
      </div>
    </div>
  );
}
