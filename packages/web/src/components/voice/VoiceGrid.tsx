import React from 'react';
import { VoiceUser } from './VoiceUser';
import { useVoiceStore } from '../../stores/voiceStore';
import type { ParticipantInfo } from '../../hooks/useLiveKit';

interface VoiceGridProps {
  participants: ParticipantInfo[];
}

export function VoiceGrid({ participants }: VoiceGridProps) {
  const focusedParticipantId = useVoiceStore((s) => s.focusedParticipantId);
  const setFocusedParticipant = useVoiceStore((s) => s.setFocusedParticipant);

  if (participants.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-discord-text-muted">
        <p>No one is in this voice channel</p>
      </div>
    );
  }

  const focusedParticipant = focusedParticipantId
    ? participants.find(p => p.identity === focusedParticipantId)
    : null;

  // Focus mode: one large tile + sidebar strip
  if (focusedParticipant) {
    const otherParticipants = participants.filter(p => p.identity !== focusedParticipantId);
    return (
      <div className="flex-1 flex overflow-hidden">
        {/* Main focused view */}
        <div
          className="flex-1 p-2"
          onDoubleClick={() => setFocusedParticipant(null)}
        >
          <VoiceUser participant={focusedParticipant} large />
        </div>

        {/* Side strip of other participants */}
        {otherParticipants.length > 0 && (
          <div className="w-[200px] flex-shrink-0 overflow-y-auto p-2 space-y-2">
            {otherParticipants.map((p) => (
              <div
                key={p.identity}
                onClick={() => setFocusedParticipant(p.identity)}
                className="cursor-pointer"
              >
                <VoiceUser participant={p} />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Default grid mode
  const gridClass = (() => {
    if (participants.length === 1) return 'grid-cols-1 max-w-2xl mx-auto';
    if (participants.length === 2) return 'grid-cols-2 max-w-4xl mx-auto';
    if (participants.length <= 4) return 'grid-cols-2';
    if (participants.length <= 9) return 'grid-cols-3';
    return 'grid-cols-4';
  })();

  return (
    <div className="flex-1 p-4 overflow-auto">
      <div className={`grid ${gridClass} gap-2 h-full`}>
        {participants.map((p) => (
          <div
            key={p.identity}
            onClick={() => setFocusedParticipant(p.identity)}
            className="cursor-pointer"
          >
            <VoiceUser participant={p} />
          </div>
        ))}
      </div>
    </div>
  );
}
