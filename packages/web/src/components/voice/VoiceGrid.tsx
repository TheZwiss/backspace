import React from 'react';
import { VoiceUser } from './VoiceUser';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

interface VoiceGridProps {
  participants: ParticipantInfo[];
}

export function VoiceGrid({ participants }: VoiceGridProps) {
  if (participants.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-discord-text-muted">
        <p>No one is in this voice channel</p>
      </div>
    );
  }

  const gridClass = (() => {
    if (participants.length === 1) return 'grid-cols-1 max-w-2xl mx-auto';
    if (participants.length === 2) return 'grid-cols-2 max-w-4xl mx-auto';
    if (participants.length <= 4) return 'grid-cols-2';
    return 'grid-cols-3';
  })();

  return (
    <div className="flex-1 p-4 overflow-auto">
      <div className={`grid ${gridClass} gap-2 h-full`}>
        {participants.map((p) => (
          <VoiceUser key={p.identity} participant={p} />
        ))}
      </div>
    </div>
  );
}
