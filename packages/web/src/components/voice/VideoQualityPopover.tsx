import React, { useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { VideoPresets, VideoPreset } from 'livekit-client';

interface VideoQualityPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRect?: DOMRect | null;
}

const PRESETS = [
  { value: 'auto' as const, label: 'Auto', desc: 'Adjusts to your connection' },
  { value: '1080p60' as const, label: '1080p 60fps', desc: '1920x1080, 15000 kbps' },
  { value: '1080p' as const, label: '1080p 30fps', desc: '1920x1080, 8000 kbps' },
  { value: '720p60' as const, label: '720p 60fps', desc: '1280x720, 8000 kbps' },
  { value: '720p' as const, label: '720p 30fps', desc: '1280x720, 5000 kbps' },
  { value: '540p' as const, label: '540p 30fps', desc: '960x540, 2000 kbps' },
  { value: '360p' as const, label: '360p 30fps', desc: '640x360, 1000 kbps' },
] as const;

const QUALITY_MAP: Record<string, VideoPreset> = {
  '1080p60': new VideoPreset(1920, 1080, 15_000_000, 60),
  '1080p': new VideoPreset(1920, 1080, 8_000_000, 30),
  '720p60': new VideoPreset(1280, 720, 8_000_000, 60),
  '720p': new VideoPreset(1280, 720, 5_000_000, 30),
  '540p': new VideoPreset(960, 540, 2_000_000, 30),
  '360p': new VideoPreset(640, 360, 1_000_000, 30),
};

export function VideoQualityPopover({ open, onClose, anchorRect }: VideoQualityPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const videoQuality = useVoiceStore((s) => s.videoQuality);
  const setVideoQuality = useVoiceStore((s) => s.setVideoQuality);
  const isCameraOn = useVoiceStore((s) => s.isCameraOn);

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

  if (!open) return null;

  const handleSelect = async (quality: typeof videoQuality) => {
    setVideoQuality(quality);
    onClose();
  };

  return (
    <div
      ref={popoverRef}
      className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-[240px] bg-[#2b2d31] rounded-lg shadow-lg border border-[#1e1f22] z-50 overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-[#1e1f22]">
        <span className="text-[14px] font-bold text-discord-text-primary">Video Quality</span>
      </div>
      <div className="py-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            onClick={() => handleSelect(preset.value)}
            className={`w-full px-3 py-2 flex items-center justify-between hover:bg-discord-modifier-hover transition-colors ${
              videoQuality === preset.value ? 'text-discord-text-primary' : 'text-discord-text-secondary'
            }`}
          >
            <div className="text-left">
              <div className="text-[14px] font-medium">{preset.label}</div>
              <div className="text-[12px] text-discord-text-muted">{preset.desc}</div>
            </div>
            {videoQuality === preset.value && (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" className="text-discord-blurple flex-shrink-0 ml-2">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
              </svg>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
