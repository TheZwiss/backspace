import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTrackStats, AudioTrackStat, VideoTrackStat } from '../../hooks/useTrackStats';
import { getActiveRoom } from '../../hooks/useLiveKit';
import { useFloatingPosition } from '../../hooks/useFloatingPosition';

interface ConnectionInfoPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function formatBitrate(kbps: number): string {
  if (kbps < 1000) return `${Math.round(kbps)} kbps`;
  return `${(kbps / 1000).toFixed(kbps >= 10000 ? 0 : 1)} Mbps`;
}

function pingColor(ms: number): string {
  if (ms <= 80) return 'text-status-online';
  if (ms <= 200) return 'text-status-idle';
  return 'text-txt-danger';
}

function lossColor(pct: number): string {
  if (pct <= 1) return 'text-status-online';
  if (pct <= 5) return 'text-status-idle';
  return 'text-txt-danger';
}

function jitterColor(ms: number): string {
  if (ms <= 30) return 'text-status-online';
  if (ms <= 80) return 'text-status-idle';
  return 'text-txt-danger';
}

function sourceLabel(source: string): string {
  switch (source) {
    case 'microphone': return 'Microphone';
    case 'camera': return 'Camera';
    case 'screen_share': return 'Screen';
    case 'screen_share_audio': return 'Screen Audio';
    default: return 'Unknown';
  }
}

function trackLabel(direction: 'send' | 'recv', source: string, participantName: string | null): string {
  const arrow = direction === 'send' ? '\u2191' : '\u2193';
  if (direction === 'send') {
    return `${sourceLabel(source)} ${arrow}`;
  }
  const name = participantName ?? 'Remote';
  return `${name} ${sourceLabel(source)} ${arrow}`;
}

const Row = ({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) => (
  <div className="flex items-center justify-between py-[3px]">
    <span className="text-[12px] text-txt-tertiary">{label}</span>
    <span className={`text-[12px] font-medium ${colorClass ?? 'text-txt-secondary'}`}>{value}</span>
  </div>
);

const Divider = () => <div className="border-t border-border-soft my-1" />;

const SectionHeader = ({ title }: { title: string }) => (
  <div className="text-[10px] font-bold text-txt-tertiary uppercase tracking-wider pt-1 pb-[2px]">
    {title}
  </div>
);

function AudioTrackRow({ track }: { track: AudioTrackStat }) {
  const label = trackLabel(track.direction, track.source, track.participantName);
  return (
    <div className="flex items-center justify-between py-[3px]">
      <span className="text-[12px] text-txt-tertiary truncate mr-2">{label}</span>
      <span className="text-[12px] font-medium text-txt-secondary whitespace-nowrap">
        {formatBitrate(track.bitrate)}
        {track.codec && <span className="text-txt-tertiary ml-2">{track.codec}</span>}
      </span>
    </div>
  );
}

function VideoTrackRow({ track }: { track: VideoTrackStat }) {
  const label = trackLabel(track.direction, track.source, track.participantName);
  const resolution = (track.width && track.height) ? `${track.width}\u00d7${track.height}` : null;

  return (
    <div className="py-[3px]">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-txt-tertiary truncate mr-2">{label}</span>
        <span className="text-[12px] font-medium text-txt-secondary whitespace-nowrap">
          {formatBitrate(track.bitrate)}
          {track.codec && <span className="text-txt-tertiary ml-2">{track.codec}</span>}
        </span>
      </div>
      {(resolution || track.fps !== null || track.qualityLimitation || track.simulcastLayer) && (
        <div className="flex items-center justify-between pl-3">
          <span className="text-[11px] text-txt-tertiary">
            {resolution && `${resolution}`}
            {track.fps !== null && ` @${track.fps}`}
          </span>
          <span className="text-[11px] text-txt-tertiary">
            {track.direction === 'send' && track.qualityLimitation && track.qualityLimitation !== 'none'
              ? track.qualityLimitation
              : ''}
            {track.direction === 'recv' && track.simulcastLayer
              ? track.simulcastLayer
              : ''}
          </span>
        </div>
      )}
    </div>
  );
}

export function ConnectionInfoPopover({ open, onClose, anchorRef }: ConnectionInfoPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const stats = useTrackStats(open);

  const { style } = useFloatingPosition(anchorRef, popoverRef, {
    placement: 'top',
    offset: 12,
    enabled: open,
  });

  // Click-outside to close
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

  const room = getActiveRoom();

  return createPortal(
    <div
      ref={popoverRef}
      style={style}
      className="w-[300px] glass rounded-lg overflow-hidden"
    >
      <div className="px-3 py-2 border-b border-border-hard">
        <span className="text-[14px] font-bold text-txt-primary">Connection Info</span>
      </div>

      <div className="px-3 py-2 max-h-[calc(100vh-32px)] overflow-y-auto scrollbar-thin">
        {!room ? (
          <div className="text-[12px] text-txt-tertiary py-2 text-center">Not connected</div>
        ) : !stats ? (
          <div className="text-[12px] text-txt-tertiary py-2 text-center">Gathering stats...</div>
        ) : (
          <>
            {/* Network */}
            <SectionHeader title="Network" />
            <Row
              label="Ping"
              value={stats.network.ping !== null ? `${stats.network.ping} ms` : '\u2014'}
              colorClass={stats.network.ping !== null ? pingColor(stats.network.ping) : undefined}
            />
            <Row
              label="Packet Loss"
              value={stats.network.packetLoss !== null ? `${stats.network.packetLoss.toFixed(1)}%` : '\u2014'}
              colorClass={stats.network.packetLoss !== null ? lossColor(stats.network.packetLoss) : undefined}
            />
            <Row
              label="Jitter"
              value={stats.network.jitter !== null ? `${stats.network.jitter} ms` : '\u2014'}
              colorClass={stats.network.jitter !== null ? jitterColor(stats.network.jitter) : undefined}
            />
            <Row label="Server" value={stats.network.serverAddress ?? '\u2014'} />
            <Row
              label="Protocol"
              value={
                stats.network.protocol
                  ? `${stats.network.protocol}${stats.network.candidateType ? ` (${stats.network.candidateType})` : ''}`
                  : '\u2014'
              }
            />

            {/* Audio Tracks */}
            {stats.audioTracks.length > 0 && (
              <>
                <Divider />
                <SectionHeader title="Audio" />
                {stats.audioTracks.map((t) => (
                  <AudioTrackRow key={t.key} track={t} />
                ))}
              </>
            )}

            {/* Video Tracks */}
            {stats.videoTracks.length > 0 && (
              <>
                <Divider />
                <SectionHeader title="Video" />
                {stats.videoTracks.map((t) => (
                  <VideoTrackRow key={t.key} track={t} />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
